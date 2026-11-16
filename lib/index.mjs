// ============================================================================
// 检索：SQLite FTS5（关键词）+ 可选的向量混合排序（RRF 融合）。
//
// 中文的关键点：FTS5 的 unicode61 不切中文，trigram 又要求查询 ≥3 字。
// 所以入索引前把 CJK 字符逐个用空格隔开（"知识库检索" → " 艾 津 农 药 "），
// 查询串做同样归一化后拼成短语（"农 药"），1-2 字的中文查询也能命中。
// ============================================================================
import { createHash } from 'node:crypto';

const CJK_SOURCE = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const CJK = new RegExp(`[${CJK_SOURCE}]`);
const CJK_RUN = new RegExp(`[${CJK_SOURCE}]+`, 'g');
const CJK_CHAR = new RegExp(`[${CJK_SOURCE}]`, 'g');
const SPLIT_QUERY = /[\s,，、;；:：!?！？()（）[\]{}"'“”‘’]+/;

export function normalizeCjk(text) {
	return String(text ?? '')
		.replace(CJK_CHAR, (char) => ` ${char} `)
		.replace(/\s+/g, ' ')
		.trim();
}

function escapeWord(word) {
	return word.replace(/["*^:(){}[\]]/g, ' ').trim();
}

/** 把用户查询翻成 FTS5 表达式：中文按"字短语"，英文按前缀词，彼此 AND。 */
export function toMatchQuery(query) {
	const parts = [];
	for (const raw of String(query ?? '').split(SPLIT_QUERY)) {
		if (!raw) continue;
		const runs = raw.match(new RegExp(`[${CJK_SOURCE}]+|[^${CJK_SOURCE}]+`, 'g')) ?? [];
		for (const run of runs) {
			if (CJK.test(run)) {
				const chars = [...run].filter((char) => CJK.test(char));
				if (chars.length) parts.push(`"${chars.join(' ')}"`);
				continue;
			}
			for (const word of run.split(/\s+/)) {
				const clean = escapeWord(word);
				if (clean) parts.push(`${clean}*`);
			}
		}
	}
	return [...new Set(parts)].join(' AND ');
}

/** 从原文里截一段带查询词的窗口做摘要（FTS 的 snippet 是归一化文本，不能直接用）。 */
export function makeSnippet(text, query, width = 140) {
	const source = String(text ?? '').replace(/\s+/g, ' ').trim();
	if (!source) return '';
	const lower = source.toLowerCase();
	const words = String(query ?? '')
		.split(SPLIT_QUERY)
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean)
		.sort((left, right) => right.length - left.length);
	let at = -1;
	for (const word of words) {
		at = lower.indexOf(word);
		if (at >= 0) break;
	}
	if (at < 0) return source.slice(0, width) + (source.length > width ? '…' : '');
	const start = Math.max(0, at - Math.floor(width / 3));
	const end = Math.min(source.length, start + width);
	return `${start > 0 ? '…' : ''}${source.slice(start, end)}${end < source.length ? '…' : ''}`;
}

// ── 向量（可选） ──────────────────────────────────────────────────────────
function toBlob(vector) {
	const array = Float32Array.from(vector);
	return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function fromBlob(blob) {
	const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
	return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function cosine(left, right) {
	const length = Math.min(left.length, right.length);
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < length; index += 1) {
		dot += left[index] * right[index];
		leftNorm += left[index] * left[index];
		rightNorm += right[index] * right[index];
	}
	if (!leftNorm || !rightNorm) return 0;
	return dot / Math.sqrt(leftNorm * rightNorm);
}

/** OpenAI 兼容的 embeddings 客户端；未配置或失败时安静降级为纯关键词。 */
export function createEmbedder({ config, logger, apiKey }) {
	const configured = Boolean(config?.enabled);
	const baseUrl = String(config?.baseUrl ?? '').replace(/\/+$/, '');
	const model = String(config?.model ?? '');
	const key = apiKey || process.env.DSH_KB_EMBEDDING_KEY || '';
	const usable = configured && Boolean(baseUrl) && Boolean(model);

	return {
		enabled: usable,
		describe() {
			return {
				configured,
				enabled: usable,
				model,
				missing: usable || !configured ? [] : ['baseUrl', 'model'].filter((field) => !String(config?.[field] ?? '')),
			};
		},
		async embed(texts) {
			if (!usable || !texts.length) return null;
			try {
				const response = await fetch(`${baseUrl}/embeddings`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(key ? { authorization: `Bearer ${key}` } : {}),
					},
					body: JSON.stringify({ model, input: texts }),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = await response.json();
				const vectors = (data?.data ?? []).map((item) => item?.embedding).filter(Array.isArray);
				return vectors.length === texts.length ? vectors : null;
			} catch (error) {
				logger?.warn?.(`[knowledge-base] embedding 失败，本次只写关键词索引：${error instanceof Error ? error.message : String(error)}`);
				return null;
			}
		},
		fingerprint() {
			return createHash('sha1').update(`${baseUrl}|${model}`).digest('hex').slice(0, 12);
		},
	};
}

export function createIndex({ store, embedder }) {
	const { q } = store.raw;

	function deleteChunks(nodeId) {
		const rows = q(`SELECT id FROM chunks WHERE node_id = ?`).all(nodeId);
		const delFts = q(`DELETE FROM chunks_fts WHERE rowid = ?`);
		for (const row of rows) delFts.run(row.id);
		q(`DELETE FROM chunks WHERE node_id = ?`).run(nodeId);
		q(`DELETE FROM chunk_vec WHERE node_id = ?`).run(nodeId);
	}

	function insertChunks({ nodeId, kbId, chunks }) {
		deleteChunks(nodeId);
		const insert = q(`INSERT INTO chunks (node_id, kb_id, ord, heading, page, char_start, char_end, text)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
		const insertFts = q(`INSERT INTO chunks_fts (rowid, cjk, kb_id, node_id) VALUES (?, ?, ?, ?)`);
		for (const chunk of chunks) {
			const result = insert.run(nodeId, kbId, chunk.ord, chunk.heading ?? '', chunk.page ?? null,
				chunk.charStart, chunk.charEnd, chunk.text);
			insertFts.run(Number(result.lastInsertRowid), normalizeCjk(`${chunk.heading ?? ''} ${chunk.text}`), kbId, nodeId);
		}
		return chunks.length;
	}

	async function insertVectors({ nodeId, chunks }) {
		q(`DELETE FROM chunk_vec WHERE node_id = ?`).run(nodeId);
		if (!embedder?.enabled || !chunks.length) return 0;
		const vectors = await embedder.embed(chunks.map((chunk) => `${chunk.heading ?? ''}\n${chunk.text}`.slice(0, 4000)));
		if (!vectors) return 0;
		const insert = q(`INSERT INTO chunk_vec (node_id, ord, dim, vec) VALUES (?, ?, ?, ?)`);
		vectors.forEach((vector, index) => insert.run(nodeId, chunks[index].ord, vector.length, toBlob(vector)));
		return vectors.length;
	}

	function keywordRows({ match, kbIds, limit }) {
		const params = [match];
		let sql = `SELECT rowid AS chunkId, node_id AS nodeId, bm25(chunks_fts) AS rank
			FROM chunks_fts WHERE chunks_fts MATCH ?`;
		if (kbIds.length) {
			sql += ` AND kb_id IN (${kbIds.map(() => '?').join(',')})`;
			params.push(...kbIds);
		}
		sql += ' ORDER BY rank LIMIT ?';
		params.push(limit);
		try {
			return q(sql).all(...params);
		} catch {
			return [];
		}
	}

	function vectorRows(kbIds) {
		let sql = `SELECT v.node_id AS nodeId, c.id AS chunkId, v.vec AS vec
			FROM chunk_vec v JOIN chunks c ON c.node_id = v.node_id AND c.ord = v.ord`;
		const params = [];
		if (kbIds.length) {
			sql += ` WHERE c.kb_id IN (${kbIds.map(() => '?').join(',')})`;
			params.push(...kbIds);
		}
		sql += ' LIMIT 20000';
		return q(sql).all(...params);
	}

	function hydrate(entries, query) {
		if (!entries.length) return [];
		const ids = entries.map((entry) => Number(entry.chunkId));
		const chunkRows = q(`SELECT id, node_id AS nodeId, kb_id AS kbId, ord, heading, page,
			char_start AS charStart, char_end AS charEnd, text FROM chunks
			WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
		const byId = new Map(chunkRows.map((row) => [Number(row.id), row]));
		const nodeIds = [...new Set(chunkRows.map((row) => row.nodeId))];
		const nodes = store.mapNodeByIds(nodeIds);
		const out = [];
		for (const entry of entries) {
			const chunk = byId.get(Number(entry.chunkId));
			if (!chunk) continue;
			const node = nodes.get(chunk.nodeId);
			out.push({
				chunkId: chunk.id,
				nodeId: chunk.nodeId,
				kbId: chunk.kbId,
				ord: chunk.ord,
				heading: chunk.heading ?? '',
				page: chunk.page ?? null,
				charStart: chunk.charStart,
				charEnd: chunk.charEnd,
				text: chunk.text,
				name: node?.name ?? '（已删除）',
				ext: node?.ext ?? '',
				breadcrumb: node ? store.breadcrumb(node.id) : (node?.name ?? ''),
				locator: `知识库 → ${node ? store.breadcrumb(node.id) : '未知'}`,
				snippet: makeSnippet(chunk.text, query),
				score: entry.rrf,
				ftsRank: entry.ftsRank ?? null,
				vecRank: entry.vecRank ?? null,
			});
		}
		return out;
	}

	async function search({ query, kbIds = [], limit = 10, mode = 'keyword' }) {
		const text = String(query ?? '').trim();
		const took = { keyword: 0, vector: 0 };
		if (!text) return { hits: [], mode: 'keyword', total: 0, truncated: false };
		const ids = Array.isArray(kbIds) ? kbIds.filter(Boolean) : [];
		const match = toMatchQuery(text);

		const entries = new Map();
		const ftsRows = match ? keywordRows({ match, kbIds: ids, limit: Math.max(limit * 5, 50) }) : [];
		ftsRows.forEach((row, index) => {
			entries.set(Number(row.chunkId), { chunkId: row.chunkId, nodeId: row.nodeId, ftsRank: index, rrf: 0 });
		});
		took.keyword = ftsRows.length;

		let usedMode = 'keyword';
		if (mode === 'hybrid' && embedder?.enabled) {
			const queryVector = (await embedder.embed([text]))?.[0];
			if (queryVector) {
				const rows = vectorRows(ids);
				const scored = rows
					.map((row) => ({ row, value: cosine(queryVector, fromBlob(row.vec)) }))
					.filter((item) => item.value > 0.2)
					.sort((left, right) => right.value - left.value)
					.slice(0, Math.max(limit * 5, 50));
				scored.forEach((item, index) => {
					const chunkId = Number(item.row.chunkId);
					const existing = entries.get(chunkId);
					if (existing) existing.vecRank = index;
					else entries.set(chunkId, { chunkId, nodeId: item.row.nodeId, vecRank: index, rrf: 0 });
				});
				took.vector = scored.length;
				usedMode = 'hybrid';
			}
		}

		for (const entry of entries.values()) {
			entry.rrf = (entry.ftsRank === undefined ? 0 : 1 / (60 + entry.ftsRank))
				+ (entry.vecRank === undefined ? 0 : 1 / (60 + entry.vecRank));
		}
		const ranked = [...entries.values()].sort((left, right) => right.rrf - left.rrf).slice(0, limit);
		const hits = hydrate(ranked, text);

		// 标题命中加权：文件名里出现查询词，通常比正文偶然命中更相关
		const words = text.toLowerCase().split(/\s+/).filter(Boolean);
		for (const hit of hits) {
			const name = hit.name.toLowerCase();
			if (words.some((word) => name.includes(word.toLowerCase()))) hit.score += 0.4;
		}
		hits.sort((left, right) => right.score - left.score);

		return { hits, mode: usedMode, total: hits.length, truncated: hits.length >= limit, took };
	}

	/** 给"重建索引"用：把所有文档重排一遍。 */
	function resetAll() {
		q(`DELETE FROM chunks_fts`).run();
		q(`DELETE FROM chunks`).run();
		q(`DELETE FROM chunk_vec`).run();
	}

	return {
		insertChunks,
		insertVectors,
		deleteChunks,
		search,
		resetAll,
		normalizeCjk,
	};
}
