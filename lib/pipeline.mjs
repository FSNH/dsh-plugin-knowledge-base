// ============================================================================
// 解析流水线：抽取 → 渲染正文 → 分块 → 写索引。
//
// 单飞队列（可配并发 1-2）：上传请求立刻返回，解析在后台跑，前端轮询状态。
// 失败一定留下人能看懂的原因（扫描件没有文字层 / 加密 / 格式不支持 …）。
// ============================================================================
import fs from 'node:fs';
import { extract } from './extract.mjs';
import { renderDocument, chunkDocument } from './chunker.mjs';

function friendly(error) {
	const message = error instanceof Error ? error.message : String(error ?? '');
	if (!message) return '解析失败';
	if (/没有可抽取的文字层/.test(message)) return '这个文件没有可抽取的文字层（可能是扫描件或纯图片）';
	if (/已加密/.test(message)) return '文件已加密，无法抽取正文';
	if (/暂不支持/.test(message)) return message;
	if (/过大/.test(message)) return message;
	if (/ENOENT/.test(message)) return '文件不见了（可能被外部删除）';
	return `解析失败：${message.slice(0, 300)}`;
}

export function createPipeline({ store, index, embedder, logger, config, previewer }) {
	const queue = [];
	const queued = new Set();
	let active = 0;
	const concurrency = Math.min(2, Math.max(1, Number(config?.parseConcurrency) || 1));
	const maxFileBytes = Number(config?.maxFileBytes) || 64 * 1024 * 1024;

	function kick() {
		while (active < concurrency && queue.length) {
			const nodeId = queue.shift();
			active += 1;
			ingest(nodeId)
				.catch((error) => logger?.warn?.(`[knowledge-base] ingest ${nodeId} crashed: ${error}`))
				.finally(() => {
					active -= 1;
					queued.delete(nodeId);
					kick();
				});
		}
	}

	function enqueue(nodeId) {
		if (!nodeId || queued.has(nodeId)) return;
		queued.add(nodeId);
		queue.push(nodeId);
		kick();
	}

	async function ingest(nodeId) {
		const node = store.getNode(nodeId);
		if (!node || node.kind !== 'doc') return;
		const filePath = store.raw.q(`SELECT file_path AS filePath FROM nodes WHERE id = ?`).get(nodeId)?.filePath;
		if (!filePath) {
			store.setDocStatus(nodeId, 'failed', { error: '缺少原始文件路径', updatedAt: Date.now() });
			return;
		}
		store.setDocStatus(nodeId, 'parsing', { error: null, updatedAt: Date.now() });
		try {
			const stat = await fs.promises.stat(filePath);
			if (stat.size > maxFileBytes) throw new Error(`文件过大（上限 ${Math.round(maxFileBytes / 1048576)} MB）`);
			const buffer = await fs.promises.readFile(filePath);
			const { blocks, pageCount } = await extract({ ext: node.ext, buffer, filePath });
			const { text, lines } = renderDocument(blocks ?? []);
			const chunks = chunkDocument(lines);

			store.saveText(nodeId, text, Date.now());
			index.insertChunks({ nodeId, kbId: node.kbId, chunks });
			const vectorCount = await index.insertVectors({ nodeId, chunks });
			store.setDocStatus(nodeId, 'ready', {
				error: null,
				pageCount: pageCount ?? 0,
				chars: text.length,
				indexedAt: Date.now(),
				updatedAt: Date.now(),
			});
			logger?.info?.(`[knowledge-base] indexed ${node.name}: ${chunks.length} chunks, ${text.length} chars`
				+ `${vectorCount ? `, ${vectorCount} vectors` : ''}`);
			// Office 文档顺手把原版式预览也生成好（背景优先级，别抢占前台请求）
			if (previewer?.supports?.(node.ext) && previewer.available?.()) {
				previewer.ensure(node, { priority: 'background' })
					.catch((error) => logger?.warn?.(`[knowledge-base] preview prewarm failed for ${node.name}: ${error?.message || error}`));
			}
		} catch (error) {
			logger?.warn?.(`[knowledge-base] parse failed for ${node.name}: ${error instanceof Error ? error.message : String(error)}`);
			store.setDocStatus(nodeId, 'failed', { error: friendly(error), updatedAt: Date.now() });
		}
	}

	/** 启动时把上次没跑完的任务捡回来。 */
	function recover() {
		const rows = store.raw.q(`SELECT id FROM nodes WHERE kind = 'doc' AND status IN ('pending', 'parsing')`).all();
		for (const row of rows) {
			store.setDocStatus(row.id, 'pending', { error: null, updatedAt: Date.now() });
			enqueue(row.id);
		}
		return rows.length;
	}

	function reindexAll() {
		const rows = store.raw.q(`SELECT id FROM nodes WHERE kind = 'doc'`).all();
		index.resetAll();
		for (const row of rows) {
			store.setDocStatus(row.id, 'pending', { error: null, updatedAt: Date.now() });
			enqueue(row.id);
		}
		return rows.length;
	}

	/** 队列现状，给界面显示进度用。 */
	function pendingInfo() {
		return { queued: queue.length, active, concurrency };
	}

	return { enqueue, ingest, recover, reindexAll, concurrency, pendingInfo };
}
