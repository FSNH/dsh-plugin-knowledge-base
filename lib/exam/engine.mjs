/**
 * 对练引擎：状态机 + 检索 + 模型调用 + 落库 + 报告。
 *
 * 对外只暴露 createExam()，不直接碰 HTTP / UI —— 便于用假模型在本地跑端到端测试
 * （见 test/exam.mjs），也便于以后换 SSE 或独立面板而不动核心逻辑。
 *
 * 设计要点：
 *   - 每道题必须带 refs（片段序号），resolveRefs 时校验；校验不过就重出，连丢 3 次该知识点记 0 覆盖；
 *   - 评分只信 expectedPoints，模型给自由文本一律丢弃；
 *   - 报告不调模型：分数、覆盖度、结论全部由本文件计算，保证可复现。
 */

import { randomUUID } from 'node:crypto';
import { promptObjectives, promptOutline, promptQuestion, promptGrade } from './prompts.mjs';

const DIFFICULTY_WEIGHT = { recall: 1, discern: 1.3, apply: 1.6 };
const LOWER = { apply: 'discern', discern: 'recall', recall: 'recall' };
const MAX_REFS_MISS = 3;
const MIN_EVIDENCE_PER_KP = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exam_session (
  id          TEXT PRIMARY KEY,
  kb_id       TEXT NOT NULL,
  objective   TEXT NOT NULL,
  outline     TEXT NOT NULL,
  blueprint   TEXT NOT NULL,
  status      TEXT NOT NULL,
  doc_ids     TEXT,
  provider    TEXT,
  model       TEXT,
  effort      TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER,
  report      TEXT
);
CREATE TABLE IF NOT EXISTS exam_turn (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kp_id      TEXT,
  kind       TEXT NOT NULL,
  difficulty TEXT,
  payload    TEXT,
  refs       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exam_turn_session ON exam_turn(session_id, seq);
CREATE TABLE IF NOT EXISTS exam_topic (
  id          TEXT PRIMARY KEY,
  kb_id       TEXT NOT NULL,
  kb_name     TEXT,
  doc_ids     TEXT,
  objective   TEXT NOT NULL,
  outline     TEXT NOT NULL,
  blueprint   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);
CREATE TABLE IF NOT EXISTS exam_mastery (
  session_id TEXT NOT NULL,
  kp_id      TEXT NOT NULL,
  score      REAL,
  coverage   REAL,
  evidence   TEXT,
  PRIMARY KEY (session_id, kp_id)
);
`;

export class ExamError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'ExamError';
		this.code = code;
	}
}

const id = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

/** 把模型输出里第一个"平衡的" JSON 对象抠出来（跳过字符串里的花括号）。 */
function firstJsonObject(text) {
	const start = text.indexOf('{');
	if (start < 0) return '';
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === '{') depth += 1;
		else if (ch === '}') {
			depth -= 1;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return '';
}

/** 容忍代码块、前后解释、字符串里的花括号；解析不了就把模型原话带进错误。 */
function readJson(text, purpose) {
	const raw = String(text ?? '').trim();
	if (!raw) throw new ExamError('bad_json', `${purpose}：模型没有输出任何内容`);
	const fenced = /\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i.exec(raw);
	const candidate = fenced ? fenced[1].trim() : raw;
	const slice = firstJsonObject(candidate) || firstJsonObject(raw);
	if (!slice) {
		throw new ExamError('bad_json', `${purpose}：模型没有返回 JSON（它说的是：${raw.slice(0, 120)}…）`);
	}
	try {
		return JSON.parse(slice);
	} catch (error) {
		throw new ExamError('bad_json', `${purpose}：JSON 解析失败（${error.message}）；原始输出：${slice.slice(0, 120)}…`);
	}
}

const asArray = (value) => (Array.isArray(value) ? value : []);
const asText = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {object} options
 * @param {object} options.store   openStore() 的返回值
 * @param {object} options.index   createIndex() 的返回值（只需要 search）
 * @param {(request: {purpose: string, messages: object[], maxTokens?: number}) => Promise<string>} options.chat
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @param {number} [options.maxTurns]
 */
export function createExam({ store, index, chat, logger = console, now = () => Date.now(), maxTurns = 12 }) {
	if (typeof chat !== 'function') throw new ExamError('no_chat', '没有可用的模型调用函数');
	const db = store.db;
	const q = (sql) => db.prepare(sql);
	db.exec(SCHEMA);
	// 老库没有 doc_ids 列：加一次，失败说明已经有了
	try { db.exec('ALTER TABLE exam_session ADD COLUMN doc_ids TEXT'); } catch { /* already there */ }

	const docsOf = (kbId, docIds) => {
		const docs = store.listNodes(kbId).filter((node) => node.kind === 'doc');
		const scope = Array.isArray(docIds) ? docIds.filter(Boolean) : [];
		if (!scope.length) return docs;
		const allowed = new Set(scope);
		const picked = docs.filter((doc) => allowed.has(doc.id));
		// 选中的文件一个都不存在时不要"静默退化成整库"——那会考到用户没选的东西
		if (!picked.length) throw new ExamError('empty_scope', '选中的文件都不在这个知识库里了，刷新一下再选');
		return picked;
	};
	const excerptOf = (docId) => store.getText(docId).replace(/\s+/g, ' ').trim();

	function sessionRow(row) {
		if (!row) return null;
		return {
			id: row.id,
			kbId: row.kb_id,
			objective: row.objective,
			status: row.status,
			provider: row.provider,
			model: row.model,
			effort: row.effort,
			docIds: row.doc_ids ? JSON.parse(row.doc_ids) : [],
			createdAt: row.created_at,
			finishedAt: row.finished_at,
			outline: row.outline ? JSON.parse(row.outline) : [],
			blueprint: row.blueprint ? JSON.parse(row.blueprint) : [],
			report: row.report ? JSON.parse(row.report) : null,
		};
	}

	function getSession(sessionId) {
		return sessionRow(q('SELECT * FROM exam_session WHERE id = ?').get(sessionId));
	}

	function listSessions(limit = 10) {
		return q('SELECT * FROM exam_session ORDER BY created_at DESC LIMIT ?')
			.all(limit)
			.map(sessionRow);
	}

	function turnsOf(sessionId) {
		return q('SELECT * FROM exam_turn WHERE session_id = ? ORDER BY seq').all(sessionId).map((row) => ({
			id: row.id,
			sessionId: row.session_id,
			seq: row.seq,
			kpId: row.kp_id,
			kind: row.kind,
			difficulty: row.difficulty,
			createdAt: row.created_at,
			payload: row.payload ? JSON.parse(row.payload) : {},
			refs: row.refs ? JSON.parse(row.refs) : [],
		}));
	}

	function callModel(prompt, maxTokens = 700) {
		return chat({ purpose: prompt.purpose, messages: prompt.messages, maxTokens });
	}

	/**
	 * 要 JSON 的调用：先正常问一次，解析失败就带上"只输出 JSON"再问一次。
	 * 弱模型（比如 flash 档）经常加一句"好的，我来分析…"，重试一次基本能救回来。
	 */
	async function callJson(prompt, purpose, maxTokens = 700) {
		const first = await callModel(prompt, maxTokens);
		try {
			return readJson(first, purpose);
		} catch (error) {
			const retryPrompt = {
				purpose: prompt.purpose,
				messages: [
					...prompt.messages,
					{ role: 'user', content: '上次的输出不符合要求。这次只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块、不要在前后加文字。' },
				],
			};
			const second = await callModel(retryPrompt, maxTokens);
			try {
				return readJson(second, purpose);
			} catch {
				throw error;
			}
		}
	}

	// ── 1. 读库提议目标 ───────────────────────────────────────────────
	async function suggestObjectives({ kbId, docIds }) {
		const docs = docsOf(kbId, docIds);
		if (!docs.length) throw new ExamError('empty_kb', '这个知识库还没有文档，先把文件放进来再对练');
		const kb = store.getKb(kbId);
		const parsed = await callJson(promptObjectives({
			kbName: kb?.name ?? '未命名',
			docs: docs.slice(0, 12).map((doc) => ({ name: doc.name, excerpt: excerptOf(doc.id) })),
		}), 'objectives', 600);
		const objectives = asArray(parsed.objectives)
			.map((item) => ({
				text: asText(item?.text),
				points: asArray(item?.points).map(asText).filter(Boolean).slice(0, 8),
				why: asText(item?.why),
				coverage: ['high', 'medium', 'low'].includes(item?.coverage) ? item.coverage : 'medium',
			}))
			.filter((item) => item.text);
		if (!objectives.length) throw new ExamError('bad_objectives', '模型没能提出可用目标，换个模型或重试');
		return objectives.slice(0, 3);
	}

	// ── 2. 大纲与计划 ─────────────────────────────────────────────────
	async function buildPlan({ kbId, objective, docIds }) {
		const docs = docsOf(kbId, docIds);
		const kb = store.getKb(kbId);
		const parsed = await callJson(promptOutline({
			kbName: kb?.name ?? '未命名',
			objective,
			docs: docs.map((doc) => ({ id: doc.id, name: doc.name, ext: doc.ext })),
		}), 'outline', 900);

		const known = new Set(docs.map((doc) => doc.id));
		const outline = asArray(parsed.kp)
			.map((item, index) => ({
				id: asText(item?.id) || `kp${index + 1}`,
				title: asText(item?.title),
				docIds: asArray(item?.docIds).filter((docId) => known.has(docId)),
				reason: asText(item?.reason),
			}))
			.filter((item) => item.title);
		if (!outline.length) throw new ExamError('bad_outline', '模型没能拆出知识点，换个模型或重试');

		const planById = new Map(asArray(parsed.plan).map((item) => [asText(item?.kpId), item]));
		const blueprint = outline.map((kp) => {
			const planned = planById.get(kp.id) ?? {};
			const difficulty = ['recall', 'discern', 'apply'].includes(planned.difficulty) ? planned.difficulty : 'discern';
			return {
				kpId: kp.id,
				turns: Math.min(Math.max(Number(planned.turns) || 2, 1), 4),
				difficulty,
			};
		});
		return { outline, blueprint };
	}

	// ── 3. 取片段 ─────────────────────────────────────────────────────
	/**
	 * 取当前知识点的参考片段。
	 *
	 * 顺序：知识点指定的文档 → 该库任意文档。
	 * 不直接用「知识点标题 + 目标」整句去检索：中文长句在 FTS 里是逐字 AND，
	 * 一整句几乎必然命中 0 条，结果就是"明明库里有内容却出不了题"。
	 */
	async function fragmentsFor({ kbId, kp, scope }) {
		const allowed = Array.isArray(scope) && scope.length ? new Set(scope) : null;
		const docIds = (Array.isArray(kp.docIds) ? kp.docIds.filter(Boolean) : [])
			.filter((docId) => !allowed || allowed.has(docId));
		const pick = (rows) => rows.slice(0, 3).map((row) => ({
			chunkId: row.chunkId,
			nodeId: row.nodeId,
			name: row.name,
			page: row.page,
			locator: row.locator,
			text: row.text,
		}));

		if (docIds.length) {
			const rows = q(`SELECT c.id AS chunkId, c.node_id AS nodeId, c.page, c.text, n.name
				FROM chunks c JOIN nodes n ON n.id = c.node_id
				WHERE c.kb_id = ? AND c.node_id IN (${docIds.map(() => '?').join(',')})
				ORDER BY c.node_id, c.ord LIMIT 6`).all(kbId, ...docIds);
			if (rows.length) {
				return pick(rows.map((row) => ({ ...row, locator: `知识库 → ${row.name}` })));
			}
		}

		// 没指定文档：用知识点标题的前两个词做一次检索（短查询才命中得了）。
		const query = kp.title.split(/[\s,，、]+/).filter(Boolean).slice(0, 2).join(' ') || kp.title;
		const result = await index.search({ query, kbIds: [kbId], limit: 3, mode: 'keyword' });
		if (result.hits?.length) return result.hits;

		// 兜底：从该库任意文档取样，宁可让模型基于真实内容出题，也不要空手返回。
		const rows = q(`SELECT c.id AS chunkId, c.node_id AS nodeId, c.page, c.text, n.name
			FROM chunks c JOIN nodes n ON n.id = c.node_id
			WHERE c.kb_id = ? ORDER BY c.node_id, c.ord LIMIT 3`).all(kbId);
		return pick(rows.map((row) => ({ ...row, locator: `知识库 → ${row.name}` })));
	}

	// ── 4. 出题 ───────────────────────────────────────────────────────
	async function askOnce({ session, kp, plan, asked }) {
		const fragments = await fragmentsFor({ kbId: session.kbId, kp, scope: session.docIds });
		if (!fragments.length) return null;

		let lastError = null;
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			try {
				const parsed = await callJson(promptQuestion({
					kpTitle: kp.title,
					objective: session.objective,
					fragments: fragments.map((hit) => ({ name: hit.name, page: hit.page, text: hit.text })),
					asked,
				}), 'question', 600);

				const question = asText(parsed.question);
				const expectedPoints = asArray(parsed.expectedPoints).map(asText).filter(Boolean);
				const refs = asArray(parsed.refs)
					.map((ref) => Number(String(ref).replace(/[^\d]/g, '')) - 1)
					.filter((index) => index >= 0 && index < fragments.length)
					.map((index) => ({
						chunkId: fragments[index].chunkId,
						docId: fragments[index].nodeId,
						name: fragments[index].name,
						page: fragments[index].page,
						locator: fragments[index].locator,
						quote: fragments[index].text.slice(0, 80),
					}));

				if (!question || !expectedPoints.length) throw new ExamError('bad_question', '题目或评分要点为空');
				if (!refs.length) throw new ExamError('no_refs', `出题没有绑定片段（第 ${attempt} 次）`);

				return { question, expectedPoints, difficulty: plan?.difficulty ?? 'discern', refs };
			} catch (error) {
				lastError = error;
				if (error.code !== 'no_refs' && error.code !== 'bad_question') throw error;
			}
		}
		throw lastError ?? new ExamError('bad_question', '出题失败');
	}

	async function nextQuestion(sessionId) {
		const session = getSession(sessionId);
		if (!session) throw new ExamError('no_session', '对练会话不存在');
		if (session.status === 'finished') throw new ExamError('finished', '这场对练已经结束');

		const turns = turnsOf(sessionId);
		const asked = turns.filter((turn) => turn.kind === 'question' || turn.kind === 'probe').map((turn) => turn.payload.question);
		const askedCount = turns.filter((turn) => turn.kind === 'question').length;
		if (askedCount >= maxTurns) return { done: true, reason: 'max_turns' };

		for (const kp of session.outline) {
			const plan = session.blueprint.find((item) => item.kpId === kp.id);
			const askedInKp = turns.filter((turn) => turn.kpId === kp.id && turn.kind === 'question');
			const extraExists = askedInKp.some((turn) => turn.payload.extra);
			const easierWanted = !extraExists && askedInKp.some((turn) => turn.payload.requestEasier);
			const budget = (plan?.turns ?? 2) + (extraExists ? 1 : 0) + (easierWanted ? 1 : 0);
			if (askedInKp.length >= budget) continue;

			// 答错后补的题降一档难度
			const lastWrong = askedInKp.filter((turn) => turn.payload.grade?.verdict === 'wrong').pop();
			const difficulty = easierWanted ? (LOWER[lastWrong?.difficulty] ?? 'recall') : plan?.difficulty;
			const built = await askOnce({ session, kp, plan: { ...plan, difficulty }, asked });
			if (!built) continue;

			const seq = turns.length + 1;
			const turnId = id('et');
			q(`INSERT INTO exam_turn (id, session_id, seq, kp_id, kind, difficulty, payload, refs, created_at)
				VALUES (?, ?, ?, ?, 'question', ?, ?, ?, ?)`).run(
				turnId, sessionId, seq, kp.id, built.difficulty,
				JSON.stringify({ question: built.question, expectedPoints: built.expectedPoints, ...(easierWanted ? { extra: true } : {}) }),
				JSON.stringify(built.refs), now(),
			);
			return {
				done: false,
				turnId,
				seq,
				kpId: kp.id,
				kpTitle: kp.title,
				question: built.question,
				difficulty: built.difficulty,
				refs: built.refs,
			};
		}
		return { done: true, reason: 'all_covered' };
	}

	// ── 5. 评分 ───────────────────────────────────────────────────────
	function recomputeMastery(sessionId) {
		const session = getSession(sessionId);
		const turns = turnsOf(sessionId).filter((turn) => turn.kind === 'question' && turn.payload.grade);
		for (const kp of session.outline) {
			const graded = turns.filter((turn) => turn.kpId === kp.id);
			if (!graded.length) {
				q(`INSERT INTO exam_mastery (session_id, kp_id, score, coverage, evidence) VALUES (?, ?, 0, 0, ?)
					ON CONFLICT(session_id, kp_id) DO UPDATE SET score = 0, coverage = 0, evidence = excluded.evidence`)
					.run(sessionId, kp.id, JSON.stringify([]));
				continue;
			}
			let weightSum = 0;
			let scoreSum = 0;
			const evidence = [];
			for (const turn of graded) {
				const weight = DIFFICULTY_WEIGHT[turn.difficulty] ?? 1;
				const score = (turn.payload.grade.score / 2) * 100;
				weightSum += weight;
				scoreSum += score * weight;
				evidence.push({ turnId: turn.id, score, missing: turn.payload.grade.missing ?? [] });
			}
			const score = weightSum ? scoreSum / weightSum : 0;
			const coverage = Math.min(graded.length / MIN_EVIDENCE_PER_KP, 1);
			q(`INSERT INTO exam_mastery (session_id, kp_id, score, coverage, evidence) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(session_id, kp_id) DO UPDATE SET score = excluded.score, coverage = excluded.coverage, evidence = excluded.evidence`)
				.run(sessionId, kp.id, Math.round(score), coverage, JSON.stringify(evidence));
		}
	}

	async function submitAnswer({ sessionId, turnId, answer }) {
		const session = getSession(sessionId);
		if (!session) throw new ExamError('no_session', '对练会话不存在');
		const turn = turnsOf(sessionId).find((item) => item.id === turnId);
		if (!turn) throw new ExamError('no_turn', '这道题不存在');
		if (turn.payload.grade) throw new ExamError('graded', '这道题已经评过了');

		const text = asText(answer);
		if (!text) throw new ExamError('empty_answer', '先写点东西再提交');

		const parsed = await callJson(promptGrade({
			question: turn.payload.question,
			expectedPoints: turn.payload.expectedPoints,
			answer: text,
		}), 'grade', 500);

		const verdict = ['wrong', 'partial', 'full'].includes(parsed.verdict) ? parsed.verdict : 'partial';
		const score = Math.min(Math.max(Number(parsed.score) || 0, 0), 2);
		const grade = {
			score,
			verdict,
			missing: asArray(parsed.missing).map(asText).filter(Boolean),
			comment: asText(parsed.comment),
		};

		turn.payload.answer = text;
		turn.payload.grade = grade;
		q('UPDATE exam_turn SET payload = ? WHERE id = ?').run(JSON.stringify(turn.payload), turn.id);

		// 答对且给了追问 → 插一条 probe（同 kp，不记分，只影响覆盖）
		let probe = null;
		const followup = asText(parsed.followup);
		if (verdict === 'full' && followup && !turn.payload.probe) {
			const probeId = id('et');
			q(`INSERT INTO exam_turn (id, session_id, seq, kp_id, kind, difficulty, payload, refs, created_at)
				VALUES (?, ?, ?, ?, 'probe', ?, ?, '[]', ?)`).run(
				probeId, sessionId, turn.seq + 1, turn.kpId, turn.difficulty,
				JSON.stringify({ question: followup, parentTurnId: turn.id }), now(),
			);
			probe = { turnId: probeId, question: followup };
		}

		// 答错 → 标记这个知识点要补一道更简单的题，由 nextQuestion 统一出题
		// （题目的唯一出口在 nextQuestion，避免"两个地方都能插题"的隐式状态）
		if (verdict === 'wrong') {
			const alreadyExtra = turnsOf(sessionId).some((item) => item.kpId === turn.kpId && item.payload.extra);
			if (!alreadyExtra) {
				turn.payload.requestEasier = true;
				q('UPDATE exam_turn SET payload = ? WHERE id = ?').run(JSON.stringify(turn.payload), turn.id);
			}
		}

		recomputeMastery(sessionId);
		const mastery = q('SELECT * FROM exam_mastery WHERE session_id = ?').all(sessionId);
		return { grade, probe, mastery };
	}

	/** 用户对 probe 的回答：只记录，不参与计分（追问是加分项之外的证据）。 */
	function submitProbe({ sessionId, turnId, answer }) {
		const turn = turnsOf(sessionId).find((item) => item.id === turnId);
		if (!turn) throw new ExamError('no_turn', '这道题不存在');
		turn.payload.answer = asText(answer);
		q('UPDATE exam_turn SET payload = ? WHERE id = ?').run(JSON.stringify(turn.payload), turn.id);
		return { ok: true };
	}

	// ── 6. 报告（纯计算，不调模型）────────────────────────────────────
	function finish(sessionId) {
		const session = getSession(sessionId);
		if (!session) throw new ExamError('no_session', '对练会话不存在');
		if (session.report) return session.report;

		recomputeMastery(sessionId);
		const rows = q('SELECT * FROM exam_mastery WHERE session_id = ?').all(sessionId);
		const kps = session.outline.map((kp) => {
			const row = rows.find((item) => item.kp_id === kp.id) ?? { score: 0, coverage: 0, evidence: '[]' };
			const evidence = JSON.parse(row.evidence ?? '[]');
			const missing = [...new Set(evidence.flatMap((item) => item.missing ?? []))];
			const evidenceCount = evidence.length;
			const label = row.coverage === 0
				? '没有证据'
				: row.score >= 80 && row.coverage >= 1 ? '掌握'
					: row.score >= 60 ? '部分掌握' : '未掌握';
			return {
				kpId: kp.id,
				title: kp.title,
				score: Math.round(row.score),
				coverage: Number(row.coverage.toFixed(2)),
				label,
				evidenceCount,
				missing,
			};
		});

		const graded = kps.filter((kp) => kp.coverage > 0);
		const weak = kps.filter((kp) => kp.coverage > 0 && kp.score < 60);
		const avgCoverage = kps.length ? kps.reduce((sum, kp) => sum + kp.coverage, 0) / kps.length : 0;
		const allPass = kps.every((kp) => kp.coverage > 0 && kp.score >= 60) && avgCoverage >= 0.8;

		const verdict = allPass
			? 'pass'
			: (graded.length > 0 && avgCoverage >= 0.6 ? 'near' : 'fail');
		const report = {
			verdict,
			label: verdict === 'pass' ? '达成' : verdict === 'near' ? '接近' : '未达成',
			avgCoverage: Number(avgCoverage.toFixed(2)),
			kps,
			weak: weak.map((kp) => ({ kpId: kp.kpId, title: kp.title, missing: kp.missing })),
			unsupported: kps.filter((kp) => kp.coverage === 0).map((kp) => kp.title),
			turns: turnsOf(sessionId).filter((turn) => turn.kind === 'question' && turn.payload.grade).length,
		};

		q('UPDATE exam_session SET status = ?, report = ?, finished_at = ? WHERE id = ?')
			.run('finished', JSON.stringify(report), now(), sessionId);
		return report;
	}

	// ── 7. 建会话 ─────────────────────────────────────────────────────
	async function start({ kbId, objective, provider, model, effort, docIds }) {
		const text = asText(objective);
		if (!text) throw new ExamError('no_objective', '先给一个学习目标');
		const scope = Array.isArray(docIds) ? docIds.filter(Boolean) : [];
		const docs = docsOf(kbId, scope);
		if (!docs.length) throw new ExamError('empty_kb', '这个知识库还没有文档');

		const built = await buildPlan({ kbId, objective: text, docIds: scope });
		// 知识点必须落在选中的文档里，否则会出现"考了没选的文档"
		const allowed = new Set(docs.map((doc) => doc.id));
		const outline = built.outline.map((kp) => ({
			...kp,
			docIds: kp.docIds.filter((docId) => allowed.has(docId)),
		}));
		const blueprint = built.blueprint;
		const sessionId = id('ex');
		q(`INSERT INTO exam_session (id, kb_id, objective, outline, blueprint, status, doc_ids, provider, model, effort, created_at)
			VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`).run(
			sessionId, kbId, text, JSON.stringify(outline), JSON.stringify(blueprint),
			scope.length ? JSON.stringify(scope) : null,
			provider ?? null, model ?? null, effort ?? null, now(),
		);
		return { session: getSession(sessionId), outline, blueprint };
	}

	// ── 学习主题（卡片）──────────────────────────────────────────
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
			createdAt: row.created_at,
			updatedAt: row.updated_at ?? row.created_at,
		};
	}

	function listTopics(limit = 50) {
		return q('SELECT * FROM exam_topic ORDER BY updated_at DESC, created_at DESC LIMIT ?').all(limit).map(topicRow);
	}

	function getTopic(id) {
		return topicRow(q('SELECT * FROM exam_topic WHERE id = ?').get(id));
	}

	function saveTopic({ kbId, docIds, objective, outline, blueprint }) {
		const text = asText(objective);
		if (!text) throw new ExamError('no_objective', '先给一个学习目标');
		if (!Array.isArray(outline) || !outline.length) throw new ExamError('no_outline', '大纲是空的，先生成或手写几个知识点');
		const kb = store.getKb(kbId);
		if (!kb) throw new ExamError('no_kb', '知识库不存在');
		const topicId = id('tp');
		const stamp = now();
		q(`INSERT INTO exam_topic (id, kb_id, kb_name, doc_ids, objective, outline, blueprint, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			topicId, kbId, kb.name ?? '', JSON.stringify(Array.isArray(docIds) ? docIds : []), text,
			JSON.stringify(outline), JSON.stringify(Array.isArray(blueprint) ? blueprint : []), stamp, stamp,
		);
		return getTopic(topicId);
	}

	function deleteTopic(topicId) {
		const row = q('SELECT id FROM exam_topic WHERE id = ?').get(topicId);
		if (!row) return { removed: 0 };
		q('DELETE FROM exam_topic WHERE id = ?').run(topicId);
		return { removed: 1 };
	}

	/** 只生成大纲与计划，不建对练会话（给"学习主题"用）。 */
	async function planOnly({ kbId, objective, docIds }) {
		const text = asText(objective);
		if (!text) throw new ExamError('no_objective', '先给一个学习目标');
		const scope = Array.isArray(docIds) ? docIds.filter(Boolean) : [];
		const docs = docsOf(kbId, scope);
		const built = await buildPlan({ kbId, objective: text, docIds: scope });
		const allowed = new Set(docs.map((doc) => doc.id));
		const outline = built.outline.map((kp) => ({ ...kp, docIds: kp.docIds.filter((docId) => allowed.has(docId)) }));
		return { outline, blueprint: built.blueprint, docs: docs.map((doc) => ({ id: doc.id, name: doc.name })) };
	}

	/** 会话用的"一起定目标、拆大纲"prompt（对话完成后由 agent 调 kb_topic_save 落库）。 */
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
		lines.push('4. 大纲列出来后，用 ask_user_question 让我点选确认，选项至少包含：');
		lines.push('   「确认，写入知识库并开始对练」「题量太多，减少一点」「合并相近知识点」「重写大纲」。');
		lines.push('   我选「确认」才调用 kb_topic_save；选其它按我的意思改，改完再问一次。调用参数：');
		lines.push(`   kbId=${kbId}，docIds 用上面那串，objective=确认过的目标，outline=确认过的知识点。`);
		lines.push('5. 保存成功后**不要结束这段对话**：直接就在这里当考官，按刚保存的大纲开练。');
		lines.push('   · 先说一句"已保存到知识库"，再用一句话说明你打算怎么考（每个知识点几题）；');
		lines.push('     然后用 ask_user_question 给「开始第 1 题」「先歇一会，我要去面板看看」两个选项，我点了再出题；');
		lines.push('   · 对练规矩和考官版一致：一次一题、先 kb_search / kb_read 找到依据再出题、');
		lines.push('     答对追一层、答错降一档、最多 12 题覆盖全部知识点、结束时给达成/接近/未达成 + 薄弱点 + 该复习哪篇哪一页；');
		lines.push('   · 如果我明确说"先存着，晚点再练"，那就只保存，并告诉我回「知识库 → 对练」页点「开始 AI 对练」。');
		lines.push('');
		lines.push('现在从第 1 步开始：先告诉我这些文档大致讲了什么（每个文档一句话），再给 3 个候选目标。');
		return { prompt: lines.join('\n') };
	}

	/** 把主题变成一个可以直接粘进会话的考官 prompt。 */
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
		lines.push('规则：');
		lines.push('1. 一次只问一道题，等我回答后再点评，不要一次抛多题。');
		lines.push('2. 出题前先用 kb_search / kb_read 在知识库里找到依据；库里没有的内容不要编。');
		lines.push('3. 每题点评：指出对在哪、缺什么；答对了追问一层，答错降一档再问一道同类题。');
		lines.push('4. 总共不超过 12 题，要把上面每个知识点都覆盖到。');
		lines.push('5. 结束时给结论：达成 / 接近 / 未达成，逐项列出薄弱点，并指出该复习哪篇文档的哪一部分。');
		lines.push('');
		lines.push('先告诉我你打算怎么考（每个知识点几题），我说「开始」你再出第一题。');
		return { prompt: lines.join('\n'), topic };
	}

	function masteryOf(sessionId) {
		return q('SELECT kp_id, score, coverage, evidence FROM exam_mastery WHERE session_id = ?')
			.all(sessionId)
			.map((row) => ({
				kpId: row.kp_id,
				score: Math.round(row.score ?? 0),
				coverage: Number((row.coverage ?? 0).toFixed(2)),
			}));
	}

	return {
		suggestObjectives,
		start,
		nextQuestion,
		submitAnswer,
		submitProbe,
		finish,
		getSession,
		listSessions,
		turnsOf,
		masteryOf,
		listTopics,
		getTopic,
		saveTopic,
		deleteTopic,
		planOnly,
		topicPrompt,
		designPrompt,
		maxTurns,
	};
}
