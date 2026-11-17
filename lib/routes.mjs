// ============================================================================
// Host HTTP 路由（浏览器端只用这一条通道）
//
// 约定：
//   · 所有接口都要求自定义头 x-kb-client: 1（跨站简单请求过不了预检，防 CSRF）
//   · 带 Origin 的请求必须同源
//   · 落盘文件名永远是 <docId>.<ext>，用户文件名只存数据库
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import {
	API_BASE, extOf, filenameFromHeader, guard, newId, nowMs, readBody, sanitizeName,
	sendBytes, sendJson, sendText, clampInt,
} from './util.mjs';
import { MIME_BY_EXT, SUPPORTED_EXTENSIONS, isIndexable } from './extract.mjs';
import { IMAGE_EXTENSIONS } from './preview.mjs';
import { isVisionExtension, createVisionClient, VISION_PRESETS, presetOf } from './vision.mjs';
import { createEmbedder } from './index.mjs';

function fail(res, status, error) {
	return sendJson(res, status, { ok: false, error });
}

function safeOrigin(webServer) {
	try {
		return webServer?.getOrigin?.() ?? '';
	} catch {
		return '';
	}
}

export function createRoutes({ store, index, pipeline, embedder, vision, settings, config, logger, webServer, token, previewer }) {
	const origin = safeOrigin(webServer);
	const maxFileBytes = Number(config?.maxFileBytes) || 64 * 1024 * 1024;

	const capabilities = () => ({
		embedding: embedder?.describe?.() ?? { configured: false, enabled: false, model: '' },
		vision: vision?.describe?.() ?? { configured: false, enabled: false, model: '' },
		officePreview: previewer?.available?.() ?? false,
		maxFileBytes,
		formats: [...SUPPORTED_EXTENSIONS],
	});

	/** 把一个文件直接写给浏览器。 */
	function serveFile(res, filePath, type, { download = false, name = '', cache = 'private, max-age=60' } = {}) {
		let stat;
		try {
			stat = fs.statSync(filePath);
		} catch {
			return fail(res, 404, '文件不见了');
		}
		const headers = {
			'content-type': type,
			'content-length': stat.size,
			'cache-control': cache,
			'content-disposition': download
				? `attachment; filename*=UTF-8''${encodeURIComponent(name || 'file')}`
				: 'inline',
		};
		res.writeHead(200, headers);
		fs.createReadStream(filePath).pipe(res);
		return undefined;
	}

	/** 全库解析进度（重建索引时界面靠它显示进度条）。 */
	function progressOf() {
		const rows = store.raw.q(`SELECT status, COUNT(*) AS n FROM nodes WHERE kind = 'doc' GROUP BY status`).all();
		const counts = { pending: 0, parsing: 0, ready: 0, failed: 0 };
		for (const row of rows) {
			if (row.status in counts) counts[row.status] = Number(row.n);
			else counts.pending += Number(row.n);
		}
		const total = counts.pending + counts.parsing + counts.ready + counts.failed;
		const info = pipeline?.pendingInfo?.() ?? { queued: 0, active: 0, concurrency: 1 };
		return { ...counts, total, done: counts.ready + counts.failed, queued: info.queued, active: info.active };
	}

	function stateBody(kbId) {
		const kbs = store.listKbs();
		const active = kbId || kbs[0]?.id || '';
		return {
			ok: true,
			root: store.root,
			token,
			kbs,
			kbId: active,
			nodes: active ? store.listNodes(active) : [],
			stats: store.stats(),
			progress: progressOf(),
			capabilities: capabilities(),
		};
	}

	async function handleUpload(req, res) {
		const url = new URL(req.url ?? '/', 'http://local');
		const kbId = url.searchParams.get('kb') || '';
		const parentId = url.searchParams.get('parent') || '';
		const kb = kbId ? store.getKb(kbId) : null;
		if (!kb) return fail(res, 400, '知识库不存在');
		const filename = filenameFromHeader(req) || 'file';
		const ext = extOf(filename);
		if (!SUPPORTED_EXTENSIONS.has(ext)) return fail(res, 415, `不支持的文件类型：.${ext || '?'}`);

		const declared = Number(req.headers['content-length']);
		if (Number.isFinite(declared) && declared > maxFileBytes) {
			return fail(res, 413, `文件超过上限（${Math.round(maxFileBytes / 1048576)} MB）`);
		}

		const docId = newId('d');
		const tmpPath = path.join(store.tmpDir, `${docId}.part`);
		const hash = createHash('sha256');
		let size = 0;
		let aborted = false;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > maxFileBytes) aborted = true;
			hash.update(chunk);
		});
		try {
			await streamPipeline(req, createWriteStream(tmpPath));
		} catch (error) {
			try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
			return fail(res, 400, `上传中断：${error instanceof Error ? error.message : String(error)}`);
		}
		if (aborted) {
			try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
			return fail(res, 413, `文件超过上限（${Math.round(maxFileBytes / 1048576)} MB）`);
		}
		if (size === 0) {
			try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
			return fail(res, 400, '文件是空的');
		}

		const finalPath = path.join(store.filesDir, `${docId}.${ext}`);
		fs.renameSync(tmpPath, finalPath);
		// 图片没有文字层，只有在开了「图片理解」时才需要进队列
		const indexed = isIndexable(ext);
		const needsVision = isVisionExtension(ext) && Boolean(vision?.enabled);
		const indexable = indexed || needsVision;
		const node = store.createNode({
			id: docId,
			kbId,
			parentId: parentId || null,
			kind: 'doc',
			name: sanitizeName(filename, `未命名.${ext}`),
			now: nowMs(),
			ext,
			mime: MIME_BY_EXT[ext] ?? 'application/octet-stream',
			bytes: size,
			filePath: finalPath,
			status: indexable ? 'pending' : 'ready',
		});
		store.raw.q(`UPDATE nodes SET sha256 = ? WHERE id = ?`).run(hash.digest('hex'), docId);
		if (indexable && pipeline) pipeline.enqueue(docId);
		// Office 文件先把原版式预览排在后台（失败不影响上传本身）
		if (previewer?.supports?.(ext) && previewer.available?.()) {
			previewer.ensure(node, { priority: 'background' })
				.catch((error) => logger?.warn?.(`[knowledge-base] preview prewarm failed for ${filename}: ${error?.message || error}`));
		}
		return sendJson(res, 200, {
			ok: true,
			node: store.getNode(docId),
			indexable,
			notice: indexable ? '' : '这是一张图片，只做预览，不进正文索引。',
		});
	}

	const routes = [];

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/state`,
		handler: (req, res) => {
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			return sendJson(res, 200, stateBody(url.searchParams.get('kb') || ''));
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/node`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			const { action } = body.value;
			const now = nowMs();
			try {
				if (action === 'create-kb') {
					const kb = store.createKb({ id: newId('k'), name: sanitizeName(body.value.name, '新知识库'), now });
					return sendJson(res, 200, { ...stateBody(kb.id), created: kb });
				}
				if (action === 'rename-kb') {
					store.renameKb(String(body.value.id), sanitizeName(body.value.name, '知识库'), now);
					return sendJson(res, 200, stateBody(String(body.value.id)));
				}
				if (action === 'delete-kb') {
					store.deleteKb(String(body.value.id));
					return sendJson(res, 200, stateBody(''));
				}
				if (action === 'create') {
					const kbId = String(body.value.kbId ?? '');
					const parentId = body.value.parentId ? String(body.value.parentId) : null;
					const kind = body.value.kind === 'folder' ? 'folder' : 'doc';
					const node = store.createNode({
						id: newId(kind === 'folder' ? 'f' : 'd'),
						kbId,
						parentId,
						kind,
						name: sanitizeName(body.value.name, kind === 'folder' ? '新建文件夹' : '新建文档'),
						now,
						status: 'ready',
					});
					return sendJson(res, 200, { ok: true, node, nodes: store.listNodes(kbId) });
				}
				if (action === 'rename') {
					const node = store.getNode(String(body.value.id));
					if (!node) return fail(res, 404, '节点不存在');
					store.renameNode(node.id, sanitizeName(body.value.name, node.name), now);
					return sendJson(res, 200, { ok: true, nodes: store.listNodes(node.kbId) });
				}
				if (action === 'move') {
					const node = store.getNode(String(body.value.id));
					if (!node) return fail(res, 404, '节点不存在');
					store.moveNode(node.id, body.value.parentId ? String(body.value.parentId) : null,
						Number(body.value.index), now);
					return sendJson(res, 200, { ok: true, nodes: store.listNodes(node.kbId) });
				}
				if (action === 'delete') {
					const node = store.getNode(String(body.value.id));
					if (!node) return fail(res, 404, '节点不存在');
					const result = store.deleteNode(node.id);
					return sendJson(res, 200, { ok: true, removed: result.removed, nodes: store.listNodes(node.kbId) });
				}
				return fail(res, 400, `未知操作 ${action}`);
			} catch (error) {
				logger?.warn?.(`[knowledge-base] node action ${action} failed: ${error instanceof Error ? error.message : String(error)}`);
				return fail(res, 400, error instanceof Error ? error.message : '操作失败');
			}
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/upload`,
		handler: (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			return handleUpload(req, res).catch((error) => {
				logger?.error?.('[knowledge-base] upload failed', error);
				if (!res.headersSent) fail(res, 500, '上传失败');
			});
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/search`,
		handler: async (req, res) => {
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			const url = new URL(req.url ?? '/', 'http://local');
			const query = (url.searchParams.get('q') ?? '').trim();
			const kb = url.searchParams.get('kb') ?? '';
			const mode = url.searchParams.get('mode') === 'hybrid' ? 'hybrid' : 'keyword';
			const limit = clampInt(url.searchParams.get('limit'), 1, 50, 20);
			if (!query) return sendJson(res, 200, { ok: true, hits: [], mode, total: 0 });
			try {
				const result = await index.search({ query, kbIds: kb ? [kb] : [], limit, mode });
				return sendJson(res, 200, { ok: true, ...result });
			} catch (error) {
				return fail(res, 500, `检索失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/dashboard`,
		handler: (req, res) => {
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			try {
				const data = store.dashboard(nowMs());
				return sendJson(res, 200, { ok: true, ...data, capabilities: capabilities() });
			} catch (error) {
				return fail(res, 500, `读取统计失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/settings`,
		handler: async (req, res) => {
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			const snapshot = () => {
				const visionView = settings.publicVision(config?.vision);
				return {
					ok: true,
					embedding: settings.publicEmbedding(config?.embedding),
					vision: { ...visionView, preset: presetOf(visionView.baseUrl) },
					visionPresets: VISION_PRESETS,
					status: embedder.describe(),
					visionStatus: vision?.describe?.() ?? { configured: false, enabled: false, model: '' },
					stats: store.stats(),
				};
			};
			if (req.method === 'GET') return sendJson(res, 200, snapshot());
			if (req.method !== 'POST') return fail(res, 405, '只接受 GET / POST');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			const value = body.value && typeof body.value === 'object' ? body.value : {};
			// 支持 { embedding: {...} } / { vision: {...} }；也兼容老的「直接把字段放在顶层」
			const jobs = [];
			if (value.embedding && typeof value.embedding === 'object') jobs.push(['embedding', value.embedding]);
			if (value.vision && typeof value.vision === 'object') jobs.push(['vision', value.vision]);
			if (!jobs.length) jobs.push(['embedding', value]);

			for (const [section, patch] of jobs) {
				if (patch.enabled) {
					const baseUrl = String(patch.baseUrl ?? '').trim();
					if (!/^https?:\/\//i.test(baseUrl)) return fail(res, 400, '接口地址要以 http:// 或 https:// 开头');
					if (!String(patch.model ?? '').trim()) return fail(res, 400, '要填模型名');
				}
				const saved = section === 'vision' ? settings.saveVision(patch) : settings.saveEmbedding(patch);
				if (!saved.ok) return fail(res, 500, '写入设置失败，检查一下磁盘权限');
			}
			return sendJson(res, 200, snapshot());
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/vision-test`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			const form = body.value && typeof body.value === 'object' ? body.value : {};
			// 用表单里正在填的值测，不必先保存
			const saved = settings.vision();
			// 图片理解常和向量检索同一个服务商：没单独填 key 就复用嵌入那把
			const fallbackKey = settings.embedding().apiKey || process.env.DSH_KB_EMBEDDING_KEY || '';
			const probeClient = createVisionClient({
				resolve: () => ({
					enabled: true,
					baseUrl: typeof form.baseUrl === 'string' && form.baseUrl.trim() ? form.baseUrl : saved.baseUrl,
					model: typeof form.model === 'string' && form.model.trim() ? form.model : saved.model,
					apiKey: (typeof form.apiKey === 'string' && form.apiKey.trim()) ? form.apiKey.trim() : (saved.apiKey || fallbackKey),
				}),
				logger,
			});
			try {
				return sendJson(res, 200, { ok: true, probe: await probeClient.probe() });
			} catch (error) {
				return sendJson(res, 200, { ok: true, probe: { ok: false, error: error instanceof Error ? error.message : String(error) } });
			}
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/embedding-test`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			const form = body.value && typeof body.value === 'object' ? body.value : {};
			// 用「表单里正在填的值」测，不必先保存；key 没填就沿用已保存的
			const saved = settings.embedding();
			const probe = createEmbedder({
				config: {
					enabled: true,
					baseUrl: typeof form.baseUrl === 'string' ? form.baseUrl : saved.baseUrl,
					model: typeof form.model === 'string' ? form.model : saved.model,
					apiKey: (typeof form.apiKey === 'string' && form.apiKey.trim()) ? form.apiKey.trim() : saved.apiKey,
				},
				logger,
			});
			try {
				const result = await probe.probe();
				// 探测失败也走 200：外层 ok 表示"请求处理成功"，probe.ok 表示"接口通不通"
				return sendJson(res, 200, { ok: true, probe: result });
			} catch (error) {
				return sendJson(res, 200, { ok: true, probe: { ok: false, error: error instanceof Error ? error.message : String(error) } });
			}
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/purge-previews`,
		handler: (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			let cleared = 0;
			for (const row of store.raw.q(`SELECT id FROM nodes WHERE kind = 'doc'`).all()) {
				const node = store.getNode(row.id);
				if (node && previewer?.supports?.(node.ext)) {
					previewer.invalidate(node);
					cleared += 1;
				}
			}
			return sendJson(res, 200, { ok: true, cleared });
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/reindex-all`,
		handler: (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			const count = pipeline.reindexAll();
			return sendJson(res, 200, { ok: true, queued: count });
		},
	});

	routes.push({
		kind: 'exact',
		path: `${API_BASE}/ask`,
		handler: async (req, res) => {
			if (req.method !== 'POST') return fail(res, 405, '只接受 POST');
			if (!guard(origin, req).ok) return fail(res, 403, 'forbidden');
			const body = await readBody(req);
			if (!body.ok) return fail(res, 400, '请求体不是合法 JSON');
			const nodeId = String(body.value.docId ?? '');
			const question = typeof body.value.question === 'string' ? body.value.question.trim() : '';
			const node = nodeId ? store.getNode(nodeId) : null;
			if (node && node.kind === 'doc') {
				const crumb = store.breadcrumb(node.id);
				const prompt = [
					'请基于我的个人知识库回答。',
					`文档：《${node.name}》（${crumb}）`,
					`docId: ${node.id}`,
					'先用 kb_read 读这篇文档里相关的部分（必要时用 kb_search 定位），再回答；',
					'回答里标注出处（文件名 + 章节或页码），不要编造文档里没有的内容。',
					question ? `\n我的问题：${question}` : '\n我的问题：',
				].join('\n');
				return sendJson(res, 200, { ok: true, prompt });
			}
			const kbId = String(body.value.kbId ?? '');
			const kb = kbId ? store.getKb(kbId) : null;
			const prompt = [
				kb ? `请基于我的个人知识库「${kb.name}」回答。` : '请基于我的个人知识库回答。',
				kb ? `kbId: ${kb.id}（在 kb_search 的 kbIds 里传它）` : '先用 kb_list 看看有哪些知识库。',
				'先用 kb_search 检索，再用 kb_read 读片段周围的正文，然后回答；标注出处，不要编造。',
				question ? `\n我的问题：${question}` : '\n我的问题：',
			].join('\n');
			return sendJson(res, 200, { ok: true, prompt });
		},
	});

	// ── /doc?id=<id>&action=meta|text|raw|preview|reindex ─────────────────
	// 说明：这一版 webServer 的前缀路由没有接管 /api 下的自定义前缀（会落到 API
	// 网关并拿到 401），所以文档相关操作统一走一条 exact 路由 + 查询参数。
	routes.push({
		kind: 'exact',
		path: `${API_BASE}/doc`,
		handler: async (req, res) => {
			const url = new URL(req.url ?? '/', 'http://local');
			const action = url.searchParams.get('action') ?? '';
			const id = url.searchParams.get('id') ?? '';
			// 二进制预览要能被 <img>/<iframe> 直接取，而它们带不了自定义头：
			// 这时改用一次性启动令牌（令牌只通过需要自定义头的 /state 下发）。
			const byToken = (action === 'raw' || action === 'preview' || action === 'page' || action === 'thumb')
				&& Boolean(token) && url.searchParams.get('t') === token;
			if (!byToken && !guard(origin, req).ok) return fail(res, 403, 'forbidden');
			const node = id ? store.getNode(id) : null;
			if (!node || node.kind !== 'doc') return fail(res, 404, '文档不存在');

			if (action === 'text') {
				const offset = clampInt(url.searchParams.get('offset'), 0, 100 * 1024 * 1024, 0);
				const limit = clampInt(url.searchParams.get('limit'), 200, 40000, 8000);
				const full = store.getText(node.id);
				const end = Math.min(full.length, offset + limit);
				return sendJson(res, 200, {
					ok: true,
					node,
					breadcrumb: store.breadcrumb(node.id),
					totalChars: full.length,
					offset,
					end,
					text: full.slice(offset, end),
					hasMore: end < full.length,
				});
			}

			if (action === 'raw') {
				const filePath = store.raw.q(`SELECT file_path AS filePath FROM nodes WHERE id = ?`).get(node.id)?.filePath;
				if (!filePath || !fs.existsSync(filePath)) return fail(res, 404, '原始文件不见了');
				const download = url.searchParams.get('download') === '1';
				return serveFile(res, filePath, node.mime || 'application/octet-stream', {
					download,
					name: node.name,
					cache: 'private, max-age=60',
				});
			}

			// 逐页图片：界面自己画阅读器（不起浏览器 PDF 阅读器）
			if (action === 'previewinfo') {
				if (!previewer?.supports?.(node.ext)) return fail(res, 400, '这类文件没有逐页预览');
				try {
					const manifest = await previewer.ensurePages(node);
					// 缩略图栏要用的低分辨率版本，顺手在后台准备好
					previewer.ensureThumbs(node).catch(() => { /* 缩略图失败不影响正文 */ });
					return sendJson(res, 200, {
						ok: true,
						pages: manifest.pages,
						pageCount: manifest.pageCount,
						truncated: Boolean(manifest.truncated),
						partial: Boolean(manifest.partial),
						dpi: manifest.dpi,
						width: manifest.width,
						height: manifest.height,
					});
				} catch (error) {
					const code = error?.code === 'unavailable' ? 503 : 500;
					const reason = error instanceof Error ? error.message : String(error);
					logger?.warn?.(`[knowledge-base] page render failed for ${node.name}: ${reason}`);
					return fail(res, code, reason);
				}
			}

			if (action === 'page' || action === 'thumb') {
				if (!previewer?.supports?.(node.ext)) return fail(res, 400, '这类文件没有逐页预览');
				const page = clampInt(url.searchParams.get('n'), 1, 2000, 1);
				const isThumb = action === 'thumb';
				try {
					let file = isThumb ? previewer.thumbFile(node, page) : previewer.pageFile(node, page);
					if (!fs.existsSync(file)) {
						await (isThumb ? previewer.ensureThumbs(node) : previewer.ensurePages(node));
						file = isThumb ? previewer.thumbFile(node, page) : previewer.pageFile(node, page);
					}
					if (!fs.existsSync(file)) return fail(res, 404, `没有第 ${page} 页`);
					return serveFile(res, file, 'image/png', { cache: 'private, max-age=3600' });
				} catch (error) {
					return fail(res, 500, error instanceof Error ? error.message : '渲染失败');
				}
			}

			// 原版式预览：PDF/图片直接给原文件；Office 用宿主的 officeKit 转成 PDF 再看
			if (action === 'preview') {
				if (node.ext === 'pdf' || IMAGE_EXTENSIONS.has(node.ext)) {
					const filePath = store.raw.q(`SELECT file_path AS filePath FROM nodes WHERE id = ?`).get(node.id)?.filePath;
					if (!filePath || !fs.existsSync(filePath)) return fail(res, 404, '原始文件不见了');
					return serveFile(res, filePath, node.mime || 'application/octet-stream', { cache: 'private, max-age=60' });
				}
				if (!previewer?.supports?.(node.ext)) {
					return fail(res, 400, '这类文件没有原版式预览，请用文字阅读');
				}
				try {
					const pdfPath = await previewer.ensure(node, { priority: 'foreground' });
					return serveFile(res, pdfPath, 'application/pdf', { cache: 'no-store' });
				} catch (error) {
					const code = error?.code === 'unavailable' ? 503 : 500;
					const reason = error instanceof Error ? error.message : String(error);
					logger?.warn?.(`[knowledge-base] preview failed for ${node.name}: ${reason}`);
					return fail(res, code, reason);
				}
			}

			if (action === 'reindex' && req.method === 'POST') {
				// 图片在有「图片理解」时也能重建（会重新描述一遍）
				const canIndex = isIndexable(node.ext) || (isVisionExtension(node.ext) && Boolean(vision?.enabled));
				if (!canIndex) {
					return fail(res, 400, isVisionExtension(node.ext)
						? '图片没有正文索引；在设置里打开「图片理解」后可以重建'
						: '这个格式没有正文索引');
				}
				store.setDocStatus(node.id, 'pending', { error: null, updatedAt: nowMs() });
				pipeline.enqueue(node.id);
				return sendJson(res, 200, { ok: true, node: store.getNode(node.id) });
			}

			if (!action || action === 'meta') {
				return sendJson(res, 200, {
					ok: true,
					node,
					breadcrumb: store.breadcrumb(node.id),
					stats: store.stats(),
				});
			}
			return fail(res, 404, '未知的文档操作');
		},
	});

	return { routes, origin };
}

export { API_BASE, sendText, sendBytes, safeOrigin };
