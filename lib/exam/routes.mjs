// ============================================================================
// 学习主题（对练）的 HTTP 路由
//
// 只有四件事：
//   GET  /exam/topics              列卡片
//   POST /exam/topics              存卡片（一般由 agent 的工具调用，面板也可直接调）
//   POST /exam/topic/delete        删卡片
//   GET  /exam/topic/prompt        已存主题 → 考官 prompt
//   GET  /exam/topic/design-prompt 选好范围 → "一起定目标/拆大纲"的 prompt
//
// 定目标、拆大纲、出题、点评全部发生在 DSH 会话里（agent 用 kb_* 工具），
// 所以这里没有任何模型调用，也没有 SSE。
// ============================================================================

import { API_BASE, sendJson, readBody, guard } from '../util.mjs';

/**
 * @param {object} options
 * @param {object} options.exam    createExam() 的返回值
 * @param {() => string} options.origin 同源校验用的 origin
 * @param {object} [options.logger]
 */
export function createExamRoutes({ exam, origin, logger = console }) {
	const fail = (res, status, error, code) => sendJson(res, status, { ok: false, error, code });
	const routes = [];

	// ── 列表 / 保存 ───────────────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/topics`,
		handler: async (req, res) => {
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			if (req.method === 'GET') {
				return sendJson(res, 200, { ok: true, topics: exam.listTopics(50) });
			}
			if (req.method !== 'POST') return fail(res, 405, '只接受 GET / POST');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			try {
				const topic = exam.saveTopic({
					kbId: String(body.value.kbId ?? ''),
					docIds: Array.isArray(body.value.docIds) ? body.value.docIds.map(String) : [],
					objective: String(body.value.objective ?? ''),
					outline: Array.isArray(body.value.outline) ? body.value.outline : [],
					blueprint: Array.isArray(body.value.blueprint) ? body.value.blueprint : [],
					totalTurns: body.value.totalTurns,
				});
				return sendJson(res, 200, { ok: true, topic });
			} catch (error) {
				return fail(res, 400, error.message ?? '保存学习主题失败', error.code);
			}
		},
	});

	// ── 删除 ──────────────────────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/topic/delete`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			try {
				return sendJson(res, 200, { ok: true, ...exam.deleteTopic(String(body.value.id ?? '')) });
			} catch (error) {
				return fail(res, 400, error.message ?? '删除失败', error.code);
			}
		},
	});

	// ── 已存主题 → 考官 prompt ────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/topic/prompt`,
		handler: (req, res) => {
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			try {
				const { prompt, topic } = exam.topicPrompt(url.searchParams.get('id') ?? '');
				return sendJson(res, 200, { ok: true, prompt, topic });
			} catch (error) {
				return fail(res, 404, error.message ?? '拿不到 prompt', error.code);
			}
		},
	});

	// ── 选好范围 → 设计 prompt ────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/topic/design-prompt`,
		handler: (req, res) => {
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			try {
				const { prompt } = exam.designPrompt({
					kbId: url.searchParams.get('kbId') ?? '',
					docIds: (url.searchParams.get('docIds') ?? '').split(',').map((item) => item.trim()).filter(Boolean),
				});
				return sendJson(res, 200, { ok: true, prompt });
			} catch (error) {
				return fail(res, 400, error.message ?? '生成 prompt 失败', error.code);
			}
		},
	});

	// ── 对练记录：列表 / 详情 ──────────────────────────────────────────
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/runs`,
		handler: (req, res) => {
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			const topicId = url.searchParams.get('topicId') ?? '';
			if (!topicId) return fail(res, 400, '缺少 topicId');
			try {
				return sendJson(res, 200, { ok: true, runs: exam.listRuns(topicId, 20) });
			} catch (error) {
				return fail(res, 400, error.message ?? '读取对练记录失败', error.code);
			}
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/exam/run`,
		handler: (req, res) => {
			if (!guard(origin(), req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			try {
				const run = exam.getRun(url.searchParams.get('id') ?? '');
				if (!run) return fail(res, 404, '这次对练记录不存在', 'no_run');
				return sendJson(res, 200, { ok: true, run });
			} catch (error) {
				return fail(res, 400, error.message ?? '读取失败', error.code);
			}
		},
	});


	logger?.debug?.(`[knowledge-base] 对练路由：${routes.length} 条`);
	return { routes };
}
