/**
 * 学习主题（对练）引擎。
 *
 * 设计上只做"存"和"取"：
 *   - 面板负责选文件、看卡片；
 *   - 定目标、拆大纲、出题、点评、结报告全在 DSH 会话里完成（agent 用工具读库、用
 *     kb_topic_save 落库），所以这里**不调模型**，也就不需要 prompt/评分/状态机。
 */

import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exam_run (
  id          TEXT PRIMARY KEY,
  topic_id    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  verdict     TEXT,
  summary     TEXT
);
CREATE INDEX IF NOT EXISTS exam_run_by_topic ON exam_run(topic_id, started_at);
CREATE TABLE IF NOT EXISTS exam_turn (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kp_title   TEXT,
  question   TEXT NOT NULL,
  answer     TEXT,
  score      INTEGER,
  verdict    TEXT,
  comment    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS exam_turn_by_run ON exam_turn(run_id, seq);
CREATE TABLE IF NOT EXISTS exam_topic (

  id          TEXT PRIMARY KEY,
  kb_id       TEXT NOT NULL,
  kb_name     TEXT,
  doc_ids     TEXT,
  objective   TEXT NOT NULL,
  outline     TEXT NOT NULL,
  blueprint   TEXT NOT NULL,
  total_turns INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);
`;

// 题目质量的硬性标准：两个 prompt（设计 / 考官）都用这一份，避免两处不一致
const QUALITY_RULES = [
	'题目质量标准（硬性，违反就是废题）：',
	'1. 每道题必须**脱离原文也能独立读懂**：不许出现"文档第 2 页""那行小字""上图""这组 VS"这类指代。',
	'2. 考的是判断与用法，不是阅读理解。禁止问"文档里写了什么"，只允许下面四类题型（一场里至少覆盖三类）：',
	'   · 场景判断：给一个真实场景（客户来问、田间症状、报价/交付场合），问你怎么判断、怎么办；',
	'   · 因果解释：为什么会这样、为什么不用另一种；',
	'   · 对比辨析：两个相近概念或方案的区别，以及选哪个的依据；',
	'   · 反例纠错：给一个错误说法，指出错在哪、正确的应该是什么。',
	'3. 每题只有一个明确的答案范围。出题时先在心里定好 2~4 条判分要点，我答得对不对按这几条判。',
	'4. 难度配比：纯记忆/复述题不超过两成，其余必须是应用或辨析。',
	'5. 出题前自检一句："这题能区分会与不会吗？"——区分不了就换一题，宁可少出一题也不要出废题。',
	'6. 题干写清三件事：场景与已知条件、要我回答什么、回答到什么程度。',
];

const DEFAULT_TURNS = 10;
const MIN_TURNS = 3;
const MAX_TURNS = 30;

export class ExamError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ExamError';
		this.code = code;
	}
}

const id = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const asText = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {object} options
 * @param {object} options.store  openStore() 的返回值
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 */
export function createExam({ store, logger = console, now = () => Date.now() }) {
	const db = store.db;
	const q = (sql) => db.prepare(sql);
	db.exec(SCHEMA);
	// 老库没有 total_turns：加一次，失败说明已经有了
	try { db.exec('ALTER TABLE exam_topic ADD COLUMN total_turns INTEGER'); } catch { /* already there */ }

	const docsOf = (kbId, docIds) => {
		const docs = store.listNodes(kbId).filter((node) => node.kind === 'doc');
		const scope = Array.isArray(docIds) ? docIds.filter(Boolean) : [];
		if (!scope.length) return docs;
		const allowed = new Set(scope);
		const picked = docs.filter((doc) => allowed.has(doc.id));
		if (!picked.length) throw new ExamError('empty_scope', '选中的文件都不在这个知识库里了，刷新一下再选');
		return picked;
	};

	function topicRow(row) {
		if (!row) return null;
		return {
			id: row.id,
			kbId: row.kb_id,
			kbName: row.kb_name ?? '',
			docIds: row.doc_ids ? JSON.parse(row.doc_ids) : [],
			objective: row.objective,
			outline: row.outline ? JSON.parse(row.outline) : [],
			blueprint: row.blueprint ? JSON.parse(row.blueprint) : [],
			totalTurns: Number(row.total_turns) || DEFAULT_TURNS,
			createdAt: row.created_at,
			updatedAt: row.updated_at ?? row.created_at,
		};
	}

	function listTopics(limit = 50) {
		return q('SELECT * FROM exam_topic ORDER BY updated_at DESC, created_at DESC LIMIT ?').all(limit).map(topicRow);
	}

	function getTopic(topicId) {
		return topicRow(q('SELECT * FROM exam_topic WHERE id = ?').get(topicId));
	}

	function saveTopic({ kbId, docIds, objective, outline, blueprint, totalTurns }) {
		const text = asText(objective);
		if (!text) throw new ExamError('no_objective', '先给一个学习目标');
		if (!Array.isArray(outline) || !outline.length) throw new ExamError('no_outline', '大纲是空的，先生成或手写几个知识点');
		const kb = store.getKb(kbId);
		if (!kb) throw new ExamError('no_kb', '知识库不存在');
		const turns = Math.min(Math.max(Math.trunc(Number(totalTurns) || DEFAULT_TURNS), MIN_TURNS), MAX_TURNS);
		const topicId = id('tp');
		const stamp = now();
		q(`INSERT INTO exam_topic (id, kb_id, kb_name, doc_ids, objective, outline, blueprint, total_turns, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			topicId, kbId, kb.name ?? '', JSON.stringify(Array.isArray(docIds) ? docIds : []), text,
			JSON.stringify(outline), JSON.stringify(Array.isArray(blueprint) ? blueprint : []), turns, stamp, stamp,
		);
		return getTopic(topicId);
	}

	function deleteTopic(topicId) {
		for (const run of q('SELECT id FROM exam_run WHERE topic_id = ?').all(topicId)) {
			q('DELETE FROM exam_turn WHERE run_id = ?').run(run.id);
		}
		q('DELETE FROM exam_run WHERE topic_id = ?').run(topicId);
		const row = q('SELECT id FROM exam_topic WHERE id = ?').get(topicId);
		if (!row) return { removed: 0 };
		q('DELETE FROM exam_topic WHERE id = ?').run(topicId);
		return { removed: 1 };
	}

	/** 会话用的"一起定目标、拆大纲"prompt（谈定后由 agent 调 kb_topic_save 落库）。 */
	function designPrompt({ kbId, docIds }) {
		const kb = store.getKb(kbId);
		if (!kb) throw new ExamError('no_kb', '知识库不存在');
		const scope = Array.isArray(docIds) ? docIds.filter(Boolean) : [];
		const docs = docsOf(kbId, scope);
		const lines = [];
		lines.push('帮我给这个知识库设计一个「学习主题」，最后写回知识库。');
		lines.push('');
		lines.push(`知识库：${kb.name ?? kbId}（kbId: ${kbId}）`);
		lines.push(`范围：${docs.length} 篇文档`);
		docs.slice(0, 12).forEach((doc) => lines.push(`- 《${doc.name}》 docId: ${doc.id}`));
		lines.push('');
		lines.push(`docIds（保存时原样传）：${JSON.stringify(docs.map((doc) => doc.id))}`);
		lines.push('');
		lines.push('请按这个顺序推进，每一步都停下来等我确认：');
		lines.push('1. 先用 kb_list / kb_search / kb_read 了解这些文档讲什么（别只看文件名）。');
		lines.push('2. 给我 3 个候选学习目标，各自覆盖不同的知识点组合；目标要"整体能做到一件事"，');
		lines.push('   不能是单点事实（"能说出某个年份"这种是题目，不是目标）；每个目标注明覆盖哪几个知识点。');
		lines.push('   · 然后调用 ask_user_question，把 3 个候选做成选项让我点选（选项文字 ≤20 字，完整说明放 question 里）；');
		lines.push('     不要让我打字回"选第 2 个"。如果当前会话没有这个工具，再用文字列出来让我挑。');
		lines.push('3. 我选定一个之后，把它拆成 3~6 个知识点（按考察顺序），每个知识点说明考什么、大概几题、什么难度。');
		lines.push(`   · 总题数默认 ${DEFAULT_TURNS} 题；把题数分配到各知识点，写清每个知识点几题，合计要等于总题数。`);
		lines.push('   · 如果我想要别的题量（比如 6 题、15 题），用 ask_user_question 给「6 题」「10 题」「15 题」「自定义」四个选项让我选，');
		lines.push('     按我选的重新分配；我直接说了数字就照那个数字。');
		lines.push('4. 大纲列出来后，用 ask_user_question 让我点选确认，选项至少包含：');
		lines.push('   「确认，写入知识库并开始对练」「题量太多，减少一点」「合并相近知识点」「重写大纲」。');
		lines.push('   我选「确认」才调用 kb_topic_save；选其它按我的意思改，改完再问一次。调用参数：');
		lines.push(`   kbId=${kbId}，docIds 用上面那串，objective=确认过的目标，outline=确认过的知识点（每项带 turns），totalTurns=确认过的总题数。`);
		lines.push('5. 保存成功后**不要结束这段对话**：直接就在这里当考官，按刚保存的大纲开练。');
		lines.push('   · 开始前先调用 kb_exam_log（action=start，topicId 用刚保存的）开一次记录；');
		lines.push('     之后每问完一题、点评完，就调用一次 kb_exam_log（action=turn）把题目、我的回答、评分、点评写进去；');
		lines.push('     最后调用 kb_exam_log（action=finish）写结论。这样我能在面板里回看每次对练。');
		lines.push('   · 先说一句"已保存到知识库"，再用一句话说明你打算怎么考（每个知识点几题）；');
		lines.push('     然后用 ask_user_question 给「开始第 1 题」「先歇一会，我要去面板看看」两个选项，我点了再出题；');
		lines.push('   · 流程：一次一题、先 kb_search / kb_read 找到依据再出题、答对追一层、答错降一档，');
		lines.push('     结束时给达成/接近/未达成 + 薄弱点 + 该复习哪篇哪一页；');
		lines.push('   · 出题必须满足下面这份质量标准，不合格的题不要出：');
		for (const rule of QUALITY_RULES) lines.push('     ' + rule);
		lines.push('   · 如果我明确说"先存着，晚点再练"，那就只保存，并告诉我回「知识库 → 对练」页点「开始 AI 对练」。');
		lines.push('');
		lines.push('现在从第 1 步开始：先告诉我这些文档大致讲了什么（每个文档一句话），再给 3 个候选目标。');
		return { prompt: lines.join('\n') };
	}

	/** 已保存主题 → 考官 prompt（面板卡片上的「开始 AI 对练」用它）。 */
	function topicPrompt(topicId) {
		const topic = getTopic(topicId);
		if (!topic) throw new ExamError('no_topic', '学习主题不存在');
		const docs = (topic.docIds.length
			? store.listNodes(topic.kbId).filter((node) => node.kind === 'doc' && topic.docIds.includes(node.id))
			: store.listNodes(topic.kbId).filter((node) => node.kind === 'doc'));
		const plan = new Map(topic.blueprint.map((item) => [item.kpId, item]));
		const lines = [];
		lines.push('请你当考官，基于我的个人知识库带我做一场对练。');
		lines.push('');
		lines.push(`学习主题：${topic.objective}`);
		lines.push(`知识库：${topic.kbName || topic.kbId}`);
		lines.push(`范围：${docs.length} 篇文档`);
		docs.slice(0, 12).forEach((doc) => lines.push(`- 《${doc.name}》 docId: ${doc.id}`));
		if (docs.length > 12) lines.push(`- …还有 ${docs.length - 12} 篇`);
		lines.push('');
		lines.push('学习大纲（按这个顺序考）：');
		topic.outline.forEach((kp, index) => {
			const item = plan.get(kp.id) ?? {};
			lines.push(`${index + 1}. ${kp.title}（难度 ${item.difficulty ?? 'discern'}，约 ${item.turns ?? 2} 题）`);
		});
		lines.push('');
		lines.push('流程规则：');
		lines.push('1. 一次只问一道题，等我回答后再点评，不要一次抛多题。');
		lines.push('2. 出题前先用 kb_search / kb_read 在知识库里找到依据；库里没有的内容不要编。');
		lines.push('3. 每题点评：指出对在哪、缺什么；答对了追问一层，答错降一档再问一道同类题。');
		lines.push('');
		lines.push(`4. 总共 ${topic.totalTurns} 题，按上面每个知识点标注的题量分配，要全部覆盖。`);
		lines.push('5. 结束时给结论：达成 / 接近 / 未达成，逐项列出薄弱点，并指出该复习哪篇文档的哪一部分。');
		lines.push('');
		for (const rule of QUALITY_RULES) lines.push(rule);
		lines.push('');
		lines.push(`记录：开始前调用 kb_exam_log（action=start，topicId=${topicId}）；`);
		lines.push('每问完一题、点评完就调用 kb_exam_log（action=turn）写题目/回答/评分/点评；结束时调用 action=finish 写结论。');
		lines.push('');
		lines.push('先告诉我你打算怎么考（每个知识点几题），我说「开始」你再出第一题。');
		return { prompt: lines.join('\n'), topic };
	}

	// ── 对练记录（chat 里的每一步由 agent 用 kb_exam_log 写进来）────────
	function runRow(row) {
		if (!row) return null;
		return {
			id: row.id,
			topicId: row.topic_id,
			startedAt: row.started_at,
			finishedAt: row.finished_at,
			verdict: row.verdict ?? '',
			summary: row.summary ?? '',
			turns: q('SELECT COUNT(*) AS n FROM exam_turn WHERE run_id = ?').get(row.id)?.n ?? 0,
		};
	}

	function startRun({ topicId }) {
		const topic = getTopic(topicId);
		if (!topic) throw new ExamError('no_topic', '学习主题不存在');
		const runId = id('rn');
		q('INSERT INTO exam_run (id, topic_id, started_at) VALUES (?, ?, ?)').run(runId, topicId, now());
		return { runId, topic };
	}

	function logTurn({ runId, seq, kpTitle, question, answer, score, verdict, comment }) {
		const run = q('SELECT id FROM exam_run WHERE id = ?').get(runId);
		if (!run) throw new ExamError('no_run', '这次对练记录不存在，先调用 action=start');
		const text = asText(question);
		if (!text) throw new ExamError('no_question', '题目不能为空');
		const nextSeq = Math.trunc(Number(seq) || 0)
			|| ((q('SELECT COALESCE(MAX(seq), 0) AS s FROM exam_turn WHERE run_id = ?').get(runId)?.s ?? 0) + 1);
		const turnId = id('tn');
		q('INSERT INTO exam_turn (id, run_id, seq, kp_title, question, answer, score, verdict, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
			turnId, runId, nextSeq, asText(kpTitle) || null, text,
			asText(answer) || null,
			Number.isFinite(Number(score)) ? Math.min(Math.max(Math.round(Number(score)), 0), 100) : null,
			['full', 'partial', 'wrong'].includes(verdict) ? verdict : null,
			asText(comment) || null,
			now(),
		);
		return { turnId, seq: nextSeq };
	}

	function finishRun({ runId, verdict, summary }) {
		const run = q('SELECT id FROM exam_run WHERE id = ?').get(runId);
		if (!run) throw new ExamError('no_run', '这次对练记录不存在');
		const tag = ['pass', 'near', 'fail'].includes(verdict) ? verdict : null;
		q('UPDATE exam_run SET finished_at = ?, verdict = ?, summary = ? WHERE id = ?')
			.run(now(), tag, asText(summary) || null, runId);
		return runRow(q('SELECT * FROM exam_run WHERE id = ?').get(runId));
	}

	function listRuns(topicId, limit = 20) {
		return q('SELECT * FROM exam_run WHERE topic_id = ? ORDER BY started_at DESC LIMIT ?')
			.all(topicId, limit).map(runRow);
	}

	function getRun(runId) {
		const run = runRow(q('SELECT * FROM exam_run WHERE id = ?').get(runId));
		if (!run) return null;
		run.items = q('SELECT * FROM exam_turn WHERE run_id = ? ORDER BY seq').all(runId).map((row) => ({
			id: row.id,
			seq: row.seq,
			kpTitle: row.kp_title ?? '',
			question: row.question,
			answer: row.answer ?? '',
			score: row.score,
			verdict: row.verdict ?? '',
			comment: row.comment ?? '',
			createdAt: row.created_at,
		}));
		return run;
	}

	return {
		listTopics,

		getTopic,
		saveTopic,
		deleteTopic,
		designPrompt,
		topicPrompt,
		startRun,
		logTurn,
		finishRun,
		listRuns,
		getRun,
	};
}
