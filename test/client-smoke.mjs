// ============================================================================
// Client 半部的"能不能渲染出来"冒烟测试（不依赖浏览器）。
//
// 目的：在没有浏览器控制通道的情况下，至少证明
//   1. 模块能按 __ModuleLoader__.load({id, factory}) 的形态注册；
//   2. factory 求值、apply(ctx) 注册三个插槽都不抛错；
//   3. KbPage / DocView / TreeRows / Dialog / SettingsSection 的首次渲染路径
//      不会因为未定义变量、错误的 h() 结构而崩掉。
//
// 用的是一个极简 React 桩：只实现 createElement/useState/useEffect/useRef/useMemo，
// 不做 diff、不跑 effect。它验证的是"代码路径"，不是视觉效果。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../client.js'), 'utf8');
const failures = [];
const check = (name, ok, detail = '') => {
	if (ok) { console.log(`  ok   ${name}`); return; }
	failures.push(`${name} ${detail}`);
	console.log(`  FAIL ${name} ${detail}`);
};

// ── 极简 React 桩 ─────────────────────────────────────────────────────────
const FRAGMENT = Symbol('Fragment');
function createElement(type, props, ...children) {
	return { type, props: { ...(props || {}), children: children.flat(Infinity) } };
}
const React = {
	createElement,
	Fragment: FRAGMENT,
	useState: (initial) => [initial, () => {}],
	useEffect: () => {},
	useRef: (initial) => ({ current: initial }),
	useMemo: (factory) => factory(),
};

// ── 极简 document 桩（installStyles 会用到）─────────────────────────────────
const appended = [];
const document = {
	createElement: () => ({ id: '', textContent: '', remove() {} }),
	head: { appendChild: (node) => appended.push(node) },
};

// ── 捕获 factory ──────────────────────────────────────────────────────────
let captured = null;
const sandbox = {
	window: {
		__ModuleLoader__: {
			load: (definition) => { captured = definition; },
		},
	},
	document,
	console,
	setTimeout,
	clearTimeout,
	URL,
	encodeURIComponent,
	decodeURIComponent,
	Date,
	Math,
	Number,
	String,
	Boolean,
	Array,
	Object,
	JSON,
	Set,
	Map,
	Promise,
	RegExp,
	Error,
	Symbol,
	Float32Array,
	Uint8Array,
	fetch: async () => { throw new Error('渲染路径不应该发请求'); },
};
sandbox.globalThis = sandbox;
sandbox.__DSH_KB_TEST__ = true;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

console.log('\n[1] 模块注册');
check('调用了 __ModuleLoader__.load', Boolean(captured));
check('id 与包名一致', captured?.id === 'dsh-plugin-knowledge-base', String(captured?.id));

const factory = captured?.factory;
check('factory 是函数', typeof factory === 'function');
const mod = factory((name) => {
	if (name === 'react') return React;
	throw new Error(`意外的 require: ${name}`);
});
check('返回 { inject, apply }', typeof mod?.apply === 'function' && Array.isArray(mod?.inject));

console.log('\n[2] apply(ctx) 注册插槽');
const registrations = [];
const disposers = [];
const ctx = {
	get: (name) => (name === 'slots' ? slots : name === 'uiWorkspace' ? { startSession: () => {} } : null),
	effect: (fn) => {
		const dispose = typeof fn === 'function' ? fn() : undefined;
		if (typeof dispose === 'function') disposers.push(dispose);
		return dispose;
	},
	logger: () => ({ info() {}, warn() {}, error() {} }),
};
const slots = {
	inject: (key, callback) => callback(),
	register: (spec, component) => {
		registrations.push({ key: spec.name, spec, component });
		return () => {};
	},
};

try {
	mod.apply(ctx);
	check('apply 不抛错', true);
} catch (error) {
	check('apply 不抛错', false, error.message);
}

const keys = registrations.map((item) => item.key);
check('注册了 sidebar.panellist', keys.includes('sidebar.panellist'), keys.join(','));
check('注册了 main', keys.includes('main'), keys.join(','));
check('注册了 settings.section', keys.includes('settings.section'), keys.join(','));
const panel = registrations.find((item) => item.key === 'sidebar.panellist');
const page = registrations.find((item) => item.key === 'main');
check('panellist.id === main.key', panel?.spec.id === page?.spec.key, `${panel?.spec.id} vs ${page?.spec.key}`);
check('panellist 有 label', typeof panel?.spec.label === 'function' && Boolean(panel.spec.label()));
check('样式已注入', appended.length >= 1, `appended=${appended.length}`);
check('样式只含 --dsw-alias token 或插件自有类名',
	appended[0]?.textContent.includes('--dsw-alias-') && !/\.dsh-kb-[^{]*\{[^}]*font-family:\s*Comic/.test(appended[0].textContent));

// ── 首次渲染 ──────────────────────────────────────────────────────────────
console.log('\n[3] 首次渲染（空库 / 空文档 / 空对话框）');
let rendered = 0;
function walk(node, depth = 0) {
	if (node === null || node === undefined || node === false || node === true) return;
	if (typeof node === 'string' || typeof node === 'number') return;
	if (Array.isArray(node)) { for (const child of node) walk(child, depth); return; }
	if (typeof node.type === 'function') {
		rendered += 1;
		const props = { ...node.props };
		delete props.children;
		walk(node.type(props), depth + 1);
		return;
	}
	walk(node.props?.children, depth + 1);
}

for (const item of registrations) {
	if (!item.component) continue;
	try {
		rendered = 0;
		walk(React.createElement(item.component, item.key === 'main' ? {} : { size: 18, active: true }));
		check(`${item.key} 首次渲染不抛错`, true, `渲染了 ${rendered} 个组件`);
	} catch (error) {
		check(`${item.key} 首次渲染不抛错`, false, error.stack?.split('\n').slice(0, 3).join(' | '));
	}
}

console.log('\n[4] 各种状态的渲染（文档 / PDF / 图片 / 检索 / 对话框）');
const pageRegistration = registrations.find((item) => item.key === 'main');
const internals = mod.__test;
check('暴露了测试入口', Boolean(internals));

function collect(node, out = []) {
	if (node === null || node === undefined || typeof node !== 'object') return out;
	if (Array.isArray(node)) { for (const child of node) collect(child, out); return out; }
	if (typeof node.type === 'function') {
		const props = { ...node.props };
		delete props.children;
		collect(node.type(props), out);
		return out;
	}
	out.push(node);
	collect(node.props?.children, out);
	return out;
}

function renderPage() {
	return collect(React.createElement(pageRegistration.component, {}));
}

const baseNodes = [
	{ id: 'kb1', kbId: 'k1', parentId: null, kind: 'folder', name: '登记证', sort: 0, bytes: 0, status: 'ready', ext: '' },
	{ id: 'd1', kbId: 'k1', parentId: 'kb1', kind: 'doc', name: '出口要求.md', sort: 0, bytes: 390, status: 'ready', ext: 'md', chars: 147, pageCount: 0 },
	{ id: 'd2', kbId: 'k1', parentId: null, kind: 'doc', name: '资料.pdf', sort: 1, bytes: 2048, status: 'ready', ext: 'pdf', chars: 500, pageCount: 3 },
	{ id: 'd3', kbId: 'k1', parentId: null, kind: 'doc', name: '图.png', sort: 2, bytes: 1024, status: 'ready', ext: 'png', chars: 0 },
];
internals.patch({
	loaded: true, loading: false, kbId: 'k1', token: 'tok',
	kbs: [{ id: 'k1', name: '测试库', docs: 3 }],
	nodes: baseNodes,
	stats: { kbs: 1, docs: 3, chunks: 9, bytes: 4096, vectors: 0 },
	caps: { embedding: { configured: false, enabled: false, model: '', missing: [] }, maxFileBytes: 1024, formats: [] },
	root: 'C:\\Users\\test\\.dsh\\kb',
	doc: null,
});

let tree = renderPage();
check('树渲染出 3 行', tree.filter((node) => node.type === 'div' && String(node.props.className).includes('dsh-kb-row')).length >= 3);

internals.patch({ doc: baseNodes[1], docText: '# 标题\n正文一段', docNext: 10, docTotal: 10, docHasMore: false });
tree = renderPage();
check('Markdown 文档走文本阅读器', tree.some((node) => String(node.props?.className).includes('dsh-kb-text')));
check('Markdown 文档没有 iframe', !tree.some((node) => node.type === 'iframe'));
check('正文里标题渲染成 dsh-kb-h', tree.some((node) => String(node.props?.className).includes('dsh-kb-h1')));

internals.patch({ doc: baseNodes[2], docText: '' });
tree = renderPage();
const frame = tree.find((node) => node.type === 'iframe');
check('PDF 走 iframe', Boolean(frame));
check('iframe 地址带令牌与 action=raw', String(frame?.props.src).includes('action=raw') && String(frame.props.src).includes('t=tok'));

internals.patch({ doc: baseNodes[3] });
tree = renderPage();
const image = tree.find((node) => node.type === 'img');
check('图片走 <img>', Boolean(image) && String(image.props.src).includes('action=raw'));

// Office：默认看原版式（转成 PDF 塞进 iframe），可切回文字
internals.patch({
	kbs: [{ id: 'k1', name: '测试库', docs: 3 }],
	nodes: baseNodes,
	doc: { id: 'd4', kbId: 'k1', parentId: null, kind: 'doc', name: '汇报.pptx', sort: 3, bytes: 4096, status: 'ready', ext: 'pptx', chars: 800, pageCount: 12 },
	docText: '# 第 1 页\n内容',
	previewMode: 'visual', previewLoaded: false, previewError: '',
	caps: { embedding: { configured: false, enabled: false, model: '', missing: [] }, officePreview: true, maxFileBytes: 1024, formats: [] },
});
tree = renderPage();
const officeFrame = tree.find((node) => node.type === 'iframe');
check('Office 不再用 iframe（避免浏览器 PDF 阅读器自带缩略图栏）', !officeFrame);
check('渲染中显示提示', tree.some((node) => String(node.props?.className).includes('dsh-kb-pagesLoading')));
check('有「原版式 / 文字」切换', tree.filter((node) => String(node.props?.className).includes('dsh-kb-segBtn')).length === 2);

internals.patch({ previewInfo: { docId: 'd4', pages: 3 }, currentPage: 1, pageMode: 'scroll' });
tree = renderPage();
const pageImgs = tree.filter((node) => node.type === 'img' && String(node.props?.src || '').includes('action=page'));
check('逐页出图 3 张', pageImgs.length === 3, `实际 ${pageImgs.length}`);
check('每页有页码角标', tree.filter((node) => String(node.props?.className).includes('dsh-kb-pageNo')).length === 3);
check('图片懒加载（首屏 2 张 eager）', pageImgs.filter((node) => node.props.loading === 'eager').length === 2);
check('有页码输入框', tree.some((node) => String(node.props?.className).includes('dsh-kb-pageInput')));
check('有缩略图开关 + 上一页/下一页', tree.filter((node) => String(node.props?.className).includes('dsh-kb-navBtn')).length === 3);
check('有连续/单页切换', tree.filter((node) => String(node.props?.className).includes('dsh-kb-segBtn')).length >= 4);
const thumbs = tree.filter((node) => node.type === 'img' && String(node.props?.src || '').includes('action=thumb'));
check('左侧缩略图栏 3 张', thumbs.length === 3, `实际 ${thumbs.length}`);
check('当前页缩略图高亮', tree.filter((node) => String(node.props?.className).includes('dsh-kb-thumb--on')).length === 1);

internals.patch({ thumbsOpen: false });
tree = renderPage();
check('可以收起缩略图栏', !tree.some((node) => String(node.props?.className).includes('dsh-kb-thumbs')));
internals.patch({ thumbsOpen: true });

internals.patch({ pageMode: 'single', currentPage: 2 });
tree = renderPage();
const singleImgs = tree.filter((node) => node.type === 'img' && String(node.props?.src || '').includes('action=page'));
check('单页模式只渲染 1 张图', singleImgs.length === 1, `实际 ${singleImgs.length}`);
check('单页模式显示的是第 2 页', String(singleImgs[0]?.props?.src || '').includes('n=2'));
internals.patch({ pageMode: 'scroll', currentPage: 1 });

internals.patch({ bigView: true, bigMode: 'single', currentPage: 2 });
tree = renderPage();
check('有大屏按钮', tree.some((node) => node.type === 'button' && String(node.props?.children || '').includes('大屏')));
const bigEl = tree.find((node) => String(node.props?.className).includes('dsh-kb-big'));
check('大屏模式渲染覆盖层', Boolean(bigEl));
const bigNodes = bigEl ? collect(bigEl) : [];
check('大屏右上角有「恢复」按钮', bigNodes.some((node) => node.type === 'button' && String(node.props?.children || '').includes('恢复')));
const bigImgs = bigNodes.filter((node) => node.type === 'img' && String(node.props?.src || '').includes('action=page'));
check('大屏默认单页：只渲染 1 张', bigImgs.length === 1, `实际 ${bigImgs.length}`);
check('大屏单页显示的是当前页', String(bigImgs[0]?.props?.src || '').includes('n=2'));
check('大屏有上一页/下一页', bigNodes.filter((node) => String(node.props?.className).includes('dsh-kb-navBtn')).length === 2);
check('大屏有单页/连续切换', bigNodes.filter((node) => String(node.props?.className).includes('dsh-kb-segBtn')).length === 2);
internals.patch({ bigView: false });

internals.patch({ previewMode: 'text' });
tree = renderPage();
check('切到文字后不再有 iframe', !tree.some((node) => node.type === 'iframe'));
check('切到文字后是文本阅读器', tree.some((node) => String(node.props?.className).includes('dsh-kb-text')));

internals.patch({
	caps: { embedding: { configured: false, enabled: false, model: '', missing: [] }, officePreview: false, maxFileBytes: 1024, formats: [] },
	previewMode: 'visual',
	previewInfo: null,
});
tree = renderPage();
check('没有转换服务时提示并回落到文字', tree.some((node) => String(node.props?.children).includes('没启用 Office 转换服务')));
check('没有转换服务时不渲染逐页图片', !tree.some((node) => node.type === 'img' && String(node.props?.src || '').includes('action=page')));

internals.patch({ doc: null, caps: { embedding: { configured: false, enabled: false, model: '', missing: [] }, officePreview: true, maxFileBytes: 1024, formats: [] } });

internals.patch({
	doc: null,
	search: {
		loading: false, mode: 'keyword', ran: true, error: '',
		hits: [{ nodeId: 'd1', chunkId: 1, name: '出口要求.md', ext: 'md', heading: '一、原药要求', snippet: '…化工品…', charStart: 20 }],
	},
	view: 'search', query: '化工品',
});
tree = renderPage();
check('检索结果渲染成列表', tree.some((node) => String(node.props?.className).includes('dsh-kb-hit')));

internals.patch({ view: 'doc', query: '', search: { loading: false, hits: [], mode: 'keyword', ran: false, error: '' } });
internals.askText('新知识库的名字', '我的知识库', () => {});
tree = renderPage();
check('对话框渲染出遮罩', tree.some((node) => String(node.props?.className).includes('dsh-kb-mask')));
check('对话框有输入框', tree.some((node) => typeof node.type === 'string' && node.type === 'input'));
internals.patch({ dialog: null });

internals.patch({ kbs: [], nodes: [], doc: null });
tree = renderPage();
const newKbButtons = tree.filter((node) => node.type === 'button' && String(node.props?.children).includes('新建知识库'));
check('空库时给出「新建知识库」主按钮', newKbButtons.length >= 1);

console.log('\n[5] 目录树：展开/收起、空文件夹、移动');
internals.patch({
	loaded: true, loading: false, kbId: 'k1', token: 'tok',
	kbs: [{ id: 'k1', name: '库', docs: 1 }],
	nodes: [
		{ id: 'f1', kbId: 'k1', parentId: null, kind: 'folder', name: '文件夹A', path: '/f1', sort: 0, bytes: 0, status: 'ready', ext: '' },
		{ id: 'd9', kbId: 'k1', parentId: 'f1', kind: 'doc', name: '子文档.md', path: '/f1/d9', sort: 0, bytes: 10, status: 'ready', ext: 'md', chars: 10 },
	],
	expanded: {}, doc: null, selectedId: '',
});
let t = renderPage();
const rowOf = (name) => t.find((node) => String(node.props?.className || '').includes('dsh-kb-row')
	&& String(node.props?.title || '').startsWith(name));
const folderRow = rowOf('文件夹A');
check('文件夹行存在且可点击', Boolean(folderRow && typeof folderRow.props.onClick === 'function'));
check('文件夹行可拖拽', folderRow?.props.draggable === true);
check('展开时能看到子文档', Boolean(rowOf('子文档')));
folderRow.props.onClick();
check('点一下收起：expanded[f1]=false', internals.state.expanded.f1 === false);
t = renderPage();
check('收起后子文档不再渲染', !rowOf('子文档'));
check('收起后能再点开', typeof rowOf('文件夹A')?.props.onClick === 'function');
rowOf('文件夹A').props.onClick();
t = renderPage();
check('再点一下展开：子文档回来', Boolean(rowOf('子文档')));
check('点击文件夹会选中它（导入落到此处）', internals.state.selectedId === 'f1');

internals.patch({
	nodes: [
		{ id: 'f2', kbId: 'k1', parentId: null, kind: 'folder', name: '空文件夹', path: '/f2', sort: 0, bytes: 0, status: 'ready', ext: '' },
	],
	expanded: {},
});
t = renderPage();
check('空文件夹展开时有提示', t.some((node) => String(node.props?.children || '').includes('空文件夹')));

console.log('\n[6] 文件树栏收起/展开');
internals.patch({
	nodes: [
		{ id: 'd1x', kbId: 'k1', parentId: null, kind: 'doc', name: '收起的文档.md', path: '/d1x', sort: 0, bytes: 10, status: 'ready', ext: 'md', chars: 10 },
	],
	sideOpen: true,
});
let treeCollapsed = renderPage();
check('默认展开：能看到树栏', treeCollapsed.some((node) => String(node.props?.className).includes('dsh-kb-side')));
const toggle = treeCollapsed.find((node) => node.type === 'button' && node.props?.['aria-expanded'] === true);
check('有收起按钮', Boolean(toggle));
toggle.props.onClick();
check('点收起后 sideOpen=false', internals.state.sideOpen === false);
treeCollapsed = renderPage();
check('收起后树栏消失', !treeCollapsed.some((node) => String(node.props?.className).includes('dsh-kb-side')));
const rail = treeCollapsed.find((node) => String(node.props?.className).includes('dsh-kb-rail'));
check('收起后左侧有展开条', Boolean(rail));
rail.props.onClick();
check('点展开条后 sideOpen=true', internals.state.sideOpen === true);

console.log('\n[7] 面板内「知识库设置」');
internals.patch({ showSettings: false, sideOpen: true, selectedId: '', doc: null });
let pane = renderPage();
const gear = pane.find((node) => node.type === 'button' && node.props?.title === '知识库设置');
check('顶部有齿轮按钮', Boolean(gear));
check('有系统设置插槽注册', registrations.some((item) => item.key === 'settings.section'));
gear.props.onClick();
check('点齿轮打开设置', internals.state.showSettings === true);
pane = renderPage();
check('设置面板渲染出来', pane.some((node) => String(node.props?.className).includes('dsh-kb-settingsPane')));
check('设置里有存放目录', pane.some((node) => String(node.props?.children || '').includes('存放目录')));
check('设置里有索引状态', pane.some((node) => String(node.props?.children || '').includes('索引状态')));
const back = pane.find((node) => node.type === 'button' && String(node.props?.children || '').includes('返回'));
check('有返回按钮', Boolean(back));

internals.patch({ progress: { pending: 2, parsing: 1, ready: 3, failed: 0, total: 6, done: 3, queued: 2, active: 1 } });
pane = renderPage();
check('重建时显示进度条', pane.some((node) => String(node.props?.className).includes('dsh-kb-progressTrack')));
check('进度文案带已完成/总数', pane.some((node) => String(node.props?.children?.[0] || '').includes('已完成 3 / 6')
	|| String(node.props?.children || '').includes('已完成 3 / 6')));
internals.patch({ progress: { pending: 0, parsing: 0, ready: 6, failed: 0, total: 6, done: 6, queued: 0, active: 0 } });

back.props.onClick();
check('点返回回到文档区', internals.state.showSettings === false);

console.log('\n[8] 卸载清理');
try {
	for (const dispose of disposers) dispose();
	check('disposer 全部可调用', true);
} catch (error) {
	check('disposer 全部可调用', false, error.message);
}

if (failures.length) {
	console.log(`\n失败 ${failures.length} 项：`);
	for (const item of failures) console.log(` - ${item}`);
	process.exit(1);
}
console.log('\n全部通过 ✓');
