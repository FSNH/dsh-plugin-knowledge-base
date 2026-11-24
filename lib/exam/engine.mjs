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

/** 模型偶尔会包一层 ```json，或前后加解释；这里只认第一个完整的 JSON 对象。 */
function readJson(text, purpose) {
	const raw = String(text ?? '').trim();
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start < 0 || end <= start) throw new ExamError('bad_json', `${purpose}：模型没有返回 JSON`);
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch (error) {
		throw new ExamError('bad_json', `${purpose}：JSON 解析失败（${error.message}）`);
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

	const docsOf = (kbId) => store.listNodes(kbId).filter((node) => node.kind === 'doc');
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

	// ── 1. 读库提议目标 ───────────────────────────────────────────────
	async function suggestObjectives({ kbId }) {
		const docs = docsOf(kbId);
		if (!docs.length) throw new ExamError('empty_kb', '这个知识库还没有文档，先把文件放进来再对练');
		const kb = store.getKb(kbId);
		const payload = await callModel(promptObjectives({
			kbName: kb?.name ?? '未命名',
			docs: docs.slice(0, 12).map((doc) => ({ name: doc.name, excerpt: excerptOf(doc.id) })),
		}), 600);
		const parsed = readJson(payload, 'objectives');
		const objectives = asArray(parsed.objectives)
			.map((item) => ({
				text: asText(item?.text),
				why: asText(item?.why),
				coverage: ['high', 'medium', 'low'].includes(item?.coverage) ? item.coverage : 'medium',
			}))
			.filter((item) => item.text);
		if (!objectives.length) throw new ExamError('bad_objectives', '模型没能提出可用目标，换个模型或重试');
		return objectives.slice(0, 3);
	}

	// ── 2. 大纲与计划 ─────────────────────────────────────────────────
	async function buildPlan({ kbId, objective }) {
		const docs = docsOf(kbId);
		const kb = store.getKb(kbId);
		const parsed = readJson(await callModel(promptOutline({
			kbName: kb?.name ?? '未命名',
			objective,
			docs: docs.map((doc) => ({ id: doc.id, name: doc.name, ext: doc.ext })),
		}), 900), 'outline');

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
	async function fragmentsFor({ kbId, kp }) {
		const docIds = Array.isArray(kp.docIds) ? kp.docIds.filter(Boolean) : [];
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
		const fragments = await fragmentsFor({ kbId: session.kbId, kp });
		if (!fragments.length) return null;

		let lastError = null;
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			try {
				const parsed = readJson(await callModel(promptQuestion({
					kpTitle: kp.title,
					objective: session.objective,
					fragments: fragments.map((hit) => ({ name: hit.name, page: hit.page, text: hit.text })),
					asked,
				}), 600), 'question');

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

		const parsed = readJson(await callModel(promptGrade({
			question: turn.payload.question,
			expectedPoints: turn.payload.expectedPoints,
			answer: text,
		}), 500), 'grade');

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
	async function start({ kbId, objective, provider, model, effort }) {
		const text = asText(objective);
		if (!text) throw new ExamError('no_objective', '先给一个学习目标');
		const docs = docsOf(kbId);
		if (!docs.length) throw new ExamError('empty_kb', '这个知识库还没有文档');

		const { outline, blueprint } = await buildPlan({ kbId, objective: text });
		const sessionId = id('ex');
		q(`INSERT INTO exam_session (id, kb_id, objective, outline, blueprint, status, provider, model, effort, created_at)
			VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`).run(
			sessionId, kbId, text, JSON.stringify(outline), JSON.stringify(blueprint),
			provider ?? null, model ?? null, effort ?? null, now(),
		);
		return { session: getSession(sessionId), outline, blueprint };
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
		maxTurns,
	};
}
