// ============================================================================
// 学习主题（对练）· 本地测试
//
//   node test/exam.mjs
//
// 只测"存 / 取 / prompt / 工具"这几件事——对练本身在 DSH 会话里，插件不再调模型。
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createIndex } from '../lib/index.mjs';
import { renderDocument, chunkDocument } from '../lib/chunker.mjs';
import { createExam } from '../lib/exam/engine.mjs';
import { createKnowledgeBaseTools } from '../lib/tools.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
	if (ok) { passed += 1; console.log(`  ok   ${name}`); }
	else { failed += 1; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

// ── 临时库 ────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-topic-'));
const store = openStore({ root, logger: { info() {}, warn() {}, error() {} } });
const index = createIndex({ store, embedder: { enabled: false } });
const now = Date.now();
const kbId = 'kb_topic';
store.createKb({ id: kbId, name: '测试知识库', now });

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
		{ kind: 'text', text: '症状：叶片出现梭形病斑，中央灰白。防治：发病初期用苯醚甲环唑，安全间隔期 21 天。' },
	],
});
addDoc({
	id: 'd_b', name: '示例-病害B.docx', ext: 'docx',
	blocks: [
		{ kind: 'heading', level: 1, text: '病害 B' }, { kind: 'page', page: 1 },
		{ kind: 'text', text: '症状：果穗变黑粉包，病株矮化。防治：以种子处理为主，重病田轮作 3 年。' },
	],
});

const exam = createExam({ store, logger: { warn() {}, error() {} } });

console.log('\n[1] 设计 prompt（会话里用）');
{
	const design = exam.designPrompt({ kbId, docIds: ['d_a'] });
	check('带 kbId', design.prompt.includes(kbId));
	check('带 docIds', design.prompt.includes('d_a'));
	check('要求先读文档', design.prompt.includes('kb_search') && design.prompt.includes('kb_read'));
	check('要求先确认再保存', design.prompt.includes('kb_topic_save') && design.prompt.includes('确认'));
	check('要求点选而不是打字', design.prompt.includes('ask_user_question'));
	check('题量默认 10', design.prompt.includes('默认 10 题'));
	check('允许自定义题量', design.prompt.includes('6 题') && design.prompt.includes('15 题'));
	check('保存后留在会话里开练', design.prompt.includes('直接就在这里当考官'));
	check('允许"先存着"', design.prompt.includes('先存着'));
	check('范围不存在时报错', (() => {
		try { exam.designPrompt({ kbId, docIds: ['d_nope'] }); return false; } catch { return true; }
	})());
}

console.log('\n[2] 保存 / 读取 / 删除');
{
	const topic = exam.saveTopic({
		kbId,
		docIds: ['d_a', 'd_b'],
		objective: '能根据症状区分两种病害并给出防治措施',
		outline: [
			{ id: 'kp1', title: '症状辨识', docIds: [] },
			{ id: 'kp2', title: '药剂选择', docIds: [] },
		],
		blueprint: [
			{ kpId: 'kp1', turns: 5, difficulty: 'discern' },
			{ kpId: 'kp2', turns: 5, difficulty: 'apply' },
		],
	});
	check('默认题量 10', topic.totalTurns === 10, String(topic.totalTurns));
	check('记住知识库与文件', topic.docIds.length === 2 && topic.kbName === '测试知识库');
	check('能读回', exam.getTopic(topic.id)?.objective.includes('两种病害'));
	check('列表里有', exam.listTopics(50).some((item) => item.id === topic.id));

	const custom = exam.saveTopic({
		kbId, docIds: [], objective: '自定义题量', outline: [{ id: 'kp1', title: '甲', docIds: [] }], blueprint: [], totalTurns: 6,
	});
	check('可自定义题量', custom.totalTurns === 6, String(custom.totalTurns));

	const clamped = exam.saveTopic({
		kbId, docIds: [], objective: '越界题量', outline: [{ id: 'kp1', title: '乙', docIds: [] }], blueprint: [], totalTurns: 999,
	});
	check('题量有上限 30', clamped.totalTurns === 30, String(clamped.totalTurns));

	check('删除返回条数', exam.deleteTopic(topic.id).removed === 1);
	check('删完查不到', exam.getTopic(topic.id) === null);

	const emptyOutline = (() => {
		try { exam.saveTopic({ kbId, docIds: [], objective: '空大纲', outline: [], blueprint: [] }); return false; } catch { return true; }
	})();
	check('空大纲会被拒', emptyOutline);
}

console.log('\n[3] 考官 prompt');
{
	const topic = exam.saveTopic({
		kbId,
		docIds: ['d_a'],
		objective: '能讲清病害 A 的识别与防治',
		outline: [{ id: 'kp1', title: '识别' }, { id: 'kp2', title: '用药' }],
		blueprint: [
			{ kpId: 'kp1', turns: 3, difficulty: 'discern' },
			{ kpId: 'kp2', turns: 3, difficulty: 'apply' },
		],
		totalTurns: 6,
	});
	const { prompt } = exam.topicPrompt(topic.id);
	check('带目标', prompt.includes('能讲清病害 A'));
	check('带大纲顺序', prompt.includes('1. 识别') && prompt.includes('2. 用药'));
	check('带总题数', prompt.includes('总共 6 题'));
	check('限制一次一题', prompt.includes('一次只问一道题'));
	check('要求给结论', prompt.includes('达成'));
	check('要出处', prompt.includes('kb_search'));
}

console.log('\n[4] agent 工具');
{
	const tools = createKnowledgeBaseTools({ store, index, pipeline: { enqueue() {} }, exam });
	const save = tools.find((item) => item.name === 'kb_topic_save');
	const list = tools.find((item) => item.name === 'kb_topic_list');
	check('注册了 kb_topic_save', Boolean(save));
	check('注册了 kb_topic_list', Boolean(list));

	const result = await save.execute({
		kbId,
		docIds: ['d_a'],
		objective: '能独立判断病害 A 并给方案',
		outline: [{ title: '田间识别', turns: 4, difficulty: 'apply' }, { title: '配药' }],
		totalTurns: 8,
	});
	check('工具能落库', result.ok === true && result.topicId.startsWith('tp_'), JSON.stringify(result));

	const stored = exam.getTopic(result.topicId);
	check('知识点自动编号', stored.outline.map((kp) => kp.id).join(',') === 'kp1,kp2', JSON.stringify(stored.outline.map((kp) => kp.id)));
	check('工具带上题量', stored.totalTurns === 8, String(stored.totalTurns));

	const listed = await list.execute({});
	check('工具能列出主题', listed.topics.length >= 2, String(listed.topics.length));

	const bad = await save.execute({ kbId, objective: '', outline: [] });
	check('缺参数时不崩、返回失败', bad.ok === false && typeof bad.summary === 'string');
}

store.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${failed ? `失败 ${failed} 项` : '全部通过 ✓'}（通过 ${passed} 项）`);
process.exit(failed ? 1 : 0);
