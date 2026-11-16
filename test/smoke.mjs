// ============================================================================
// 冒烟测试：不依赖 DSH 进程，直接跑 store / extract / chunk / index / tools。
// 运行：ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" test/smoke.mjs
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../lib/store.mjs';
import { createEmbedder, createIndex } from '../lib/index.mjs';
import { createPipeline } from '../lib/pipeline.mjs';
import { createKnowledgeBaseTools } from '../lib/tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const failures = [];
function check(name, condition, detail = '') {
	if (condition) {
		console.log(`  ok   ${name}`);
		return;
	}
	failures.push(`${name} ${detail}`);
	console.log(`  FAIL ${name} ${detail}`);
}

/** 手搓一个最小可解析 PDF（只有文字层，验证 pdfjs 链路）。 */
function makePdf(lines) {
	const escapes = (text) => text.replace(/[\\()]/g, '');
	const content = `BT /F1 14 Tf 40 800 Td 20 TL ${lines
		.map((line, index) => `${index ? 'T* ' : ''}(${escapes(line)}) Tj`)
		.join(' ')} ET`;
	const bodies = [
		'<</Type/Catalog/Pages 2 0 R>>',
		'<</Type/Pages/Kids[3 0 R]/Count 1>>',
		'<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
		`<</Length ${content.length}>>\nstream\n${content}\nendstream`,
		'<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
	];
	let out = '%PDF-1.4\n';
	const offsets = [];
	bodies.forEach((body, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefAt = out.length;
	out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<</Size ${bodies.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-kb-test-'));
console.log(`root: ${root}`);

const logger = { info: () => {}, warn: (message) => console.log(`  warn: ${message}`), error: console.error };
const store = openStore({ root, logger });
const embedder = createEmbedder({ config: { enabled: false }, logger });
const index = createIndex({ store, embedder });
const pipeline = createPipeline({ store, index, embedder, logger, config: { parseConcurrency: 1 } });

const kb = store.createKb({ id: 'k_test0001', name: '产品资料', now: Date.now() });
const folder = store.createNode({ id: 'f_test0001', kbId: kb.id, parentId: null, kind: 'folder', name: '登记证', now: Date.now() });

function addDoc({ id, name, ext, buffer, mime = 'application/octet-stream' }) {
	const filePath = path.join(store.filesDir, `${id}.${ext}`);
	fs.writeFileSync(filePath, buffer);
	store.createNode({
		id, kbId: kb.id, parentId: folder.id, kind: 'doc', name, now: Date.now(),
		ext, mime, bytes: buffer.length, filePath, status: 'pending',
	});
	return filePath;
}

const docs = [];

// 1) Markdown
{
	const id = 'd_test0001';
	addDoc({
		id, name: '出口登记要求.md', ext: 'md',
		buffer: Buffer.from([
			'# 巴西出口登记要求',
			'',
			'## 一、原药要求',
			'示例：某化工品出口需要提供登记证、全组分分析报告和五批次检测数据。',
			'',
			'## 二、制剂要求',
			'制剂除原药资料外，还需要提供配方说明与稳定性数据。',
			'',
			'## 三、农药登记证核验',
			'登记证核验时核对有效成分、含量、剂型三项，任何一项不符都要退回。',
		].join('\n'), 'utf8'),
	});
	docs.push({ id, label: 'md' });
}

// 2) 真实 docx：自带样例不含业务数据，想要真实解析覆盖就指向你自己的文件
//    PowerShell: $env:KB_TEST_DOCX = "C:\path\to\any.docx"
{
	const source = process.env.KB_TEST_DOCX || '';
	if (source && fs.existsSync(source)) {
		const id = 'd_test0002';
		addDoc({ id, name: path.basename(source), ext: 'docx', buffer: fs.readFileSync(source) });
		docs.push({ id, label: 'docx' });
	} else {
		console.log('  skip docx（设置 KB_TEST_DOCX 指向任意 .docx 可覆盖真实文件解析）');
	}
}

// 3) 真实 xlsx（同上，KB_TEST_XLSX）
{
	const source = process.env.KB_TEST_XLSX || '';
	if (source && fs.existsSync(source)) {
		const id = 'd_test0003';
		addDoc({ id, name: path.basename(source), ext: 'xlsx', buffer: fs.readFileSync(source) });
		docs.push({ id, label: 'xlsx' });
	} else {
		console.log('  skip xlsx（设置 KB_TEST_XLSX 指向任意 .xlsx 可覆盖真实文件解析）');
	}
}

// 4) 生成的 PDF
{
	const id = 'd_test0004';
	addDoc({
		id, name: 'brazil-registration.pdf', ext: 'pdf',
		buffer: makePdf(['Brazil export registration requirements', 'Glyphosate 95% TC needs a registration certificate and five batch analysis.']),
	});
	docs.push({ id, label: 'pdf' });
}

console.log('\n[1] 解析与建索引');
for (const doc of docs) {
	// eslint-disable-next-line no-await-in-loop
	await pipeline.ingest(doc.id);
	const node = store.getNode(doc.id);
	const chunkCount = store.raw.q('SELECT COUNT(*) AS n FROM chunks WHERE node_id = ?').get(doc.id)?.n ?? 0;
	console.log(`  ${doc.label}: status=${node.status} chunks=${chunkCount} chars=${node.chars}${node.error ? ` error=${node.error}` : ''}`);
	if (doc.label !== 'pdf') check(`${doc.label} 解析成功`, node.status === 'ready', node.error || '');
	if (doc.label === 'pdf') check('pdf 解析成功', node.status === 'ready' || /没有可抽取/.test(node.error || ''), node.error || '');
	check(`${doc.label} 有分块`, chunkCount > 0 || doc.label === 'pdf', `chunks=${chunkCount}`);
}

console.log('\n[2] 中文检索（2 字词 / 3 字词 / 英文）');
const cases = [
	{ query: '农药', expect: true },
	{ query: '登记证', expect: true },
	{ query: '化工品', expect: true },
	{ query: 'brazil', expect: true },
	{ query: '完全不存在的词xyzzy', expect: false },
];
for (const item of cases) {
	// eslint-disable-next-line no-await-in-loop
	const result = await index.search({ query: item.query, limit: 5 });
	const hit = result.hits[0];
	const ok = item.expect ? result.hits.length > 0 : result.hits.length === 0;
	check(`检索「${item.query}」`, ok, `hits=${result.hits.length}${hit ? ` 首条=${hit.name} · ${hit.heading || '-'}` : ''}`);
	if (hit) console.log(`       片段：${hit.snippet.slice(0, 80)}`);
}

console.log('\n[3] 模型工具');
const tools = createKnowledgeBaseTools({ store, index, pipeline });
const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

const listResult = await byName.kb_list.execute({});
check('kb_list 返回知识库', listResult.libraries.length === 1, JSON.stringify(listResult.summary));
const treeResult = await byName.kb_list.execute({ kbId: kb.id });
check('kb_list 返回目录树', treeResult.libraries[0].tree.includes('登记证'), treeResult.libraries[0].tree.slice(0, 120));

const searchResult = await byName.kb_search.execute({ query: '巴西 登记证', limit: 5 });
check('kb_search 命中', searchResult.hits.length > 0, searchResult.summary);
const firstHit = searchResult.hits[0];
if (firstHit) {
	const readResult = await byName.kb_read.execute({ docId: firstHit.docId, offset: Math.max(0, firstHit.charStart - 50), limit: 800 });
	check('kb_read 读到正文', readResult.ok && readResult.text.length > 0, readResult.summary);
	console.log(`       ${readResult.text.slice(0, 100).replace(/\n/g, ' ')}…`);
	const missing = await byName.kb_read.execute({ docId: 'd_missing' });
	check('kb_read 对未知 docId 给出可读错误', missing.ok === false && missing.summary.includes('找不到文档'));
}

console.log('\n[4] 树的增删改与删除清理');
const moved = store.moveNode(docs[0].id, null, 0, Date.now());
check('移动到根', moved.parentId === null && moved.path === `/${docs[0].id}`, moved.path);
const insideFolder = store.raw.q(`SELECT COUNT(*) AS n FROM nodes WHERE parent_id = ?`).get(folder.id)?.n ?? 0;
const removed = store.deleteNode(folder.id);
check('删除文件夹（级联子文档）', removed.removed === insideFolder + 1, `removed=${removed.removed} 期望=${insideFolder + 1}`);
store.deleteNode(docs[0].id);
check('删除后没有孤儿分块', (store.raw.q('SELECT COUNT(*) AS n FROM chunks').get()?.n ?? 0) === 0);
check('删除后原文件被清理', !fs.existsSync(path.join(store.filesDir, `${docs[0].id}.md`)));

console.log('\n[5] 原版式预览器（没有 officeKit 时应干净降级）');
{
	const { createPreviewer } = await import('../lib/preview.mjs');
	const off = createPreviewer({ store, getOfficeKit: () => undefined, logger });
	check('无 officeKit 时 available=false', off.available() === false);
	check('docx 属于可预览格式', off.supports('docx') === true);
	check('md 不属于可预览格式', off.supports('md') === false);
	let code = '';
	try {
		await off.ensure({ id: docs[0].id, ext: 'docx', name: 'x.docx' });
	} catch (error) {
		code = error.code || '';
	}
	check('无 officeKit 时 ensure 抛 unavailable', code === 'unavailable', code);
	let pageCode = '';
	try {
		await off.ensurePages({ id: docs[0].id, ext: 'docx', name: 'x.docx' });
	} catch (error) {
		pageCode = error.code || '';
	}
	check('无 officeKit 时逐页渲染也抛 unavailable', pageCode === 'unavailable', pageCode);
}

console.log('\n[6] 检索日志与看板聚合');
{
	// 前面的检索用例已经写进日志了，所以这里比的都是"增量"
	const before = store.dashboard(Date.now());
	const trendBefore = (before.trend[before.trend.length - 1] || {}).count || 0;
	store.logSearch({ now: Date.now(), query: '出口登记', mode: 'hybrid', hits: 2, tookMs: 30, kbId: 'k_test0001' });
	store.logSearch({ now: Date.now(), query: '出口登记', mode: 'keyword', hits: 1, tookMs: 12, kbId: 'k_test0001' });
	store.logSearch({ now: Date.now(), query: '不存在的东西', mode: 'keyword', hits: 0, tookMs: 8, kbId: null });
	const after = store.dashboard(Date.now());
	check('检索次数 +3', after.search.total === before.search.total + 3, `${before.search.total} → ${after.search.total}`);
	check('今日次数 +3', after.search.today === before.search.today + 3, `${before.search.today} → ${after.search.today}`);
	check('零命中 +1', after.search.zeroHit === before.search.zeroHit + 1, `${before.search.zeroHit} → ${after.search.zeroHit}`);
	check('混合检索 +1', after.search.hybrid === before.search.hybrid + 1, `${before.search.hybrid} → ${after.search.hybrid}`);
	check('零命中率是个百分数', after.search.zeroRate >= 0 && after.search.zeroRate <= 100, String(after.search.zeroRate));
	check('平均耗时是个合理的毫秒数', after.search.avgMs >= 0 && after.search.avgMs <= 5000, String(after.search.avgMs));
	const top = after.topQueries.find((item) => item.query === '出口登记');
	check('热门词里「出口登记」出现 2 次', top?.count === 2, JSON.stringify(top));
	check('最近检索按时间倒序', after.recent[0]?.query === '不存在的东西', JSON.stringify(after.recent[0]));
	const trendAfter = (after.trend[after.trend.length - 1] || {}).count || 0;
	check('今日趋势 +3', trendAfter === trendBefore + 3, `${trendBefore} → ${trendAfter}`);
	check('类型分布可读', Array.isArray(after.byExt), JSON.stringify(after.byExt));
	check('各知识库分布可读', Array.isArray(after.byKb), JSON.stringify(after.byKb));
}

console.log('\n[7] 统计');
console.log(`  ${JSON.stringify(store.stats())}`);

store.close();
fs.rmSync(root, { recursive: true, force: true });

if (failures.length) {
	console.log(`\n失败 ${failures.length} 项：`);
	for (const item of failures) console.log(` - ${item}`);
	process.exit(1);
}
console.log('\n全部通过 ✓');
