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
import { createKnowledgeBaseTools } from '../lib/tools.mjs';

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

console.log('\n[6] 范围：只考选中的文件');
{
	const scoped = await exam.start({ kbId, objective: objectives[0].text, docIds: ['d_blast'] });
	check('会话记住范围', JSON.stringify(scoped.session.docIds) === JSON.stringify(['d_blast']), JSON.stringify(scoped.session.docIds));
	const inScope = scoped.outline.every((kp) => kp.docIds.every((docId) => docId === 'd_blast'));
	check('知识点只落在选中的文档里', inScope, JSON.stringify(scoped.outline.map((kp) => kp.docIds)));
	const scoped2 = await exam.suggestObjectives({ kbId, docIds: ['d_smut'] });
	check('提议目标也能限定范围', scoped2.length >= 1);
	let threw = false;
	try { await exam.start({ kbId, objective: 'x', docIds: ['d_not_exist'] }); } catch { threw = true; }
	check('范围全都不存在时报错而不是退化成整库', threw);
}
console.log('\n[7] 模型不按 JSON 输出时的兜底');
{
	const replies = [];
	const scripted = async ({ purpose }) => {
		if (purpose !== 'objectives') throw new Error('这一步不该调用模型');
		return replies.shift() ?? '';
	};
	const exam2 = createExam({ store, index, chat: scripted, logger: { warn() {}, error() {} } });

	// ① 先说人话，重试后给 JSON
	replies.push('好的，我先看看这个库里都有什么。');
	replies.push('{"objectives":[{"text":"能区分两种病害","why":"两篇文档覆盖","coverage":"high"}]}');
	const retried = await exam2.suggestObjectives({ kbId });
	check('解析失败会自动重试一次', retried.length === 1 && retried[0].text.includes('两种病害'), JSON.stringify(retried));

	// ①-2 目标要带知识点列表（"整体目标"而不是单点事实）
	replies.length = 0;
	replies.push('{"objectives":[{"text":"能向客户完整介绍这套方案","points":["公司定位","规模数据","产品矩阵"],"why":"三篇文档覆盖","coverage":"high"}]}');
	const withPoints = await exam2.suggestObjectives({ kbId });
	check('目标带 points', Array.isArray(withPoints[0]?.points) && withPoints[0].points.length === 3, JSON.stringify(withPoints[0]?.points));
	// ② 包在代码块里也能解析
	replies.length = 0;
	replies.push('\u0060\u0060\u0060json\n{"objectives":[{"text":"能说出用药顺序","coverage":"medium"}]}\n\u0060\u0060\u0060');
	const fenced = await exam2.suggestObjectives({ kbId });
	check('代码块里的 JSON 能取出来', fenced.length === 1 && fenced[0].text.includes('用药顺序'), JSON.stringify(fenced));

	// ③ 字符串里带花括号，不能被截断
	replies.length = 0;
	replies.push('{"objectives":[{"text":"能解释 {安全间隔} 的含义","coverage":"low"}]}');
	const braces = await exam2.suggestObjectives({ kbId });
	check('字符串里的花括号不影响解析', braces.length === 1 && braces[0].text.includes('{安全间隔}'), JSON.stringify(braces));

	// ④ 一直不说 JSON：报错里要带上模型原话
	replies.length = 0;
	replies.push('抱歉，我无法完成。');
	replies.push('我真的不会输出 JSON。');
	let message = '';
	try { await exam2.suggestObjectives({ kbId }); } catch (error) { message = String(error?.message ?? ''); }
	check('连续失败会报错', message.length > 0);
	check('错误里带上模型原话', message.includes('无法完成') || message.includes('不会输出'), message);
}

console.log('\n[8] 学习主题：对话设计 + 落库');
{
	const design = exam.designPrompt({ kbId, docIds: ['d_blast'] });
	check('design prompt 带 kbId', design.prompt.includes(kbId));
	check('design prompt 要求调用 kb_topic_save', design.prompt.includes('kb_topic_save'));
	check('design prompt 带上 docIds', design.prompt.includes('d_blast'));
	check('design prompt 要求先确认再保存', design.prompt.includes('确认'));
	check('保存后默认在当前会话开练', design.prompt.includes('直接就在这里当考官'));
	check('允许"先存着"', design.prompt.includes('先存着'));

	const saved = exam.saveTopic({
		kbId,
		docIds: ['d_blast'],
		objective: '能向客户完整讲清玉米大斑病的识别与防治',
		outline: [
			{ id: 'kp1', title: '症状辨识', docIds: [] },
			{ id: 'kp2', title: '药剂选择', docIds: [] },
		],
		blueprint: [{ kpId: 'kp1', turns: 2, difficulty: 'discern' }],
	});
	check('保存后能读回', exam.getTopic(saved.id)?.objective.includes('大斑病'));
	check('列表里有它', exam.listTopics(50).some((item) => item.id === saved.id));

	const prompt = exam.topicPrompt(saved.id);
	check('考官 prompt 带大纲', prompt.prompt.includes('症状辨识') && prompt.prompt.includes('药剂选择'));
	check('考官 prompt 限制一次一题', prompt.prompt.includes('一次只问一道题'));

	const tools = createKnowledgeBaseTools({ store, index, pipeline: { enqueue() {} }, exam });
	const saveTool = tools.find((item) => item.name === 'kb_topic_save');
	const listTool = tools.find((item) => item.name === 'kb_topic_list');
	check('注册了 kb_topic_save / kb_topic_list', Boolean(saveTool) && Boolean(listTool));

	const result = await saveTool.execute({
		kbId,
		docIds: ['d_blast'],
		objective: '能独立完成大斑病的田间诊断',
		outline: [{ title: '田间症状', turns: 2, difficulty: 'apply' }, { title: '用药时机' }],
	});
	check('工具能落库', result.ok === true && result.topicId.startsWith('tp_'), JSON.stringify(result));
	const listed = await listTool.execute({});
	check('工具能列出主题', listed.topics.length >= 2, String(listed.topics.length));

	check('删掉一个', exam.deleteTopic(saved.id).removed === 1);
}

store.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${failed ? '失败' : '全部通过'} ${failed ? `${failed} 项` : '✓'}（通过 ${passed} 项）`);
process.exit(failed ? 1 : 0);
