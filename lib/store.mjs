// ============================================================================
// 库存储：SQLite（node:sqlite，随 Node 24 内置，无第三方依赖）
//
// 三张业务表 + 一张全文索引表：
//   kbs      知识库
//   nodes    树：folder / doc 两种节点，adjacency + 物化 id 路径（移动子树只需一次前缀更新）
//   doc_text 文档抽取出的正文（阅读器按字符偏移分页读）
//   chunks   检索分块；chunks_fts 是它的 CJK 归一化全文索引（rowid 对齐 chunks.id）
// ============================================================================
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kbs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  file_path TEXT,
  ext TEXT,
  mime TEXT,
  bytes INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  error TEXT,
  page_count INTEGER,
  chars INTEGER,
  indexed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_by_parent ON nodes(kb_id, parent_id, sort);
CREATE INDEX IF NOT EXISTS nodes_by_path ON nodes(kb_id, path);

CREATE TABLE IF NOT EXISTS doc_text (
  node_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  kb_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  heading TEXT,
  page INTEGER,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_by_doc ON chunks(node_id, ord);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  cjk,
  kb_id UNINDEXED,
  node_id UNINDEXED,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS chunk_vec (
  node_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (node_id, ord)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  query TEXT NOT NULL,
  mode TEXT NOT NULL,
  hits INTEGER NOT NULL,
  took_ms INTEGER NOT NULL,
  kb_id TEXT
);
CREATE INDEX IF NOT EXISTS search_log_by_ts ON search_log(ts);
`;

export function openStore({ root, logger }) {
	const filesDir = path.join(root, 'files');
	const tmpDir = path.join(root, 'tmp');
	fs.mkdirSync(filesDir, { recursive: true });
	fs.mkdirSync(tmpDir, { recursive: true });
	// 上次进程留下的半成品上传与临时文件，启动时清掉
	for (const name of fs.readdirSync(tmpDir)) {
		try { fs.rmSync(path.join(tmpDir, name), { recursive: true, force: true }); } catch { /* ignore */ }
	}

	const db = new DatabaseSync(path.join(root, 'kb.db'));
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA synchronous = NORMAL;');
	db.exec(SCHEMA);

	const q = (sql) => db.prepare(sql);

	// ── 知识库 ────────────────────────────────────────────────────────────
	function listKbs() {
		const rows = q(`SELECT id, name, created_at AS createdAt, updated_at AS updatedAt
			FROM kbs ORDER BY sort, created_at`).all();
		const counts = q(`SELECT kb_id AS kbId, COUNT(*) AS n FROM nodes WHERE kind = 'doc' GROUP BY kb_id`).all();
		const byId = new Map(counts.map((row) => [row.kbId, row.n]));
		return rows.map((row) => ({ ...row, docs: byId.get(row.id) ?? 0 }));
	}

	function getKb(id) {
		return q(`SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM kbs WHERE id = ?`).get(id) ?? null;
	}

	function createKb({ id, name, now }) {
		const sort = (q(`SELECT COALESCE(MAX(sort), -1) AS s FROM kbs`).get()?.s ?? -1) + 1;
		q(`INSERT INTO kbs (id, name, created_at, updated_at, sort) VALUES (?, ?, ?, ?, ?)`).run(id, name, now, now, sort);
		return getKb(id);
	}

	function renameKb(id, name, now) {
		q(`UPDATE kbs SET name = ?, updated_at = ? WHERE id = ?`).run(name, now, id);
		return getKb(id);
	}

	function deleteKb(id) {
		const nodes = q(`SELECT id FROM nodes WHERE kb_id = ?`).all(id).map((row) => row.id);
		for (const nodeId of nodes) removeDocData(nodeId);
		q(`DELETE FROM nodes WHERE kb_id = ?`).run(id);
		q(`DELETE FROM kbs WHERE id = ?`).run(id);
		return { removed: nodes.length };
	}

	// ── 节点 ──────────────────────────────────────────────────────────────
	function nodeRow(row) {
		if (!row) return null;
		return {
			id: row.id,
			kbId: row.kb_id,
			parentId: row.parent_id ?? null,
			kind: row.kind,
			name: row.name,
			path: row.path,
			sort: row.sort,
			ext: row.ext ?? '',
			mime: row.mime ?? '',
			bytes: row.bytes ?? 0,
			status: row.status,
			error: row.error ?? '',
			pageCount: row.page_count ?? 0,
			chars: row.chars ?? 0,
			indexedAt: row.indexed_at ?? 0,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	function getNode(id) {
		return nodeRow(q(`SELECT * FROM nodes WHERE id = ?`).get(id));
	}

	function listNodes(kbId) {
		return q(`SELECT * FROM nodes WHERE kb_id = ? ORDER BY parent_id, sort`).all(kbId).map(nodeRow);
	}

	function children(parentId, kbId) {
		return q(`SELECT * FROM nodes WHERE kb_id = ? AND parent_id IS ? ORDER BY sort`).all(kbId, parentId).map(nodeRow);
	}

	function nextSort(kbId, parentId) {
		const row = q(`SELECT COALESCE(MAX(sort), -1) AS s FROM nodes WHERE kb_id = ? AND parent_id IS ?`).get(kbId, parentId);
		return (row?.s ?? -1) + 1;
	}

	function createNode({ id, kbId, parentId, kind, name, now, ext = '', mime = '', bytes = 0, filePath = null, status = 'ready' }) {
		const parent = parentId ? getNode(parentId) : null;
		if (parentId && (!parent || parent.kbId !== kbId)) throw new Error('父节点不存在');
		const parentPath = parent ? parent.path : '';
		const sort = nextSort(kbId, parentId);
		q(`INSERT INTO nodes (id, kb_id, parent_id, kind, name, path, sort, file_path, ext, mime, bytes, status,
			created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(id, kbId, parentId, kind, name, `${parentPath}/${id}`, sort, filePath, ext, mime, bytes, status, now, now);
		return getNode(id);
	}

	function renameNode(id, name, now) {
		q(`UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?`).run(name, now, id);
		return getNode(id);
	}

	function moveNode(id, parentId, index, now) {
		const node = getNode(id);
		if (!node) throw new Error('节点不存在');
		if (parentId === id) throw new Error('不能移动到自身');
		const target = parentId ? getNode(parentId) : null;
		if (parentId && (!target || target.kbId !== node.kbId)) throw new Error('目标目录不存在');
		if (parentId && (target.path === node.path || target.path.startsWith(`${node.path}/`))) {
			throw new Error('不能移动到自己的子目录');
		}
		const newPath = `${target ? target.path : ''}/${id}`;
		db.exec('BEGIN');
		try {
			q(`UPDATE nodes SET path = replace(path, ?, ?) WHERE kb_id = ? AND (path = ? OR path LIKE ?)`)
				.run(node.path, newPath, node.kbId, node.path, `${node.path}/%`);
			q(`UPDATE nodes SET parent_id = ?, sort = ?, updated_at = ? WHERE id = ?`)
				.run(parentId, 1e9, now, id);
			const siblings = q(`SELECT id FROM nodes WHERE kb_id = ? AND parent_id IS ? AND id <> ? ORDER BY sort`)
				.all(node.kbId, parentId, id).map((row) => row.id);
			const at = Number.isInteger(index) && index >= 0 ? Math.min(index, siblings.length) : siblings.length;
			siblings.splice(at, 0, id);
			const stmt = q(`UPDATE nodes SET sort = ? WHERE id = ?`);
			siblings.forEach((siblingId, position) => stmt.run(position, siblingId));
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
		return getNode(id);
	}

	function subtreeIds(node) {
		const rows = q(`SELECT id, kind FROM nodes WHERE path = ? OR path LIKE ?`).all(node.path, `${node.path}/%`);
		return rows;
	}

	function removeDocData(nodeId) {
		const chunkRows = q(`SELECT id FROM chunks WHERE node_id = ?`).all(nodeId);
		const delFts = q(`DELETE FROM chunks_fts WHERE rowid = ?`);
		for (const row of chunkRows) delFts.run(row.id);
		q(`DELETE FROM chunks WHERE node_id = ?`).run(nodeId);
		q(`DELETE FROM chunk_vec WHERE node_id = ?`).run(nodeId);
		q(`DELETE FROM doc_text WHERE node_id = ?`).run(nodeId);
		const doc = q(`SELECT file_path AS filePath FROM nodes WHERE id = ?`).get(nodeId);
		if (doc?.filePath) {
			try { fs.rmSync(doc.filePath, { force: true }); } catch { /* ignore */ }
		}
		// 转换出来的预览 PDF 也一并清掉
		if (doc?.filePath) {
			try { fs.rmSync(path.join(path.dirname(doc.filePath), `${nodeId}.preview.pdf`), { force: true }); } catch { /* ignore */ }
		}
	}

	function deleteNode(id) {
		const node = getNode(id);
		if (!node) throw new Error('节点不存在');
		const rows = subtreeIds(node);
		db.exec('BEGIN');
		try {
			for (const row of rows) removeDocData(row.id);
			q(`DELETE FROM nodes WHERE id = ?`).run(id);
			const rest = rows.filter((row) => row.id !== id).map((row) => row.id);
			for (const restId of rest) q(`DELETE FROM nodes WHERE id = ?`).run(restId);
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
		return { removed: rows.length };
	}

	function setDocStatus(id, status, extra = {}) {
		q(`UPDATE nodes SET status = ?, error = ?, page_count = ?, chars = ?, indexed_at = ?, updated_at = ?
			WHERE id = ?`).run(
			status,
			extra.error ?? null,
			extra.pageCount ?? null,
			extra.chars ?? null,
			extra.indexedAt ?? null,
			extra.updatedAt ?? Date.now(),
			id,
		);
		return getNode(id);
	}

	function saveText(nodeId, text, now) {		q(`INSERT INTO doc_text (node_id, text, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(node_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`)
			.run(nodeId, text, now);
	}

	function getText(nodeId) {
		const row = q(`SELECT text FROM doc_text WHERE node_id = ?`).get(nodeId);
		return row ? row.text : '';
	}

	function breadcrumb(nodeId) {
		const names = [];
		let current = getNode(nodeId);
		let guardCount = 0;
		while (current && guardCount < 32) {
			names.unshift(current.name);
			current = current.parentId ? getNode(current.parentId) : null;
			guardCount += 1;
		}
		return names.join(' / ');
	}

	function stats() {
		return {
			kbs: q(`SELECT COUNT(*) AS n FROM kbs`).get()?.n ?? 0,
			docs: q(`SELECT COUNT(*) AS n FROM nodes WHERE kind = 'doc'`).get()?.n ?? 0,
			chunks: q(`SELECT COUNT(*) AS n FROM chunks`).get()?.n ?? 0,
			bytes: q(`SELECT COALESCE(SUM(bytes), 0) AS n FROM nodes WHERE kind = 'doc'`).get()?.n ?? 0,
			vectors: q(`SELECT COUNT(*) AS n FROM chunk_vec`).get()?.n ?? 0,
		};
	}

	function mapNodeByIds(ids) {
		const out = new Map();
		const stmt = q(`SELECT * FROM nodes WHERE id = ?`);
		for (const id of ids) {
			const row = stmt.get(id);
			if (row) out.set(id, nodeRow(row));
		}
		return out;
	}

	// ── 检索日志（看板用）──────────────────────────────────────────────────
	const SEARCH_LOG_KEEP = 2000;

	function logSearch({ now, query, mode, hits, tookMs, kbId }) {
		try {
			q(`INSERT INTO search_log (ts, query, mode, hits, took_ms, kb_id) VALUES (?, ?, ?, ?, ?, ?)`)
				.run(now, String(query ?? '').slice(0, 200), String(mode ?? 'keyword'), Number(hits) || 0,
					Number(tookMs) || 0, kbId || null);
			// 只留最近 SEARCH_LOG_KEEP 条，别让日志把库撑大
			q(`DELETE FROM search_log WHERE id <= (SELECT COALESCE(MAX(id), 0) - ? FROM search_log)`).run(SEARCH_LOG_KEEP);
		} catch { /* 埋点失败不能影响检索 */ }
	}

	/** 看板用的聚合：总量、类型分布、状态分布、检索概览、最近活动。 */
	function dashboard(now = Date.now()) {
		const dayStart = new Date(now);
		dayStart.setHours(0, 0, 0, 0);
		const dayStartMs = dayStart.getTime();

		const byExt = q(`SELECT ext, COUNT(*) AS docs, COALESCE(SUM(bytes), 0) AS bytes
			FROM nodes WHERE kind = 'doc' GROUP BY ext ORDER BY docs DESC, bytes DESC`).all()
			.map((row) => ({ ext: row.ext || '?', docs: Number(row.docs), bytes: Number(row.bytes) }));

		const byStatus = { ready: 0, pending: 0, parsing: 0, failed: 0 };
		for (const row of q(`SELECT status, COUNT(*) AS n FROM nodes WHERE kind = 'doc' GROUP BY status`).all()) {
			if (row.status in byStatus) byStatus[row.status] = Number(row.n);
		}

		const byKb = q(`SELECT k.id, k.name, COUNT(n.id) AS docs, COALESCE(SUM(n.bytes), 0) AS bytes
			FROM kbs k LEFT JOIN nodes n ON n.kb_id = k.id AND n.kind = 'doc'
			GROUP BY k.id ORDER BY docs DESC`).all()
			.map((row) => ({ id: row.id, name: row.name, docs: Number(row.docs), bytes: Number(row.bytes) }));

		const search = {
			total: Number(q(`SELECT COUNT(*) AS n FROM search_log`).get()?.n ?? 0),
			today: Number(q(`SELECT COUNT(*) AS n FROM search_log WHERE ts >= ?`).get(dayStartMs)?.n ?? 0),
			zeroHit: Number(q(`SELECT COUNT(*) AS n FROM search_log WHERE hits = 0`).get()?.n ?? 0),
			hybrid: Number(q(`SELECT COUNT(*) AS n FROM search_log WHERE mode = 'hybrid'`).get()?.n ?? 0),
			avgMs: Math.round(Number(q(`SELECT COALESCE(AVG(took_ms), 0) AS n FROM search_log`).get()?.n ?? 0)),
			lastAt: Number(q(`SELECT COALESCE(MAX(ts), 0) AS n FROM search_log`).get()?.n ?? 0),
		};
		search.zeroRate = search.total ? Math.round((search.zeroHit / search.total) * 100) : 0;

		const trend = q(`SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
			FROM search_log GROUP BY day ORDER BY day DESC LIMIT 7`).all()
			.map((row) => ({ day: row.day, count: Number(row.n) }))
			.reverse();

		const topQueries = q(`SELECT query, COUNT(*) AS n FROM search_log
			WHERE length(trim(query)) > 0 GROUP BY lower(trim(query)) ORDER BY n DESC, MAX(ts) DESC LIMIT 8`).all()
			.map((row) => ({ query: row.query, count: Number(row.n) }));

		const recent = q(`SELECT ts, query, mode, hits, took_ms AS tookMs FROM search_log
			ORDER BY id DESC LIMIT 10`).all()
			.map((row) => ({ ts: Number(row.ts), query: row.query, mode: row.mode, hits: Number(row.hits), tookMs: Number(row.tookMs) }));

		const recentDocs = q(`SELECT id, name, ext, bytes, status, created_at AS createdAt, indexed_at AS indexedAt
			FROM nodes WHERE kind = 'doc' ORDER BY created_at DESC LIMIT 6`).all()
			.map((row) => ({
				id: row.id,
				name: row.name,
				ext: row.ext ?? '',
				bytes: Number(row.bytes ?? 0),
				status: row.status,
				createdAt: Number(row.createdAt ?? 0),
				indexedAt: Number(row.indexedAt ?? 0),
			}));

		return {
			now,
			stats: stats(),
			byExt,
			byStatus,
			byKb,
			search,
			trend,
			topQueries,
			recent,
			recentDocs,
			root: root,
		};
	}

	return {
		db,
		root,
		filesDir,
		tmpDir,
		listKbs,
		getKb,
		createKb,
		renameKb,
		deleteKb,
		getNode,
		listNodes,
		children,
		createNode,
		renameNode,
		moveNode,
		deleteNode,
		setDocStatus,
		saveText,
		getText,
		breadcrumb,
		stats,
		mapNodeByIds,
		removeDocData,
		logSearch,
		dashboard,
		close() {
			try { db.close(); } catch { /* ignore */ }
		},
		/** 供 index.mjs 直接使用的表操作。 */
		raw: { q },
	};
}
