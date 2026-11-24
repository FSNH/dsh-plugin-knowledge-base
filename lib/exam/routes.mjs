// ============================================================================
// 对练模式的 HTTP 路由
//
//   POST /exam/suggest   只读：读库 → 3 个候选目标
//   POST /exam/start     建会话：目标 → 大纲 → 计划
//   GET  /exam/stream    SSE 主通道：出题 / 评分 / 追问 / 报告，全部事件从这里出
//   POST /exam/answer    提交答案（SSE 侧检测到评分完成后继续推进）
//   POST /exam/finish    直接结业并出报告
//   GET  /exam/list      历史会话
//   GET  /exam/session   单场会话 + 轮次（面板刷新后恢复用）
//
// SSE 用「轮询数据库」推进而不是内存事件总线：
//   · 本地 SQLite 查询是微秒级，200ms 轮询的代价可以忽略；
//   · 不用维护 emitter 生命周期，SSE 断开/重连天然安全；
//   · 多个标签页同时开着也不会互相丢事件（各自按 seq 去重）。
// ============================================================================

import { API_BASE, sendJson, readBody, guard } from '../util.mjs';

const POLL_MS = 200;
const SSE_KEEPALIVE_MS = 15_000;
const ANSWER_TIMEOUT_MS = 30 * 60_000;

function sseHead(res) {
	res.writeHead(200, {
		'content-type': 'text/event-stream; charset=utf-8',
		'cache-control': 'no-cache, no-transform',
		connection: 'keep-alive',
		'x-accel-buffering': 'no',
	});
	res.write(': connected\n\n');
}

function sseSend(res, event, data) {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {object} options.exam     createExam() 的返回值
 * @param {() => string} options.origin 同源校验用的 origin
 * @param {object} [options.logger]
 */
export function createExamRoutes({ exam, origin, logger = console, diag }) {
	const fail = (res, status, error, code) => sendJson(res, status, { ok: false, error, code });


	/** 会话里"最后一个还没被评分的 question/probe"，没有就返回 null。 */
	function openTurn(sessionId) {
		const turns = exam.turnsOf(sessionId);
		const pending = turns.filter((turn) => (turn.kind === 'question' || turn.kind === 'probe') && !turn.payload?.grade && !turn.payload?.answer);
		return pending[0] ?? null;
	}

	function lastGradedTurn(sessionId) {
		const turns = exam.turnsOf(sessionId).filter((turn) => turn.kind === 'question' && turn.payload?.grade);
		return turns[turns.length - 1] ?? null;
	}

	const scoreboard = (sessionId) => exam.masteryOf(sessionId);

	const routes = [];

	// ── 自检：面板用它告诉用户"能不能练、用哪个模型、为什么不能" ──────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/diag`,
		handler: async (req, res) => {
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			if (typeof diag !== 'function') return sendJson(res, 200, { ok: false, reason: 'no_diag', message: '没有自检入口' });
			try {
				return sendJson(res, 200, { ok: true, ...(await diag()) });
			} catch (error) {
				return sendJson(res, 200, { ok: false, reason: 'diag_failed', message: error?.message ?? '自检失败' });
			}
		},
	});

	// ── 提议目标 ──────────────────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/suggest`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			try {
				const objectives = await exam.suggestObjectives({
					kbId: String(body.value.kbId ?? ''),
					docIds: Array.isArray(body.value.docIds) ? body.value.docIds.map(String) : [],
				});
				return sendJson(res, 200, { ok: true, objectives });
			} catch (error) {
				return fail(res, 400, error.message ?? '提议目标失败', error.code);
			}
		},
	});

	// ── 建会话 ────────────────────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/start`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			try {
				const { session, outline, blueprint } = await exam.start({
					kbId: String(body.value.kbId ?? ''),
					objective: String(body.value.objective ?? ''),
					provider: body.value.provider ? String(body.value.provider) : undefined,
					model: body.value.model ? String(body.value.model) : undefined,
					effort: body.value.effort ? String(body.value.effort) : undefined,
					docIds: Array.isArray(body.value.docIds) ? body.value.docIds.map(String) : [],
				});
				return sendJson(res, 200, { ok: true, session, outline, blueprint });
			} catch (error) {
				return fail(res, 400, error.message ?? '开始对练失败', error.code);
			}
		},
	});

	// ── 提交答案 ──────────────────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/answer`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			const sessionId = String(body.value.sessionId ?? '');
			const turnId = String(body.value.turnId ?? '');
			const text = String(body.value.answer ?? '');
			try {
				const turn = exam.turnsOf(sessionId).find((item) => item.id === turnId);
				if (!turn) return fail(res, 404, '这道题不存在', 'no_turn');
				if (turn.kind === 'probe') {
					exam.submitProbe({ sessionId, turnId, answer: text });
					return sendJson(res, 200, { ok: true, probe: true });
				}
				const result = await exam.submitAnswer({ sessionId, turnId, answer: text });
				return sendJson(res, 200, { ok: true, ...result });
			} catch (error) {
				return fail(res, 400, error.message ?? '提交失败', error.code);
			}
		},
	});

	// ── 结业 ──────────────────────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/finish`,
		handler: (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			void url;
			return readBody(req).then((body) => {
				if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
				try {
					const report = exam.finish(String(body.value.sessionId ?? ''));
					return sendJson(res, 200, { ok: true, report });
				} catch (error) {
					return fail(res, 400, error.message ?? '结业失败', error.code);
				}
			});
		},
	});

	// ── 列表 / 单场 ───────────────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/list`,
		handler: (req, res) => {
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 50);
			return sendJson(res, 200, { ok: true, sessions: exam.listSessions(limit) });
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/session`,
		handler: (req, res) => {
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			const sessionId = url.searchParams.get('id') ?? '';
			const session = exam.getSession(sessionId);
			if (!session) return fail(res, 404, '会话不存在', 'no_session');
			return sendJson(res, 200, { ok: true, session, turns: exam.turnsOf(sessionId), mastery: scoreboard(sessionId) });
		},
	});

	// ── SSE 主通道 ────────────────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/stream`,
		handler: async (req, res) => {
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			const sessionId = url.searchParams.get('id') ?? '';
			const session = exam.getSession(sessionId);
			if (!session) return fail(res, 404, '会话不存在', 'no_session');

			sseHead(res);
			let closed = false;
			req.on('close', () => { closed = true; });
			const keepalive = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, SSE_KEEPALIVE_MS);

			let lastSeq = 0;
			let lastGraded = '';
			const startedAt = Date.now();

			try {
				sseSend(res, 'meta', {
					sessionId,
					objective: session.objective,
					kp: session.outline.map((item) => ({ id: item.id, title: item.title })),
					model: session.model ?? '',
					provider: session.provider ?? '',
				});

				while (!closed) {
					if (Date.now() - startedAt > ANSWER_TIMEOUT_MS) {
						sseSend(res, 'error', { code: 'timeout', message: '太久没有回答了，先结束这场吧' });
						break;
					}

					// 先结算刚评完的题（评分必须在追问/下一题之前到达前端）
					const graded = lastGradedTurn(sessionId);
					if (graded && graded.id !== lastGraded) {
						lastGraded = graded.id;
						const grade = graded.payload?.grade ?? {};
						sseSend(res, 'grade', {
							turnId: graded.id,
							seq: graded.seq,
							kpId: graded.kpId,
							score: grade.score,
							verdict: grade.verdict,
							missing: grade.missing ?? [],
							comment: grade.comment ?? '',
						});
						sseSend(res, 'board', { mastery: scoreboard(sessionId) });
						continue;
					}

					// 再发待答的题（首题 / 追问 / 答错补的题）
					const open = openTurn(sessionId);
					if (open) {
						if (open.seq !== lastSeq) {
							lastSeq = open.seq;
							sseSend(res, open.kind === 'probe' ? 'probe' : 'question', {
								turnId: open.id,
								seq: open.seq,
								kpId: open.kpId,
								text: open.payload?.question ?? '',
								difficulty: open.difficulty,
								refs: open.refs ?? [],
							});
						}
						// 等用户回答（POST /exam/answer 会把答案写进去）
						await sleep(POLL_MS);
						continue;
					}

					// 没有待答的题，也没有新评分 → 出下一题
					sseSend(res, 'stage', { text: '正在从知识库里出下一题…' });
					let next;
					try {
						next = await exam.nextQuestion(sessionId);
					} catch (error) {
						sseSend(res, 'error', { code: error.code ?? 'engine', message: error.message ?? '出题失败' });
						break;
					}
					if (next.done) {
						const report = exam.finish(sessionId);
						sseSend(res, 'report', report);
						sseSend(res, 'done', { reason: next.reason });
						break;
					}
					lastSeq = next.seq;
					sseSend(res, 'question', {
						turnId: next.turnId,
						seq: next.seq,
						kpId: next.kpId,
						kpTitle: next.kpTitle,
						text: next.question,
						difficulty: next.difficulty,
						refs: next.refs ?? [],
					});
				}
			} catch (error) {
				logger.warn?.(`[knowledge-base] 对练 SSE 中断：${error instanceof Error ? error.message : String(error)}`);
				if (!closed) sseSend(res, 'error', { code: 'stream', message: error instanceof Error ? error.message : String(error) });
			} finally {
				clearInterval(keepalive);
				if (!closed) res.end();
			}
		},
	});

	return { routes };
}
