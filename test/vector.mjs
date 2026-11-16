// ============================================================================
// 向量检索链路测试：起一个本地「OpenAI 兼容」的 embeddings 服务，
// 验证 createEmbedder → insertVectors → search(mode:'hybrid') 这条路径。
//
// 不依赖外网、不需要真 key，也不碰运行中的 DSH 与真实库。
// 运行：ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" test/vector.mjs
// ============================================================================
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createEmbedder, createIndex } from '../lib/index.mjs';

const failures = [];
function check(name, condition, detail = '') {
	if (condition) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures.push(`${name} ${detail}`);
	console.log(`  FAIL ${name} ${detail}`);
}

const DIM = 16;

/** 可复现的假向量：同样的文本得到同样的向量，不同文本基本不相关。 */
function fakeEmbedding(text) {
	const vector = new Array(DIM).fill(0);
	const source = String(text ?? '');
	for (let index = 0; index < source.length; index += 1) {
		const code = source.charCodeAt(index);
		vector[code % DIM] += ((code * 31) % 97) / 97 - 0.5;
	}
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	return norm ? vector.map((value) => Number((value / norm).toFixed(6))) : new Array(DIM).fill(0);
}

// ── 假 embeddings 服务 ────────────────────────────────────────────────────
const requests = [];
const server = http.createServer((req, res) => {
	if (req.method !== 'POST' || !String(req.url).startsWith('/v1/embeddings')) {
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end('{"error":"not found"}');
		return;
	}
	let body = '';
	req.on('data', (chunk) => { body += chunk; });
	req.on('end', () => {
		let payload = {};
		try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
		const inputs = Array.isArray(payload.input) ? payload.input : [];
		requests.push({ count: inputs.length, model: payload.model, auth: req.headers.authorization || '' });
		const data = inputs.map((text, index) => ({ object: 'embedding', index, embedding: fakeEmbedding(text) }));
		const json = JSON.stringify({ object: 'list', model: payload.model || 'mock', data, usage: { total_tokens: 0 } });
		res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
		res.end(json);
	});
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
console.log(`mock embeddings: http://127.0.0.1:${port}/v1/embeddings\n`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kb-vector-'));
const store = openStore({ root, logger: { info() {} } });
const chunkFixture = [
	'第一章 出口登记要求',
	'化工品出口需要提供登记证、全组分分析报告和五批次检测数据。',
	'第二章 制剂要求',
	'制剂除原药资料外，还需要配方说明与稳定性数据。',
];
store.createKb({ id: 'k_vec0001', name: '向量测试库', now: Date.now() });
store.createNode({ id: 'd_vec0001', kbId: 'k_vec0001', parentId: null, kind: 'doc', name: '示例-登记要求.md', now: Date.now(), ext: 'md', status: 'ready' });
store.saveText('d_vec0001', chunkFixture.join('\n'), Date.now());

console.log('[1] 写入向量');
const embedder = createEmbedder({
	config: { enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-embed' },
	logger: { warn: (message) => console.log(`  warn: ${message}`) },
});
check('embedder 报告已启用', embedder.enabled === true, JSON.stringify(embedder.describe()));

const index = createIndex({ store, embedder });
const chunks = chunkFixture.map((text, ord) => ({
	ord,
	heading: '',
	page: null,
	charStart: 0,
	charEnd: text.length,
	text,
}));
index.insertChunks({ nodeId: 'd_vec0001', kbId: 'k_vec0001', chunks });
const vectorCount = await index.insertVectors({ nodeId: 'd_vec0001', chunks });
check('写入了与分块同数量的向量', vectorCount === chunks.length, `vectors=${vectorCount} chunks=${chunks.length}`);
check('向量落库', (store.stats().vectors || 0) === chunks.length, JSON.stringify(store.stats()));
check('embeddings 接口被真正调用', requests.length >= 1 && requests[0].count === chunks.length, JSON.stringify(requests));
check('请求带了 model 字段', requests[0]?.model === 'mock-embed', String(requests[0]?.model));

console.log('\n[2] 混合检索');
const hybrid = await index.search({ query: '出口登记', limit: 5, mode: 'hybrid' });
check('hybrid 模式生效', hybrid.mode === 'hybrid', hybrid.mode);
check('hybrid 有结果', hybrid.hits.length > 0, `hits=${hybrid.hits.length}`);
if (hybrid.hits[0]) {
	console.log(`       首条：${hybrid.hits[0].snippet.slice(0, 40)}`);
	check('首条带了 fts/vec 名次信息', hybrid.hits[0].ftsRank !== null || hybrid.hits[0].vecRank !== null,
		`fts=${hybrid.hits[0].ftsRank} vec=${hybrid.hits[0].vecRank}`);
}

console.log('\n[3] 关键词模式不受影响');
const keyword = await index.search({ query: '出口登记', limit: 5, mode: 'keyword' });
check('keyword 模式返回 keyword', keyword.mode === 'keyword', keyword.mode);
check('keyword 有结果', keyword.hits.length > 0, `hits=${keyword.hits.length}`);

console.log('\n[4] 接口不可用时降级为关键词');
const brokenEmbedder = createEmbedder({
	config: { enabled: true, baseUrl: 'http://127.0.0.1:1/v1', model: 'nope' },
	logger: { warn() {} },
});
const brokenIndex = createIndex({ store, embedder: brokenEmbedder });
const degraded = await brokenIndex.search({ query: '出口登记', limit: 5, mode: 'hybrid' });
check('接口挂了不抛错', Boolean(degraded));
check('降级成 keyword 模式', degraded.mode === 'keyword', degraded.mode);
check('降级后仍有结果', degraded.hits.length > 0, `hits=${degraded.hits.length}`);

server.close();
store.close();
fs.rmSync(root, { recursive: true, force: true });

if (failures.length) {
	console.log(`\n失败 ${failures.length} 项：`);
	for (const item of failures) console.log(` - ${item}`);
	process.exit(1);
}
console.log('\n全部通过 ✓');
