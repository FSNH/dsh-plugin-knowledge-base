// ============================================================================
// 图片理解链路测试：起一个假的视觉服务（/chat/completions），
// 验证 上传图片 → 描述成文字 → 分块 → 全文检索命中，以及各种降级。
//
// 不依赖外网、不需要真 key。运行：
//   ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" test/vision.mjs
// ============================================================================
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createEmbedder, createIndex } from '../lib/index.mjs';
import { createPipeline } from '../lib/pipeline.mjs';
import { createVisionClient } from '../lib/vision.mjs';

const failures = [];
function check(name, condition, detail = '') {
	if (condition) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures.push(`${name} ${detail}`);
	console.log(`  FAIL ${name} ${detail}`);
}

// 1x1 PNG（合法图片字节，够假服务"看图"用）
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);

const DESCRIPTION = [
	'【画面】一张培训幻灯片截图，蓝色标题页。',
	'【文字】植保基础知识 虫害防治 2026 年 3 月',
	'【数据】无',
	'【场景】公司内部培训材料',
].join('\n');

// ── 假视觉服务 ────────────────────────────────────────────────────────────
const seen = [];
const server = http.createServer((req, res) => {
	if (req.method !== 'POST' || !String(req.url).startsWith('/v1/chat/completions')) {
		res.writeHead(404, { 'content-type': 'application/json' });
		return res.end('{"error":"not found"}');
	}
	let body = '';
	req.on('data', (chunk) => { body += chunk; });
	req.on('end', () => {
		const payload = JSON.parse(body || '{}');
		const hasImage = JSON.stringify(payload).includes('image_url');
		seen.push({ model: payload.model, hasImage, auth: req.headers.authorization || '' });
		const json = JSON.stringify({
			choices: [{ message: { role: 'assistant', content: DESCRIPTION } }],
		});
		res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
		res.end(json);
	});
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/v1`;
console.log(`mock vision: ${baseUrl}\n`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kb-vision-'));
const store = openStore({ root, logger: { info() {} } });
const embedder = createEmbedder({ config: { enabled: false }, logger: {} });
const index = createIndex({ store, embedder });

const visionConfig = { enabled: true, baseUrl, model: 'qwen-vl-max', apiKey: 'sk-test' };
const vision = createVisionClient({ resolve: () => visionConfig, logger: {} });
const pipeline = createPipeline({ store, index, embedder, vision, logger: { info() {}, warn() {} }, config: {} });

console.log('[1] 客户端本身');
check('启用后 enabled 为真', vision.enabled === true);
check('describe 报出模型名', vision.describe().model === 'qwen-vl-max', JSON.stringify(vision.describe()));

const probe = await vision.probe();
check('测试连接成功', probe.ok === true, JSON.stringify(probe));
check('请求里带了图片', seen[0]?.hasImage === true, JSON.stringify(seen[0]));
check('请求带了鉴权头', String(seen[0]?.auth).startsWith('Bearer '), String(seen[0]?.auth));

console.log('\n[2] 图片进流水线 → 变成可检索的正文');
store.createKb({ id: 'k_img0001', name: '图片测试库', now: Date.now() });
const docId = 'd_img0001';
const filePath = path.join(store.filesDir, `${docId}.png`);
fs.writeFileSync(filePath, PNG);
store.createNode({
	id: docId, kbId: 'k_img0001', parentId: null, kind: 'doc', name: '示例-培训封面.png',
	now: Date.now(), ext: 'png', bytes: PNG.length, filePath, status: 'pending',
});
await pipeline.ingest(docId);

const node = store.getNode(docId);
check('状态变成 ready', node.status === 'ready', JSON.stringify({ status: node.status, error: node.error }));
check('正文写入了描述', (store.getText(docId) || '').includes('虫害防治'), (store.getText(docId) || '').slice(0, 60));
check('切出了检索片段', (store.stats().chunks || 0) > 0, JSON.stringify(store.stats()));

console.log('\n[3] 能按描述里的词搜到这张图');
const hits = await index.search({ query: '虫害防治', limit: 5 });
check('检索命中图片', hits.hits.length > 0, `hits=${hits.hits.length}`);
check('命中的就是这张图', hits.hits[0]?.nodeId === docId, JSON.stringify({ got: hits.hits[0]?.nodeId, want: docId }));
check('片段里带得出描述内容', String(hits.hits[0]?.snippet || '').includes('虫害防治'), String(hits.hits[0]?.snippet || '').slice(0, 60));

console.log('\n[4] 没开图片理解时：不请求视觉接口，也不算失败');
const quiet = [];
const visionOff = createVisionClient({ resolve: () => ({ ...visionConfig, enabled: false }), logger: {} });
const pipelineOff = createPipeline({ store, index, embedder, vision: visionOff, logger: { info() {}, warn() {} }, config: {} });
const docId2 = 'd_img0002';
const filePath2 = path.join(store.filesDir, `${docId2}.png`);
fs.writeFileSync(filePath2, PNG);
store.createNode({
	id: docId2, kbId: 'k_img0001', parentId: null, kind: 'doc', name: '示例-没开功能.png',
	now: Date.now(), ext: 'png', bytes: PNG.length, filePath: filePath2, status: 'pending',
});
const before = seen.length;
await pipelineOff.ingest(docId2);
check('没有发出视觉请求', seen.length === before, `${before} → ${seen.length}`);
check('状态是 ready（可看但没正文）', store.getNode(docId2).status === 'ready', JSON.stringify(store.getNode(docId2)));
void quiet;

console.log('\n[5] 视觉接口报错时留下人能看懂的原因');
const badVision = createVisionClient({
	resolve: () => ({ ...visionConfig, baseUrl: 'http://127.0.0.1:1/v1' }),
	logger: {},
});
const pipelineBad = createPipeline({ store, index, embedder, vision: badVision, logger: { info() {}, warn() {} }, config: {} });
const docId3 = 'd_img0003';
const filePath3 = path.join(store.filesDir, `${docId3}.png`);
fs.writeFileSync(filePath3, PNG);
store.createNode({
	id: docId3, kbId: 'k_img0001', parentId: null, kind: 'doc', name: '示例-接口挂了.png',
	now: Date.now(), ext: 'png', bytes: PNG.length, filePath: filePath3, status: 'pending',
});
await pipelineBad.ingest(docId3);
const failed = store.getNode(docId3);
check('状态标成 failed', failed.status === 'failed', JSON.stringify({ status: failed.status }));
check('错误信息可读', typeof failed.error === 'string' && failed.error.length > 0, String(failed.error));
check('错误里不是英文堆栈', !/at .*\.mjs/.test(String(failed.error)), String(failed.error));

server.close();
store.close();
fs.rmSync(root, { recursive: true, force: true });

if (failures.length) {
	console.log(`\n失败 ${failures.length} 项：`);
	for (const item of failures) console.log(` - ${item}`);
	process.exit(1);
}
console.log('\n全部通过 ✓');
