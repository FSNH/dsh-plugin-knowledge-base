// ============================================================================
// 对练模式 · 本地端到端测试
//
//   node test/exam.mjs          用「假模型」跑完整一场（不联网，几秒出结果）
//   node test/exam.mjs --live   用真模型（OpenAI 兼容接口，需要环境变量）
//
// live 模式需要的环境变量：
//   EXAM_BASE_URL  例如 https://dashscope.aliyuncs.com/compatible-mode/v1
//   EXAM_API_KEY   你的 key
//   EXAM_MODEL     例如 qwen-plus / deepseek-chat
//
// 假模型模式下断言的是**流程与结构**（状态、题数、评分、报告、引用），不比对自然语言。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createIndex } from '../lib/index.mjs';
import { renderDocument, chunkDocument } from '../lib/chunker.mjs';
import { createExam } from '../lib/exam/engine.mjs';

const live = process.argv.includes('--live');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
	if (ok) {
		passed += 1;
		console.log(`  ok   ${name}`);
	} else {
		failed += 1;
		console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`);
	}
}

// ── 造一个临时库 ──────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-exam-'));
const store = openStore({ root, logger: { info() {}, warn() {}, error() {} } });
const index = createIndex({ store, embedder: { enabled: false } });

const now = Date.now();
const kbId = 'kb_test01';
store.createKb({ id: kbId, name: '植保测试库', now });

function addDoc({ id, name, ext, blocks }) {
	store.createNode({ id, kbId, parentId: null, kind: 'doc', name, ext, now, status: 'ready' });
	const { text, lines } = renderDocument(blocks);
	store.saveText(id, text, now);
	index.insertChunks({ nodeId: id, kbId, chunks: chunkDocument(lines) });
}

addDoc({
	id: 'd_blast',
	name: '玉米大斑病防治-占位.pptx',
	ext: 'pptx',
	blocks: [
		{ kind: 'heading', level: 1, text: '玉米大斑病' },
		{ kind: 'page', page: 1 },
		{ kind: 'text', text: '症状：叶片出现长梭形病斑，边缘褐色，中央灰白色，潮湿时病斑上生灰黑色霉层。' },
		{ kind: 'text', text: '发病条件：温度 20~25℃，相对湿度 90% 以上，连续阴雨利于流行。' },
		{ kind: 'page', page: 2 },
		{ kind: 'heading', level: 2, text: '防治' },
		{ kind: 'text', text: '发病初期选用苯醚甲环唑、吡唑醚菌酯等药剂，间隔 7~10 天喷一次，连喷 2~3 次。' },
		{ kind: 'text', text: '注意：三唑类药剂在苗期慎用，避免抑制生长；安全间隔期 21 天。' },
	],
});

addDoc({
	id: 'd_smut',
	name: '玉米丝黑穗病-占位.docx',
	ext: 'docx',
	blocks: [
		{ kind: 'heading', level: 1, text: '玉米丝黑穗病' },
		{ kind: 'page', page: 1 },
		{ kind: 'text', text: '症状：果穗变成黑粉包，外被灰白色膜，破裂后散出黑粉；病株常矮化、叶片丛生。' },
		{ kind: 'text', text: '传播：土壤和种子带菌，苗期侵染，系统发病。' },
		{ kind: 'text', text: '防治：以种子处理为主，用戊唑醇、苯醚甲环唑拌种；重病田轮作 3 年以上。' },
	],
});

// ── 模型：假 或 真 ────────────────────────────────────────────────────
function fakeChat() {
	const asked = [];
	let questionNo = 0;
	const answers = [
		{ score: 2, verdict: 'full', missing: [], comment: '症状描述完整，抓住了"梭形病斑+灰黑霉层"两个关键点。', followup: '那为什么苗期要慎用三唑类？' },
		{ score: 1, verdict: 'partial', missing: ['安全间隔期 21 天'], comment: '药剂选对了，但没说安全间隔期。', followup: '' },
		{ score: 0, verdict: 'wrong', missing: ['以种子处理为主', '戊唑醇或苯醚甲环唑拌种'], comment: '把丝黑穗病和叶斑类病害的防治搞混了。', followup: '' },
	];
	return async ({ purpose }) => {
		if (purpose === 'objectives') {
			return JSON.stringify({
				objectives: [
					{ text: '能根据症状区分玉米大斑病与丝黑穗病，并说出对应防治措施', why: '两篇文档分别覆盖症状与防治', coverage: 'high' },
					{ text: '能说清大斑病发病条件与用药注意事项', why: '文档里有温湿度与安全间隔期', coverage: 'medium' },
					{ text: '能独立给出重病田的轮作建议', why: '丝黑穗病文档提到轮作 3 年', coverage: 'low' },
				],
			});
		}
		if (purpose === 'outline') {
			return JSON.stringify({
				kp: [
					{ id: 'kp1', title: '大斑病症状辨识', docIds: ['d_blast'], reason: '文档 1 有症状描述' },
					{ id: 'kp2', title: '药剂选择与安全间隔', docIds: ['d_blast'], reason: '文档 1 防治段落' },
					{ id: 'kp3', title: '丝黑穗病防治要点', docIds: ['d_smut'], reason: '文档 2 防治段落' },
				],
				plan: [
					{ kpId: 'kp1', turns: 1, difficulty: 'discern' },
					{ kpId: 'kp2', turns: 1, difficulty: 'apply' },
					{ kpId: 'kp3', turns: 1, difficulty: 'recall' },
				],
			});
		}
		if (purpose === 'question') {
			questionNo += 1;
			asked.push(questionNo);
			return JSON.stringify({
				question: `第 ${questionNo} 题：请描述这个知识点里的关键特征或做法。`,
				expectedPoints: ['关键症状或做法', '具体药剂/条件'],
				difficulty: 'apply',
				refs: ['1'],
			});
		}
		if (purpose === 'grade') {
			return JSON.stringify(answers[Math.min(questionNo - 1, answers.length - 1)]);
		}
		throw new Error(`未知 purpose: ${purpose}`);
	};
}

function liveChat() {
	const baseUrl = process.env.EXAM_BASE_URL;
	const apiKey = process.env.EXAM_API_KEY;
	const model = process.env.EXAM_MODEL;
	if (!baseUrl || !apiKey || !model) {
		console.error('live 模式需要 EXAM_BASE_URL / EXAM_API_KEY / EXAM_MODEL');
		process.exit(2);
	}
	return async ({ messages, maxTokens }) => {
		const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ model, messages, max_tokens: maxTokens ?? 700, temperature: 0.3 }),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}：${(await response.text()).slice(0, 200)}`);
		const data = await response.json();
		return data.choices?.[0]?.message?.content ?? '';
	};
}

const chat = live ? liveChat() : fakeChat();
const exam = createExam({ store, index, chat, logger: { info() {}, warn() {}, error: console.error } });

// ── 跑一场 ────────────────────────────────────────────────────────────
console.log(`\n=== 对练本地测试（${live ? '真模型' : '假模型'}）===\n`);

console.log('[1] 提议学习目标');
const objectives = await exam.suggestObjectives({ kbId });
check('返回 1~3 个目标', objectives.length >= 1 && objectives.length <= 3, `实际 ${objectives.length}`);
objectives.forEach((item, i) => console.log(`     ${i + 1}. ${item.text}（coverage=${item.coverage}）`));

console.log('\n[2] 建会话（大纲 + 计划）');
const { session } = await exam.start({ kbId, objective: objectives[0].text });
check('会话状态 running', session.status === 'running');
check('大纲 1~5 个知识点', session.outline.length >= 1 && session.outline.length <= 5, `实际 ${session.outline.length}`);
check('计划覆盖所有知识点', session.blueprint.length === session.outline.length);
session.outline.forEach((kp) => {
	const plan = session.blueprint.find((item) => item.kpId === kp.id);
	console.log(`     ${kp.id} ${kp.title} — ${plan.turns} 题 / ${plan.difficulty}`);
});

console.log('\n[3] 多轮问答');
const answers = [
	'叶片上出现长梭形病斑，边缘褐色、中央灰白，潮湿时有灰黑色霉层。',
	'发病初期用苯醚甲环唑，间隔 7 到 10 天喷一次，连喷两次。',
	'用戊唑醇拌种就可以。',
	'苗期生长快，三唑类容易抑制生长。',
	'重病田要轮作三年以上。',
];
let asked = 0;
for (const answer of answers) {
	const next = await exam.nextQuestion(session.id);
	if (next.done) break;
	asked += 1;
	check(`第 ${asked} 题带引用`, Array.isArray(next.refs) && next.refs.length > 0);
	console.log(`     Q${asked}［${next.kpId}·${next.difficulty}］${next.question}`);
	const result = await exam.submitAnswer({ sessionId: session.id, turnId: next.turnId, answer });
	console.log(`       → ${result.grade.score}/2 ${result.grade.verdict}｜${result.grade.comment}`);
	if (result.probe) {
		console.log(`       ↳ 追问：${result.probe.question}`);
		exam.submitProbe({ sessionId: session.id, turnId: result.probe.turnId, answer: '安全间隔 21 天，避免残留。' });
	}
}

console.log('\n[4] 结业报告');
const report = exam.finish(session.id);
check('报告有结论', ['pass', 'near', 'fail'].includes(report.verdict), report.verdict);
check('每个知识点都有分数', report.kps.length === session.outline.length);
check('报告轮数与实际一致', report.turns === asked, `报告 ${report.turns} / 实际 ${asked}`);
report.kps.forEach((kp) => console.log(`     ${kp.title}：${kp.score} 分（覆盖 ${kp.coverage}）→ ${kp.label}`));
console.log(`     结论：${report.label}（平均覆盖 ${report.avgCoverage}）`);
if (report.weak.length) report.weak.forEach((item) => console.log(`     薄弱：${item.title} 缺 ${item.missing.join('、') || '—'}`));

console.log('\n[5] 数据落库');
const stored = exam.getSession(session.id);
check('会话状态 finished', stored.status === 'finished');
check('报告已持久化', Boolean(stored.report));
const turnRows = exam.turnsOf(session.id);
check('turn 数 >= 题数', turnRows.length >= asked, `${turnRows.length} vs ${asked}`);
check('历史列表能查到', exam.listSessions(5).some((item) => item.id === session.id));

store.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${failed ? '失败' : '全部通过'} ${failed ? `${failed} 项` : '✓'}（通过 ${passed} 项）`);
process.exit(failed ? 1 : 0);
