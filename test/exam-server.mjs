// ============================================================================
// 对练模式 · HTTP + SSE 本地测试
//
//   node test/exam-server.mjs
//
// 起一个真的 node:http 服务，把 lib/exam/routes.mjs 挂上去，用 fetch 跑一遍：
//   suggest → start → SSE 收题 → answer → 收评分 → … → report → done
// 模型是假的（不联网），所以断言的是**事件顺序与协议**，不是自然语言内容。
//
// 这个测试的价值：SSE 的断流、事件去重、轮询推进这些坑，单靠引擎测试发现不了。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../lib/store.mjs';
import { createIndex } from '../lib/index.mjs';
import { renderDocument, chunkDocument } from '../lib/chunker.mjs';
import { createExam } from '../lib/exam/engine.mjs';
import { createExamRoutes } from '../lib/exam/routes.mjs';
import { API_BASE } from '../lib/util.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
	if (ok) { passed += 1; console.log(`  ok   ${name}`); }
	else { failed += 1; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

// ── 临时库 ────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-exam-srv-'));
const store = openStore({ root, logger: { info() {}, warn() {}, error() {} } });
const index = createIndex({ store, embedder: { enabled: false } });
const now = Date.now();
const kbId = 'kb_srv';
store.createKb({ id: kbId, name: 'SSE 测试库', now });

function addDoc({ id, name, ext, blocks }) {
	store.createNode({ id, kbId, parentId: null, kind: 'doc', name, ext, now, status: 'ready' });
	const { text, lines } = renderDocument(blocks);
	store.saveText(id, text, now);
	index.insertChunks({ nodeId: id, kbId, chunks: chunkDocument(lines) });
}
addDoc({
	id: 'd_a', name: '示例-病害A.pptx', ext: 'pptx',
	blocks: [
		{ kind: 'heading', level: 1, text: '病害 A' }, { kind: 'page', page: 1 },
		{ kind: 'text', text: '症状：叶片出现梭形病斑，中央灰白。' },
		{ kind: 'text', text: '防治：发病初期用苯醚甲环唑，间隔 7~10 天，安全间隔期 21 天。' },
	],
});
addDoc({
	id: 'd_b', name: '示例-病害B.docx', ext: 'docx',
	blocks: [
		{ kind: 'heading', level: 1, text: '病害 B' }, { kind: 'page', page: 1 },
		{ kind: 'text', text: '症状：果穗变黑粉包，病株矮化。' },
		{ kind: 'text', text: '防治：以种子处理为主，用戊唑醇拌种，重病田轮作 3 年。' },
	],
});

// ── 假模型 ────────────────────────────────────────────────────────────
let questionNo = 0;
const grades = [
	{ score: 2, verdict: 'full', missing: [], comment: '抓住了梭形病斑。', followup: '那安全间隔期是多少？' },
	{ score: 1, verdict: 'partial', missing: ['安全间隔期 21 天'], comment: '药剂对，缺间隔期。', followup: '' },
	{ score: 0, verdict: 'wrong', missing: ['以种子处理为主'], comment: '把两种病害搞混了。', followup: '' },
];
async function fakeChat({ purpose }) {
	if (purpose === 'objectives') {
		return JSON.stringify({ objectives: [{ text: '能区分病害 A 与 B 并给出防治', why: '两篇文档覆盖', coverage: 'high' }] });
	}
	if (purpose === 'outline') {
		return JSON.stringify({
			kp: [
				{ id: 'kp1', title: '病害 A 辨识', docIds: ['d_a'], reason: '文档 A' },
				{ id: 'kp2', title: '病害 B 防治', docIds: ['d_b'], reason: '文档 B' },
			],
			plan: [{ kpId: 'kp1', turns: 1, difficulty: 'apply' }, { kpId: 'kp2', turns: 1, difficulty: 'recall' }],
		});
	}
	if (purpose === 'question') {
		questionNo += 1;
		return JSON.stringify({ question: `第 ${questionNo} 题：说一下关键点。`, expectedPoints: ['要点一'], difficulty: 'apply', refs: ['1'] });
	}
	if (purpose === 'grade') return JSON.stringify(grades[Math.min(questionNo - 1, grades.length - 1)]);
	throw new Error(`未知 purpose ${purpose}`);
}

const exam = createExam({ store, index, chat: fakeChat, logger: { warn() {}, error() {} } });

// ── 把路由挂到一个真 http 服务上 ──────────────────────────────────────
const { routes } = createExamRoutes({
	exam,
	origin: () => '',
	logger: { warn() {} },
	// 自检用假的：真实现依赖宿主 llm，测试里只验协议
	diag: async () => ({ ready: true, picked: { provider: 'test', model: 'demo-model' }, models: [], providers: ['test'] }),
});
const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? '/', 'http://local');
	const route = routes.find((item) => item.kind === 'exact' && item.path === url.pathname);
	if (!route) { res.writeHead(404); res.end('not found'); return; }
	Promise.resolve(route.handler(req, res)).catch((error) => {
		if (!res.headersSent) { res.writeHead(500); res.end(String(error?.message ?? error)); }
	});
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}${API_BASE}`;
const headers = { 'content-type': 'application/json', 'x-kb-client': '1' };
const post = (pathname, body) => fetch(`${base}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });

// ── SSE 解析 ──────────────────────────────────────────────────────────
async function* readEvents(response) {
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let index2;
		while ((index2 = buffer.indexOf('\n\n')) >= 0) {
			const chunk = buffer.slice(0, index2);
			buffer = buffer.slice(index2 + 2);
			const eventLine = chunk.split('\n').find((line) => line.startsWith('event: '));
			const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
			if (!eventLine) continue;
			yield { event: eventLine.slice(7).trim(), data: dataLine ? JSON.parse(dataLine.slice(6)) : {} };
		}
	}
}

console.log('\n=== 对练 HTTP + SSE 本地测试 ===\n');

try {
	console.log('[1] POST /exam/suggest');
	const suggest = await (await post('/exam/suggest', { kbId })).json();
	check('返回 ok 与目标', suggest.ok === true && suggest.objectives.length >= 1, JSON.stringify(suggest).slice(0, 120));
	const objective = suggest.objectives[0].text;

	console.log('\n[2] POST /exam/start');
	const started = await (await post('/exam/start', { kbId, objective })).json();
	check('会话已建', started.ok === true && Boolean(started.session?.id));
	check('大纲非空', started.outline?.length >= 1, `实际 ${started.outline?.length}`);
	const sessionId = started.session.id;

	console.log('\n[3] GET /exam/stream（边收边答）');
	const controller = new AbortController();
	const streamResponse = await fetch(`${base}/exam/stream?id=${sessionId}`, { headers: { 'x-kb-client': '1' }, signal: controller.signal });
	check('SSE 状态码 200', streamResponse.status === 200, String(streamResponse.status));
	check('content-type 是 event-stream', String(streamResponse.headers.get('content-type')).includes('text/event-stream'), String(streamResponse.headers.get('content-type')));

	const order = [];
	let answered = 0;
	let report = null;
	const answerText = ['梭形病斑，中央灰白，用药苯醚甲环唑。', '戊唑醇拌种，轮作三年。', '补充答案。'];
	let done = false;

	for await (const { event, data } of readEvents(streamResponse)) {
		order.push(event);
		if (event === 'question' || event === 'probe') {
			console.log(`     ${event} #${data.seq}［${data.kpId}］${data.text}`);
			if (event === 'question') answered += 1;
			const answer = answerText[Math.min(answered, answerText.length - 1)] ?? '答案';
			const result = await (await post('/exam/answer', { sessionId, turnId: data.turnId, answer })).json();
			if (!result.ok) console.log(`     （提交失败：${result.error}）`);
		} else if (event === 'grade') {
			console.log(`     grade  ${data.score}/2 ${data.verdict}｜${data.comment}`);
		} else if (event === 'board') {
			console.log(`     board  ${JSON.stringify(data.mastery)}`);
		} else if (event === 'report') {
			report = data;
			console.log(`     report ${data.label}（覆盖 ${data.avgCoverage}）`);
		} else if (event === 'error') {
			console.log(`     error  ${data.code} ${data.message}`);
		} else if (event === 'done') {
			console.log(`     done   ${data.reason}`);
			done = true;
			controller.abort();
			break;
		} else if (event === 'stage') {
			// stage 只做进度提示，不打印
		}
	}

	console.log('\n[4] 事件协议断言');
	check('第一个事件是 meta', order[0] === 'meta', order[0]);
	check('至少问出 2 题', answered >= 2, `实际 ${answered}`);
	check('每道题后都有 grade', order.filter((item) => item === 'question').length <= order.filter((item) => item === 'grade').length);
	check('以 done 结束', done || order[order.length - 1] === 'done', order[order.length - 1]);
	check('有 report 事件', Boolean(report));
	check('顺序：question 先于 grade', order.indexOf('question') < order.indexOf('grade'));

	console.log('\n[5] 会话接口');
	const list = await (await fetch(`${base}/exam/list`, { headers: { 'x-kb-client': '1' } })).json();
	check('列表里能看到这场', list.sessions?.some((item) => item.id === sessionId));
	const one = await (await fetch(`${base}/exam/session?id=${sessionId}`, { headers: { 'x-kb-client': '1' } })).json();
	check('单场能恢复 turns', one.ok === true && one.turns.length >= answered, `${one.turns?.length}`);

	console.log('\n[6] 模型自检');
{
	const diagBody = await (await fetch(`${base}/exam/diag`, { headers: { 'x-kb-client': '1' } })).json();
	check('diag 返回 ok', diagBody.ok === true, JSON.stringify(diagBody).slice(0, 120));
	check('diag 里 ready 没被覆盖', diagBody.ready === true, JSON.stringify(diagBody.ready));
	check('diag 带出选中的模型', diagBody.picked?.model === 'demo-model', JSON.stringify(diagBody.picked));
}

console.log('\n[7] 权限');
	const noHeader = await fetch(`${base}/exam/list`);
	check('缺 x-kb-client 头被拒', noHeader.status === 403, String(noHeader.status));
	const badPost = await fetch(`${base}/exam/suggest`, { method: 'GET', headers: { 'x-kb-client': '1' } });
	check('GET 打 POST 接口返回 405', badPost.status === 405, String(badPost.status));
} finally {
	server.close();
	store.close();
	fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed ? `失败 ${failed} 项` : '全部通过 ✓'}（通过 ${passed} 项）`);
process.exit(failed ? 1 : 0);
