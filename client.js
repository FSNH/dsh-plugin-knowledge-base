// ============================================================================
// dsh-plugin-knowledge-base — Client 半部
//
// 三个挂载点：
//   sidebar.panellist  左栏图标（id 必须与 main 的 key 一致）
//   main[key]          知识库主页面：目录树 + 阅读器 + 检索
//   settings.section   「设置 → 知识库」：存放目录、索引统计、重建索引
//
// 浏览器端只认 window.__ModuleLoader__.load({ id, factory })，所以本文件里
// 不能出现 import / export。React 从模块表里拿：require('react')。
// ============================================================================
window.__ModuleLoader__.load({
	id: 'dsh-plugin-knowledge-base',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const API = '/api/kb/v1';
		const PANEL_ID = 'dsh-knowledge-base';
		const TEXT_PAGE = 24000;
		const OFFICE_EXT = ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'];
		const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
		// Chromium PDF 阅读器的参数：适应宽度 + 收起缩略图栏
		const PDF_FRAGMENT = '#view=FitH&navpanes=0';

		// ── 小工具 ──────────────────────────────────────────────────────────
		const cx = (...names) => names.filter(Boolean).join(' ');

		function bytes(value) {
			const number = Number(value) || 0;
			if (number < 1024) return `${number} B`;
			if (number < 1048576) return `${(number / 1024).toFixed(1)} KB`;
			return `${(number / 1048576).toFixed(1)} MB`;
		}

		function when(ms) {
			const value = Number(ms) || 0;
			if (!value) return '';
			const delta = Date.now() - value;
			if (delta < 60000) return '刚刚';
			if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
			if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前`;
			return new Date(value).toLocaleDateString();
		}

		function iconPath(name) {
			return {
				book: ['M4 3.5h6.5A2.5 2.5 0 0 1 13 6v8.5H6.5A2.5 2.5 0 0 0 4 17V3.5Z', 'M4 14.5A2.5 2.5 0 0 1 6.5 12H13'],
				folder: ['M2 5.5h4l1.4 1.8H14v7.2H2V5.5Z'],
				folderOpen: ['M2 5.5h4l1.4 1.8H14v7.2H2V5.5Z', 'M4.4 8.6h10.2'],
				doc: ['M4.5 2.5h5L12 5v9H4.5V2.5Z', 'M9.5 2.5V5H12'],
				search: ['M7.2 11.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Z', 'M10.4 10.4 14 14'],
				plus: ['M8 3.5v9M3.5 8h9'],
				upload: ['M8 11.5V3.5', 'M5 6.2 8 3.2l3 3', 'M3 11.5v2h10v-2'],
				spark: ['M8 2.5v2.6M8 10.9v2.6M2.5 8h2.6M10.9 8h2.6', 'M4.7 4.7l1.8 1.8M9.5 9.5l1.8 1.8M11.3 4.7 9.5 6.5M6.5 9.5l-1.8 1.8'],
				refresh: ['M13 8a5 5 0 1 1-1.5-3.6', 'M13.2 2.6v3h-3'],
				trash: ['M3.5 5h9', 'M6.5 5V3.5h3V5', 'M5 5l.6 8h4.8L11 5'],
				close: ['M3.5 3.5l9 9M12.5 3.5l-9 9'],
				open: ['M9.5 3.5h3v3', 'M12.5 3.5 6 10', 'M11 10.5v2.5H3.5V5.5H6'],
				chevron: ['M6 4.5 9.8 8 6 11.5'],
				check: ['M3.5 8.4l3 3 6-6.4'],
				warn: ['M8 2.6 14 13H2L8 2.6Z', 'M8 6.6v3M8 11.2v.5'],
			}[name] || [];
		}

		function Icon({ name, size = 16, className }) {
			return h('svg', {
				width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
				className, 'aria-hidden': 'true', focusable: 'false',
			}, iconPath(name).map((d, index) => h('path', { key: index, d })));
		}

		// ── 请求 ────────────────────────────────────────────────────────────
		async function api(path, options = {}) {
			const response = await fetch(API + path, {
				...options,
				headers: { 'x-kb-client': '1', ...(options.headers || {}) },
			});
			const type = response.headers.get('content-type') || '';
			if (!type.includes('application/json')) {
				if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
				return null;
			}
			const body = await response.json();
			if (!response.ok || body?.ok === false) throw new Error(body?.error || `请求失败（HTTP ${response.status}）`);
			return body;
		}

		// ── 状态 ────────────────────────────────────────────────────────────
		const state = {
			loaded: false,
			loading: true,
			error: '',
			notice: '',
			busy: '',
			kbs: [],
			kbId: '',
			nodes: [],
			stats: null,
			caps: null,
			root: '',
			token: '',
			view: 'doc',
			expanded: {},
			selectedId: '',
			doc: null,
			docText: '',
			docOffset: 0,
			docNext: 0,
			docTotal: 0,
			docHasMore: false,
			docLoading: false,
			dialog: null,
			query: '',
			search: { loading: false, hits: [], mode: 'keyword', ran: false, error: '' },
			uploading: 0,
			previewMode: 'visual',
			previewLoaded: false,
			previewError: '',
			previewInfo: null,
			currentPage: 1,
			pageMode: 'scroll',
			pageInput: '1',
			thumbsOpen: true,
			bigView: false,
			bigMode: 'single',
			sideOpen: true,
		};

		const listeners = new Set();
		function subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
		function patch(next) {
			Object.assign(state, next);
			for (const listener of [...listeners]) listener();
		}
		function useStore() {
			const [, force] = React.useState(0);
			React.useEffect(() => subscribe(() => force((value) => value + 1)), []);
			return state;
		}

		let pollTimer = null;
		let pollCount = 0;
		function schedulePoll() {
			if (pollTimer) return;
			pollTimer = setTimeout(async () => {
				pollTimer = null;
				const pending = state.nodes.some((node) => node.kind === 'doc' && (node.status === 'pending' || node.status === 'parsing'));
				if (!pending) { pollCount = 0; return; }
				if (pollCount > 40) {
					pollCount = 0;
					patch({ notice: '有文件解析时间较长，可以点文档上的「重新索引」重试。' });
					return;
				}
				pollCount += 1;
				try { await loadState(state.kbId, true); } catch { /* ignore */ }
				if (state.selectedId && state.doc?.id === state.selectedId) await loadDoc(state.selectedId, { quiet: true });
				schedulePoll();
			}, 2000);
		}

		async function loadState(kbId = '', quiet = false) {
			if (!quiet) patch({ loading: true, error: '' });
			try {
				const data = await api(`/state${kbId ? `?kb=${encodeURIComponent(kbId)}` : ''}`);
				const expanded = { ...state.expanded };
				for (const node of data.nodes) if (node.kind === 'folder' && expanded[node.id] === undefined) expanded[node.id] = true;
				patch({
					loaded: true, loading: false, error: '',
					kbs: data.kbs, kbId: data.kbId, nodes: data.nodes,
					stats: data.stats, caps: data.capabilities, root: data.root, token: data.token || '',
					expanded,
				});
				if (state.nodes.some((node) => node.status === 'pending' || node.status === 'parsing')) schedulePoll();
				return data;
			} catch (error) {
				patch({ loading: false, error: error.message || '加载失败' });
				return null;
			}
		}

		async function loadDoc(nodeId, { offset = 0 } = {}) {
			if (!nodeId) return;
			patch({ docLoading: true });
			try {
				const data = await api(`/doc?id=${encodeURIComponent(nodeId)}&action=text&offset=${offset}&limit=${TEXT_PAGE}`);
				const sameDoc = Boolean(state.doc && state.doc.id === data.node.id);
				// 只有"接着上一页"才拼接：偏移必须正好落在上一页的末尾
				const appending = sameDoc && offset > 0 && offset === state.docNext;
				patch({
					selectedId: nodeId,
					view: 'doc',
					doc: data.node,
					docText: appending ? `${state.docText}\n\n${data.text}` : data.text,
					docNext: data.end,
					docTotal: data.totalChars,
					docHasMore: data.hasMore,
					docLoading: false,
					previewLoaded: false,
					previewError: '',
					previewInfo: null,
					currentPage: 1,
					pageInput: '1',
					search: { ...state.search, ran: false },
				});
			} catch (error) {
				patch({ docLoading: false, error: error.message || '读取失败' });
			}
		}

		let searchSeq = 0;
		async function runSearch(query) {
			const text = String(query ?? '').trim();
			patch({ query: text, view: text ? 'search' : 'doc' });
			if (!text) {
				patch({ search: { loading: false, hits: [], mode: 'keyword', ran: false, error: '' } });
				return;
			}
			const seq = ++searchSeq;
			patch({ search: { ...state.search, loading: true, ran: true, error: '' } });
			try {
				const data = await api(`/search?q=${encodeURIComponent(text)}&limit=30${state.kbId ? `&kb=${encodeURIComponent(state.kbId)}` : ''}`);
				if (seq !== searchSeq) return;
				patch({ search: { loading: false, hits: data.hits, mode: data.mode, ran: true, error: '' } });
			} catch (error) {
				if (seq !== searchSeq) return;
				patch({ search: { loading: false, hits: [], mode: 'keyword', ran: true, error: error.message || '检索失败' } });
			}
		}

		async function uploadFiles(fileList, parentId) {
			const files = [...(fileList || [])].filter(Boolean);
			if (!files.length) return;
			if (!state.kbId) {
				patch({ notice: '先新建一个知识库' });
				return;
			}
			patch({ uploading: state.uploading + files.length, notice: '' });
			const failed = [];
			for (const file of files) {
				try {
					// eslint-disable-next-line no-await-in-loop
					await api(`/upload?kb=${encodeURIComponent(state.kbId)}${parentId ? `&parent=${encodeURIComponent(parentId)}` : ''}`, {
						method: 'POST',
						headers: { 'x-kb-filename': encodeURIComponent(file.name) },
						body: file,
					});
				} catch (error) {
					failed.push(`${file.name}：${error.message}`);
				}
				patch({ uploading: Math.max(0, state.uploading - 1) });
			}
			await loadState(state.kbId, true);
			schedulePoll();
			patch({ notice: failed.length ? `有 ${failed.length} 个文件没传上去：${failed.join('；')}` : `已导入 ${files.length} 个文件，正在后台解析` });
		}

		async function nodeAction(action, payload) {
			try {
				const data = await api('/node', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ action, ...payload }),
				});
				if (data && data.nodes) patch({ nodes: data.nodes });
				const nextKb = action === 'create-kb'
					? (data?.created?.id ?? data?.kbId ?? state.kbId)
					: action === 'delete-kb'
						? (data?.kbId ?? '')
						: (payload.kbId || state.kbId);
				await loadState(nextKb || '', true);
				return data;
			} catch (error) {
				patch({ error: error.message || '操作失败' });
				return null;
			}
		}

		// ── 应用内对话框（Electron 渲染进程不提供 window.prompt）──────────────
		function askText(title, value, onOk, okLabel) {
			patch({ dialog: { kind: 'input', title, value: value || '', onOk, okLabel } });
		}
		function askConfirm(title, onOk, okLabel = '删除') {
			patch({ dialog: { kind: 'confirm', title, onOk, okLabel, danger: true } });
		}

		function askMove(node) {
			patch({ dialog: { kind: 'move', nodeId: node.id, title: `把「${node.name}」移动到…` } });
		}

		function Dialog() {
			const current = useStore();
			const dialog = current.dialog;
			const [value, setValue] = React.useState('');
			const inputRef = React.useRef(null);
			React.useEffect(() => {
				if (dialog?.kind === 'input') {
					setValue(dialog.value || '');
					const timer = setTimeout(() => inputRef.current?.focus(), 30);
					return () => clearTimeout(timer);
				}
				return undefined;
			}, [dialog]);
			if (!dialog) return null;
			const close = () => patch({ dialog: null });
			const submit = () => {
				const currentDialog = state.dialog;
				if (!currentDialog) return;
				if (currentDialog.kind === 'input' && !String(value).trim()) return;
				patch({ dialog: null });
				currentDialog.onOk?.(currentDialog.kind === 'input' ? String(value).trim() : true);
			};
			return h('div', {
				className: 'dsh-kb-mask',
				onMouseDown: (event) => { if (event.target === event.currentTarget) close(); },
			},
			h('div', {
				className: 'dsh-kb-modal',
				role: 'dialog',
				'aria-modal': 'true',
				'aria-label': dialog.title,
				onKeyDown: (event) => {
					if (event.key === 'Escape') close();
					if (event.key === 'Enter') submit();
				},
			},
			h('div', { className: 'dsh-kb-modalTitle' }, dialog.title),
			dialog.kind === 'input'
				? h('input', {
					ref: inputRef,
					className: 'dsh-kb-modalInput',
					value,
					onChange: (event) => setValue(event.target.value),
				})
				: null,
			dialog.kind === 'move'
				? h('div', { className: 'dsh-kb-moveList' },
					(() => {
						const moving = state.nodes.find((node) => node.id === dialog.nodeId);
						const usable = state.nodes
							.filter((node) => node.kind === 'folder' && node.id !== dialog.nodeId)
							// 不能把文件夹移进自己或自己的子孙（用物化 path 判断）
							.filter((node) => !moving || !node.path.startsWith(`${moving.path}/`))
							.sort((left, right) => left.path.localeCompare(right.path));
						const depthOf = (node) => Math.max(0, node.path.split('/').length - 2);
						return [
							h('button', {
								type: 'button', key: 'root', className: 'dsh-kb-moveItem',
								onClick: () => {
									const target = dialog.nodeId;
									patch({ dialog: null });
									nodeAction('move', { id: target, parentId: null });
								},
							}, '根目录'),
							...usable.map((folder) => h('button', {
								type: 'button', key: folder.id, className: 'dsh-kb-moveItem',
								style: { paddingLeft: 10 + depthOf(folder) * 14 },
								onClick: () => {
									patch({ dialog: null });
									nodeAction('move', { id: dialog.nodeId, parentId: folder.id });
								},
							}, folder.name)),
						];
					})())
				: null,
			h('div', { className: 'dsh-kb-modalActions' },
				h('button', { type: 'button', className: 'dsh-kb-btn', onClick: close }, '取消'),
				dialog.kind === 'move'
					? null
					: h('button', {
						type: 'button',
						className: cx('dsh-kb-btn', dialog.danger ? 'dsh-kb-btn--dangerSolid' : 'dsh-kb-btn--primary'),
						onClick: submit,
						disabled: dialog.kind === 'input' && !String(value).trim(),
					}, dialog.okLabel || (dialog.kind === 'input' ? '确定' : '删除')))));
		}

		// ── 目录树 ──────────────────────────────────────────────────────────
		function buildTree(nodes) {
			const byParent = new Map();
			for (const node of nodes) {
				const key = node.parentId || '';
				if (!byParent.has(key)) byParent.set(key, []);
				byParent.get(key).push(node);
			}
			for (const list of byParent.values()) list.sort((left, right) => left.sort - right.sort);
			return byParent;
		}

		function statusDot(node) {
			if (node.kind !== 'doc') return null;
			if (node.status === 'failed') return h('span', { className: 'dsh-kb-dot dsh-kb-dot--bad', title: node.error || '解析失败' });
			if (node.status === 'pending' || node.status === 'parsing') return h('span', { className: 'dsh-kb-dot dsh-kb-dot--busy', title: '解析中' });
			return null;
		}

		function TreeRows({ byParent, parentKey, depth }) {
			const current = useStore();
			const list = byParent.get(parentKey) || [];
			return list.map((node) => {
				const isFolder = node.kind === 'folder';
				const open = current.expanded[node.id] !== false;
				const active = current.selectedId === node.id;
				const activate = () => {
					if (isFolder) {
						// 点文件夹 = 选中它（导入/新建就落在这里）+ 展开收起
						patch({ selectedId: node.id, expanded: { ...current.expanded, [node.id]: !open } });
						return;
					}
					loadDoc(node.id);
				};
				return h(React.Fragment, { key: node.id },
					h('div', {
						className: cx('dsh-kb-row', active && 'dsh-kb-row--active'),
						style: { paddingLeft: 6 + depth * 14 },
						role: 'treeitem',
						tabIndex: 0,
						draggable: true,
						'aria-expanded': isFolder ? open : undefined,
						'aria-selected': active,
						onClick: activate,
						onDragStart: (event) => {
							event.dataTransfer.setData('text/kb-node', node.id);
							event.dataTransfer.effectAllowed = 'move';
						},
						onDragOver: isFolder
							? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }
							: undefined,
						onDrop: isFolder
							? (event) => {
								event.preventDefault();
								event.stopPropagation();
								const dragged = event.dataTransfer.getData('text/kb-node');
								if (dragged && dragged !== node.id) nodeAction('move', { id: dragged, parentId: node.id });
							}
							: undefined,
						onKeyDown: (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								activate();
							}
							if (event.key === 'F2') {
								event.preventDefault();
								askText('重命名', node.name, (name) => nodeAction('rename', { id: node.id, name }));
							}
							if (event.key === 'Delete') {
								event.preventDefault();
								askConfirm(`删除「${node.name}」？${isFolder ? '里面的内容也会一起删除。' : '原文件也会被删掉。'}`,
									() => nodeAction('delete', { id: node.id }));
							}
						},
						title: `${node.name}${node.kind === 'doc' ? ` · ${bytes(node.bytes)}` : ''}`,
					},
					h('span', { className: cx('dsh-kb-caret', isFolder && open && 'dsh-kb-caret--open') },
						isFolder ? h(Icon, { name: 'chevron', size: 12 }) : null),
					h('span', { className: 'dsh-kb-rowIcon' }, h(Icon, { name: isFolder ? (open ? 'folderOpen' : 'folder') : 'doc', size: 14 })),
					h('span', { className: 'dsh-kb-rowName' }, node.name),
					statusDot(node),
					h('span', { className: 'dsh-kb-rowActions' },
						h('button', {
							type: 'button', className: 'dsh-kb-rowBtn', title: '移动到…',
							onClick: (event) => {
								event.stopPropagation();
								askMove(node);
							},
						}, h(Icon, { name: 'folder', size: 12 })),
						h('button', {
							type: 'button', className: 'dsh-kb-rowBtn', title: '重命名',
							onClick: (event) => {
								event.stopPropagation();
								askText('重命名', node.name, (name) => nodeAction('rename', { id: node.id, name }));
							},
						}, h(Icon, { name: 'doc', size: 12 })),
						h('button', {
							type: 'button', className: 'dsh-kb-rowBtn dsh-kb-rowBtn--danger', title: '删除',
							onClick: (event) => {
								event.stopPropagation();
								askConfirm(`删除「${node.name}」？${isFolder ? '里面的内容也会一起删除。' : '原文件也会被删掉。'}`,
									() => nodeAction('delete', { id: node.id }));
							},
						}, h(Icon, { name: 'trash', size: 12 })))),
					isFolder && open
						? ((byParent.get(node.id) || []).length
							? h(TreeRows, { byParent, parentKey: node.id, depth: depth + 1 })
							: h('div', {
								key: `${node.id}-empty`,
								className: 'dsh-kb-rowHint',
								style: { paddingLeft: 6 + (depth + 1) * 14 },
							}, '（空文件夹：把文件拖进来，或用行上的「移动到…」）'))
						: null);
			});
		}

		// ── 正文渲染（很轻的 markdown-ish）──────────────────────────────────
		function renderText(text, query) {
			const lines = String(text || '').split('\n');
			const out = [];
			const words = String(query || '').trim().split(/\s+/).filter((word) => word.length >= 1);
			let buffer = [];

			const decorate = (value) => {
				if (!words.length) return value;
				const pattern = words
					.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
					.filter(Boolean)
					.join('|');
				if (!pattern) return value;
				const parts = value.split(new RegExp(`(${pattern})`, 'gi'));
				return parts.map((part, index) => (index % 2 === 1
					? h('mark', { key: index, className: 'dsh-kb-mark' }, part)
					: part));
			};

			const flush = () => {
				if (!buffer.length) return;
				const body = buffer.join('\n');
				buffer = [];
				out.push(h('p', { key: out.length, className: 'dsh-kb-p' }, decorate(body)));
			};

			for (const line of lines) {
				const heading = /^(#{1,6})\s+(.*)$/.exec(line);
				const pageMark = /^\u3014第\s*(\d+)\s*页\u3015$/.exec(line.trim());
				if (heading) {
					flush();
					const level = heading[1].length;
					out.push(h('div', {
						key: out.length,
						className: `dsh-kb-h dsh-kb-h${level}`,
					}, decorate(heading[2])));
					continue;
				}
				if (pageMark) {
					flush();
					out.push(h('div', { key: out.length, className: 'dsh-kb-pageMark' }, `第 ${pageMark[1]} 页`));
					continue;
				}
				if (/^\|/.test(line)) {
					flush();
					out.push(h('div', { key: out.length, className: 'dsh-kb-tablerow' }, decorate(line)));
					continue;
				}
				if (!line.trim()) {
					flush();
					continue;
				}
				buffer.push(line);
			}
			flush();
			return out.length ? out : [h('p', { key: 0, className: 'dsh-kb-hint' }, '（没有正文：可能还在解析，或这个格式抽不出文字）')];
		}

		function isImage(ext) {
			return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
		}

		function rawUrl(doc, extra) {
			return `${API}/doc?id=${encodeURIComponent(doc.id)}&action=raw&t=${encodeURIComponent(state.token)}${extra ? `&${extra}` : ''}`;
		}

		function previewUrl(doc) {
			return `${API}/doc?id=${encodeURIComponent(doc.id)}&action=preview&t=${encodeURIComponent(state.token)}`;
		}

		function pageUrl(doc, page) {
			return `${API}/doc?id=${encodeURIComponent(doc.id)}&action=page&n=${page}&t=${encodeURIComponent(state.token)}`;
		}

		function thumbUrl(doc, page) {
			return `${API}/doc?id=${encodeURIComponent(doc.id)}&action=thumb&n=${page}&t=${encodeURIComponent(state.token)}`;
		}

		// ── 读取区 ──────────────────────────────────────────────────────────
		function DocView({ onAsk, onReindex, onDelete }) {
			const current = useStore();
			const doc = current.doc;
			const pagesRef = React.useRef(null);
			// Office 原版式：先让 Host 把每页渲染成图片，界面自己拼阅读器
			React.useEffect(() => {
				const target = state.doc;
				if (!target || !OFFICE_EXT.includes(target.ext)) return undefined;
				if (state.previewMode === 'text' || state.caps?.officePreview === false) return undefined;
				if (state.previewInfo?.docId === target.id) return undefined;
				let cancelled = false;
				const timer = setTimeout(() => {
					if (!cancelled && state.previewInfo?.docId !== target.id) {
						patch({ previewError: '页面渲染超过 90 秒还没好；可以点「新窗口」看 PDF，或切到「文字」。' });
					}
				}, 90000);
				api(`/doc?id=${encodeURIComponent(target.id)}&action=previewinfo`)
					.then((data) => {
						if (cancelled) return;
						patch({
							previewInfo: {
								docId: target.id,
								pages: data.pages,
								pageCount: data.pageCount,
								truncated: Boolean(data.truncated),
								width: data.width,
								height: data.height,
							},
							previewError: '',
						});
					})
					.catch((error) => {
						if (cancelled) return;
						const message = error.message || '预览生成失败';
						patch({ previewInfo: { docId: target.id, error: message }, previewError: message });
					});
				return () => { cancelled = true; clearTimeout(timer); };
			}, [doc?.id, current.previewMode]);
			if (!doc) {
				if (current.kbs.length === 0) {
					return h('div', { className: 'dsh-kb-empty' },
						h('div', { className: 'dsh-kb-emptyIcon' }, h(Icon, { name: 'book', size: 28 })),
						h('p', null, '先新建一个知识库，再把文件拖进来。'),
						h('button', { type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary', onClick: () => createKb() }, '新建知识库'),
						h('p', { className: 'dsh-kb-hint' }, '文件只存在这台电脑上，不会上传到云端。'));
				}
				return h('div', { className: 'dsh-kb-empty' },
					h('div', { className: 'dsh-kb-emptyIcon' }, h(Icon, { name: 'book', size: 28 })),
					h('p', null, current.nodes.length ? '从左边选一个文件，或把文件拖进来。' : '这个知识库还是空的。点「导入文件」或把文件拖进来。'),
					h('p', { className: 'dsh-kb-hint' }, '文件只存在这台电脑上，不会上传到云端。'));
			}
			const failed = doc.status === 'failed';
			const pending = doc.status === 'pending' || doc.status === 'parsing';
			const office = OFFICE_EXT.includes(doc.ext);
			const previewAvailable = current.caps?.officePreview !== false;
			const officeVisual = office && previewAvailable && current.previewMode !== 'text';
			const visual = isImage(doc.ext) ? false : (doc.ext === 'pdf' || officeVisual);
			const officeInfo = current.previewInfo?.docId === doc.id ? current.previewInfo : null;
			const totalPages = officeInfo?.pages || 0;
			const pageNow = Math.min(Math.max(1, Number(current.currentPage) || 1), totalPages || 1);
			const pageAspect = officeInfo?.width && officeInfo?.height
				? { aspectRatio: `${officeInfo.width} / ${officeInfo.height}` }
				: undefined;
			const goPage = (target) => {
				const page = Math.min(Math.max(1, Math.round(Number(target) || 1)), totalPages || 1);
				patch({ currentPage: page, pageInput: String(page) });
				if (state.pageMode === 'single') return;
				const container = pagesRef.current;
				const element = container?.querySelector(`[data-page="${page}"]`);
				if (container && element) container.scrollTop = Math.max(0, element.offsetTop - 10);
			};
			const onPagesScroll = (event) => {
				const container = event.currentTarget;
				let visible = 1;
				for (const shot of container.querySelectorAll('[data-page]')) {
					if (shot.offsetTop - container.scrollTop <= 48) visible = Number(shot.getAttribute('data-page')) || visible;
					else break;
				}
				if (visible !== state.currentPage) patch({ currentPage: visible, pageInput: String(visible) });
			};
			return h('div', { className: 'dsh-kb-doc' },
				h('div', { className: 'dsh-kb-docHead' },
					h('div', { className: 'dsh-kb-docTitle' }, doc.name),
					h('div', { className: 'dsh-kb-docMeta' },
						h('span', null, bytes(doc.bytes)),
						doc.ext ? h('span', null, `.${doc.ext}`) : null,
						h('span', null, doc.status === 'ready' ? `已索引 · ${doc.chars} 字${doc.pageCount ? ` · ${doc.pageCount} 页` : ''}` : pending ? '解析中…' : failed ? '解析失败' : doc.status),
						doc.indexedAt ? h('span', null, when(doc.indexedAt)) : null)),
				h('div', { className: 'dsh-kb-docActions' },
					h('button', { type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary', onClick: () => onAsk(doc) },
						h(Icon, { name: 'spark', size: 14 }), '问 AI'),
					h('button', {
						type: 'button', className: 'dsh-kb-btn',
						onClick: () => patch({ bigView: true, previewMode: office ? 'visual' : state.previewMode }),
						title: '铺满整个窗口看（Esc 关闭）',
					}, h(Icon, { name: 'open', size: 14 }), '大屏'),
					h('a', {
						className: 'dsh-kb-btn', href: rawUrl(doc, 'download=1'), download: doc.name,
						onClick: (event) => event.stopPropagation(),
						title: '下载原始文件',
					}, '下载'),
					office
						? h('span', { className: 'dsh-kb-seg', role: 'group', 'aria-label': '查看方式' },
							h('button', {
								type: 'button',
								className: cx('dsh-kb-segBtn', officeVisual && 'dsh-kb-segBtn--on'),
								onClick: () => patch({ previewMode: 'visual' }),
							}, '原版式'),
							h('button', {
								type: 'button',
								className: cx('dsh-kb-segBtn', !officeVisual && 'dsh-kb-segBtn--on'),
								onClick: () => patch({ previewMode: 'text' }),
							}, '文字'))
						: null,
					doc.status !== 'failed' && !isImage(doc.ext)
						? h('button', { type: 'button', className: 'dsh-kb-btn', onClick: () => onReindex(doc) },
							h(Icon, { name: 'refresh', size: 14 }), '重新索引')
						: null,
					h('button', { type: 'button', className: 'dsh-kb-btn dsh-kb-btn--danger', onClick: () => onDelete(doc) },
						h(Icon, { name: 'trash', size: 14 }), '删除')),
				office && !previewAvailable
					? h('div', { className: 'dsh-kb-banner dsh-kb-banner--info' },
						'这台机器没启用 Office 转换服务，只能看抽取出来的文字；「原文件」按钮可以用系统里的 Office 打开。')
					: null,
				current.previewError
					? h('div', { className: 'dsh-kb-banner dsh-kb-banner--bad', role: 'alert' },
						h('Icon', { name: 'warn', size: 15 }),
						h('span', null, current.previewError),
						office
							? h('button', { type: 'button', className: 'dsh-kb-btn', onClick: () => patch({ previewMode: 'text', previewError: '' }) }, '看文字版')
							: null)
					: null,
				failed
					? h('div', { className: 'dsh-kb-banner dsh-kb-banner--bad' },
						h(Icon, { name: 'warn', size: 15 }),
						h('span', null, doc.error || '解析失败'),
						h('button', { type: 'button', className: 'dsh-kb-btn', onClick: () => onReindex(doc) }, '重试'))
					: null,
				h('div', { className: cx('dsh-kb-reader', visual && 'dsh-kb-reader--visual') },
					pending
						? h('div', { className: 'dsh-kb-hint' }, '正在解析并建立索引，稍等一下…')
						: null,
					isImage(doc.ext)
						? h('img', {
							className: 'dsh-kb-image',
							alt: doc.name,
							src: rawUrl(doc),
						})
						: doc.ext === 'pdf'
							? h('iframe', {
								className: 'dsh-kb-frame',
								title: doc.name,
								src: `${rawUrl(doc)}${PDF_FRAGMENT}`,
							})
							: officeVisual
								? h('div', { className: 'dsh-kb-viewer' },
									officeInfo && !officeInfo.error
										? h('div', { className: 'dsh-kb-viewerBar' },
											h('button', {
												type: 'button', className: 'dsh-kb-navBtn', title: '显示/隐藏缩略图',
												onClick: () => patch({ thumbsOpen: !state.thumbsOpen }),
											}, h(Icon, { name: 'doc', size: 13 })),
											h('button', {
												type: 'button', className: 'dsh-kb-navBtn', title: '上一页',
												disabled: pageNow <= 1, onClick: () => goPage(pageNow - 1),
											}, '‹'),
											h('input', {
												className: 'dsh-kb-pageInput',
												value: current.pageInput ?? String(pageNow),
												inputMode: 'numeric',
												'aria-label': '跳到页码',
												onChange: (event) => patch({ pageInput: event.target.value.replace(/[^\d]/g, '') }),
												onKeyDown: (event) => {
													if (event.key === 'Enter') {
														goPage(state.pageInput);
														event.currentTarget.blur();
													}
												},
											}),
											h('span', { className: 'dsh-kb-pageTotal' }, `/ ${officeInfo.pages}`),
											h('button', {
												type: 'button', className: 'dsh-kb-navBtn', title: '下一页',
												disabled: pageNow >= officeInfo.pages, onClick: () => goPage(pageNow + 1),
											}, '›'),
											h('span', { className: 'dsh-kb-viewerGrow' }),
											h('span', { className: 'dsh-kb-seg', role: 'group', 'aria-label': '翻页方式' },
												h('button', {
													type: 'button',
													className: cx('dsh-kb-segBtn', current.pageMode !== 'single' && 'dsh-kb-segBtn--on'),
													onClick: () => patch({ pageMode: 'scroll' }),
												}, '连续'),
												h('button', {
													type: 'button',
													className: cx('dsh-kb-segBtn', current.pageMode === 'single' && 'dsh-kb-segBtn--on'),
													onClick: () => patch({ pageMode: 'single', currentPage: pageNow }),
												}, '单页')))
										: null,
									officeInfo && !officeInfo.error
										? h('div', { className: 'dsh-kb-viewerBody' },
											current.thumbsOpen
												? h('div', { className: 'dsh-kb-thumbs' },
													Array.from({ length: officeInfo.pages }, (_, index) => index + 1).map((page) => h('button', {
														type: 'button',
														key: page,
														className: cx('dsh-kb-thumb', page === pageNow && 'dsh-kb-thumb--on'),
														title: `第 ${page} 页`,
														onClick: () => goPage(page),
													},
													h('img', {
														className: 'dsh-kb-thumbImg',
														src: thumbUrl(doc, page),
														loading: 'lazy',
														decoding: 'async',
														alt: `第 ${page} 页缩略图`,
													}),
													h('span', { className: 'dsh-kb-thumbNo' }, page))))
												: null,
											h('div', {
												className: cx('dsh-kb-pages', current.pageMode === 'single' && 'dsh-kb-pages--single'),
												ref: pagesRef,
												onScroll: current.pageMode === 'single' ? undefined : onPagesScroll,
											},
											(current.pageMode === 'single' ? [pageNow] : Array.from({ length: officeInfo.pages }, (_, index) => index + 1))
												.map((page) => h('div', {
													className: 'dsh-kb-pageShot',
													key: page,
													'data-page': page,
													// 单页模式让容器自己撑满、由 object-fit 居中，不要用固定比例
													style: current.pageMode === 'single' ? undefined : pageAspect,
												},
												h('img', {
													className: 'dsh-kb-pageImg',
													src: pageUrl(doc, page),
													loading: page <= 2 ? 'eager' : 'lazy',
													decoding: 'async',
													alt: `${doc.name} 第 ${page} 页`,
												}),
												h('span', { className: 'dsh-kb-pageNo' }, page))),
											officeInfo.truncated
												? h('div', { className: 'dsh-kb-pagesNote' },
													`共 ${officeInfo.pageCount || '?'} 页，这里只渲染了前 ${officeInfo.pages} 页；看完整版请点「新窗口」。`)
												: null))
										: h('div', { className: 'dsh-kb-pagesLoading' },
											h('span', { className: 'dsh-kb-spinner', 'aria-hidden': 'true' }),
											'正在渲染页面…第一次打开会慢一些，之后是缓存。'))
								: h('div', { className: 'dsh-kb-text' }, renderText(current.docText, current.query)),
					!officeVisual && doc.ext !== 'pdf' && !isImage(doc.ext) && current.docHasMore
						? h('button', {
							type: 'button', className: 'dsh-kb-btn dsh-kb-more',
							onClick: () => loadDoc(doc.id, { offset: current.docNext }),
						}, `继续加载（已显示 ${current.docText.length} / ${current.docTotal} 字）`)
						: null));
		}

		// ── 检索结果 ────────────────────────────────────────────────────────
		function SearchView() {
			const current = useStore();
			const search = current.search;
			if (search.loading) return h('div', { className: 'dsh-kb-hint' }, '检索中…');
			if (search.error) return h('div', { className: 'dsh-kb-banner dsh-kb-banner--bad' }, search.error);
			if (!search.hits.length) return h('div', { className: 'dsh-kb-hint' }, search.ran ? '没有找到匹配的内容。换个词试试，或只搜关键词。' : '');
			return h('div', { className: 'dsh-kb-hits' },
				h('div', { className: 'dsh-kb-hitsHead' }, `${search.hits.length} 条结果 · ${search.mode === 'hybrid' ? '关键词 + 向量' : '关键词'}`),
				search.hits.map((hit) => h('button', {
					key: `${hit.nodeId}-${hit.chunkId}`,
					type: 'button',
					className: 'dsh-kb-hit',
					onClick: () => {
						if (hit.ext === 'pdf' || isImage(hit.ext)) {
							// PDF / 图片没有可定位的正文，只打开文件，别偷偷改偏移
							loadDoc(hit.nodeId, { offset: 0 });
							patch({ notice: `${hit.ext === 'pdf' ? 'PDF' : '图片'}命中的位置无法精确定位，已打开文件本身。` });
							return;
						}
						loadDoc(hit.nodeId, { offset: Math.max(0, Number(hit.charStart) - 200) });
					},
				},
				h('div', { className: 'dsh-kb-hitName' }, hit.name, hit.heading ? h('span', { className: 'dsh-kb-hitHead' }, ` · ${hit.heading}`) : null),
				h('div', { className: 'dsh-kb-hitSnippet' }, hit.snippet))));
		}

		// ── 大屏预览：铺满整个窗口（不依赖 window.open / target=_blank，桌面端会拦）──
		function BigView({ doc }) {
			const current = useStore();
			const office = OFFICE_EXT.includes(doc.ext);
			const info = current.previewInfo?.docId === doc.id ? current.previewInfo : null;
			const total = info?.pages || 0;
			const single = current.bigMode !== 'scroll';
			const page = Math.min(Math.max(1, Number(current.currentPage) || 1), total || 1);
			const go = (target) => {
				const next = Math.min(Math.max(1, Math.round(Number(target) || 1)), total || 1);
				patch({ currentPage: next, pageInput: String(next) });
			};
			React.useEffect(() => {
				const onKey = (event) => {
					if (event.key === 'Escape') { patch({ bigView: false }); return; }
					if (event.key === 'ArrowRight' || event.key === 'PageDown') {
						event.preventDefault();
						go((Number(state.currentPage) || 1) + 1);
					}
					if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
						event.preventDefault();
						go((Number(state.currentPage) || 1) - 1);
					}
				};
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, []);
			return h('div', { className: 'dsh-kb-big' },
				h('div', { className: 'dsh-kb-bigBar' },
					h('span', { className: 'dsh-kb-bigTitle' }, doc.name),
					office && info
						? h('span', { className: 'dsh-kb-bigNav' },
							h('button', { type: 'button', className: 'dsh-kb-navBtn', title: '上一页', disabled: page <= 1, onClick: () => go(page - 1) }, '‹'),
							h('span', { className: 'dsh-kb-pageTotal' }, `${page} / ${info.pages}`),
							h('button', { type: 'button', className: 'dsh-kb-navBtn', title: '下一页', disabled: page >= info.pages, onClick: () => go(page + 1) }, '›'),
							h('span', { className: 'dsh-kb-seg', role: 'group', 'aria-label': '显示方式' },
								h('button', {
									type: 'button',
									className: cx('dsh-kb-segBtn', single && 'dsh-kb-segBtn--on'),
									onClick: () => patch({ bigMode: 'single' }),
								}, '单页'),
								h('button', {
									type: 'button',
									className: cx('dsh-kb-segBtn', !single && 'dsh-kb-segBtn--on'),
									onClick: () => patch({ bigMode: 'scroll' }),
								}, '连续')))
						: null,
					h('span', { className: 'dsh-kb-viewerGrow' }),
					h('button', {
						type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary', title: '恢复成面板视图（Esc）',
						onClick: () => patch({ bigView: false }),
					}, h(Icon, { name: 'close', size: 13 }), '恢复')),
				h('div', { className: 'dsh-kb-bigBody' },
					isImage(doc.ext)
						? h('img', { className: 'dsh-kb-bigImg', src: rawUrl(doc), alt: doc.name })
						: doc.ext === 'pdf'
							? h('iframe', { className: 'dsh-kb-bigFrame', title: doc.name, src: `${rawUrl(doc)}${PDF_FRAGMENT}` })
							: office && info && !info.error
								? h('div', { className: cx('dsh-kb-pages', single && 'dsh-kb-pages--single') },
									(single ? [page] : Array.from({ length: info.pages }, (_, index) => index + 1))
										.map((one) => h('div', {
											className: 'dsh-kb-pageShot',
											key: one,
											'data-page': one,
											style: single || !info.width || !info.height ? undefined : { aspectRatio: `${info.width} / ${info.height}` },
										},
										h('img', {
											className: 'dsh-kb-pageImg',
											src: pageUrl(doc, one),
											loading: one <= 2 ? 'eager' : 'lazy',
											decoding: 'async',
											alt: `${doc.name} 第 ${one} 页`,
										}),
										h('span', { className: 'dsh-kb-pageNo' }, one))))
								: h('div', { className: 'dsh-kb-pagesLoading' },
									h('span', { className: 'dsh-kb-spinner', 'aria-hidden': 'true' }),
									office ? '正在渲染页面…' : '这个格式没有大屏预览，可以点「下载」用系统应用打开')));
		}

		// ── 主页面 ──────────────────────────────────────────────────────────
		// 「问 AI」的会话入口由 apply 注入（组件拿不到 ctx）
		let sessionStarter = null;

		/** 新文件/新文件夹落在哪：选中的文件夹 → 选中文件所在目录 → 根。 */
		function currentFolderId(current) {
			const selected = current.selectedId
				? current.nodes.find((node) => node.id === current.selectedId)
				: null;
			if (!selected) return null;
			return selected.kind === 'folder' ? selected.id : (selected.parentId ?? null);
		}

		function createKb() {
			askText('新知识库的名字', '我的知识库', (name) => nodeAction('create-kb', { name }));
		}

		function KbPage() {
			const current = useStore();
			const [dragging, setDragging] = React.useState(false);
			const fileInput = React.useRef(null);
			const tree = React.useMemo(() => buildTree(current.nodes), [current.nodes]);

			React.useEffect(() => {
				if (!state.loaded) loadState();
			}, []);

			const searchTimer = React.useRef(null);
			const onQueryChange = (value) => {
				patch({ query: value, view: value.trim() ? 'search' : 'doc' });
				if (searchTimer.current) clearTimeout(searchTimer.current);
				searchTimer.current = setTimeout(() => runSearch(value), 280);
			};

			const onAsk = async (doc) => {
				try {
					const data = await api('/ask', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ docId: doc.id }),
					});
					sessionStarter?.(data.prompt);
					patch({ notice: '已在会话输入框里准备好提问，接着写你的问题就行' });
				} catch (error) {
					patch({ error: error.message || '打不开会话' });
				}
			};

			const onReindex = async (doc) => {
				try {
					await api(`/doc?id=${encodeURIComponent(doc.id)}&action=reindex`, { method: 'POST' });
					patch({ notice: '已重新排队解析' });
					schedulePoll();
					await loadDoc(doc.id);
				} catch (error) {
					patch({ error: error.message || '重建失败' });
				}
			};

			const onDelete = (doc) => {
				askConfirm(`删除「${doc.name}」？原文件也会被删掉。`, async () => {
					const data = await nodeAction('delete', { id: doc.id });
					if (data) patch({ doc: null, docText: '', docNext: 0, selectedId: '' });
				});
			};

			return h('div', {
				className: cx('dsh-kb-page', dragging && 'dsh-kb-page--drag'),
				onDragOver: (event) => { event.preventDefault(); setDragging(true); },
				onDragLeave: () => setDragging(false),
				onDrop: (event) => {
					event.preventDefault();
					setDragging(false);
					if (!event.dataTransfer?.files?.length) return; // 树内拖动节点，不是导入文件
					uploadFiles(event.dataTransfer.files, currentFolderId(current));
				},
			},
			// 顶部
			h('div', { className: 'dsh-kb-head' },
				h('button', {
					type: 'button', className: 'dsh-kb-iconBtn',
					title: current.sideOpen ? '收起文件树' : '展开文件树',
					'aria-expanded': current.sideOpen,
					onClick: () => patch({ sideOpen: !state.sideOpen }),
				}, h(Icon, { name: 'chevron', size: 13, className: current.sideOpen ? 'dsh-kb-rot180' : undefined })),
				h('div', { className: 'dsh-kb-brand' },
					h('span', { className: 'dsh-kb-brandIcon' }, h(Icon, { name: 'book', size: 16 })),
					h('select', {
						className: 'dsh-kb-select',
						value: current.kbId,
						onChange: (event) => {
							patch({ doc: null, docText: '', selectedId: '' });
							loadState(event.target.value);
						},
					},
					current.kbs.length
						? current.kbs.map((kb) => h('option', { key: kb.id, value: kb.id }, `${kb.name}（${kb.docs}）`))
						: h('option', { value: '' }, '还没有知识库')),
					h('button', {
						type: 'button', className: 'dsh-kb-iconBtn', title: '新建知识库',
						onClick: () => createKb(),
					}, h(Icon, { name: 'plus', size: 14 }))),
				h('div', { className: 'dsh-kb-searchBox' },
					h(Icon, { name: 'search', size: 14, className: 'dsh-kb-searchIcon' }),
					h('input', {
						className: 'dsh-kb-searchInput',
						type: 'search',
						placeholder: '搜索标题或正文（支持中文短词）…',
						value: current.query,
						onChange: (event) => onQueryChange(event.target.value),
					}),
					current.query
						? h('button', {
							type: 'button', className: 'dsh-kb-searchClear', title: '清空',
							onClick: () => { onQueryChange(''); },
						}, h(Icon, { name: 'close', size: 12 }))
						: null),
				h('div', { className: 'dsh-kb-headActions' },
					h('button', {
						type: 'button', className: 'dsh-kb-btn',
						onClick: () => {
							const parent = currentFolderId(current);
							askText('新文件夹的名字', '新文件夹', (name) => nodeAction('create', {
								kbId: current.kbId, parentId: parent, kind: 'folder', name,
							}));
						},
						disabled: !current.kbId,
					}, h(Icon, { name: 'folder', size: 14 }), '新建文件夹'),
					h('button', {
						type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary',
						onClick: () => fileInput.current?.click(),
						disabled: !current.kbId,
					}, h(Icon, { name: 'upload', size: 14 }), current.uploading ? `上传中 ${current.uploading}` : '导入文件'),
					h('input', {
						ref: fileInput, type: 'file', multiple: true, style: { display: 'none' },
						onChange: (event) => {
							uploadFiles(event.target.files, currentFolderId(current));
							event.target.value = '';
						},
					}))),

			// 提示条
			current.notice || current.error
				? h('div', { className: cx('dsh-kb-banner', current.error ? 'dsh-kb-banner--bad' : 'dsh-kb-banner--info') },
					h('span', null, current.error || current.notice),
					h('button', { type: 'button', className: 'dsh-kb-bannerClose', onClick: () => patch({ notice: '', error: '' }) },
						h(Icon, { name: 'close', size: 12 })))
				: null,

			// 主体
			h('div', { className: 'dsh-kb-body' },
				current.sideOpen
					? h('div', { className: 'dsh-kb-side' },
						current.loading
							? h('div', { className: 'dsh-kb-hint' }, '加载中…')
							: current.kbs.length === 0
								? h('div', { className: 'dsh-kb-empty dsh-kb-empty--side' },
									h('p', null, '还没有知识库。'),
									h('button', {
										type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary',
										onClick: () => createKb(),
									}, '新建知识库'))
								: h('div', { className: 'dsh-kb-tree' },
									h(TreeRows, { byParent: tree, parentKey: '', depth: 0 }),
									current.nodes.length === 0
										? h('div', { className: 'dsh-kb-hint dsh-kb-hint--pad' }, '空知识库：导入文件，或新建文件夹。')
										: null))
					: h('button', {
						type: 'button', className: 'dsh-kb-rail', title: '展开文件树',
						onClick: () => patch({ sideOpen: true }),
					}, h(Icon, { name: 'chevron', size: 14 })),
				h('div', { className: 'dsh-kb-main' },
					current.view === 'search' && current.query ? h(SearchView) : h(DocView, { onAsk, onReindex, onDelete })),
			),
			h(Dialog),
			current.bigView && current.doc ? h(BigView, { doc: current.doc }) : null);
		}

		// ── 设置分区 ────────────────────────────────────────────────────────
		function SettingsSection() {
			const current = useStore();
			React.useEffect(() => {
				if (!state.loaded) loadState();
			}, []);
			const stats = current.stats;
			const embedding = current.caps?.embedding;
			return h('div', { className: 'dsh-kb-settings' },
				h('p', { className: 'dsh-kb-settingsIntro' },
					'知识库存放在本机：文件是真实文件，索引是本地 SQLite 全文索引。插件不会把内容上传到任何服务（除非你自己打开了向量检索）。'),
				h('section', { className: 'dsh-kb-card' },
					h('h4', null, '存放目录'),
					h('code', { className: 'dsh-kb-code' }, current.root || '（未初始化）'),
					h('p', { className: 'dsh-kb-hint' },
						'想换位置：在插件配置里设置 ',
						h('code', null, 'root'),
						'（插件页 → 知识库 → 配置），重启后生效。已有文件不会自动搬迁。')),
				h('section', { className: 'dsh-kb-card' },
					h('h4', null, '索引状态'),
					stats
						? h('div', { className: 'dsh-kb-kv' },
							h('span', null, '知识库'), h('strong', null, stats.kbs),
							h('span', null, '文档'), h('strong', null, stats.docs),
							h('span', null, '检索片段'), h('strong', null, stats.chunks),
							h('span', null, '总大小'), h('strong', null, bytes(stats.bytes)),
							h('span', null, '向量'), h('strong', null, stats.vectors))
						: h('p', { className: 'dsh-kb-hint' }, '读取中…'),
					h('div', { className: 'dsh-kb-row2' },
						h('button', {
							type: 'button', className: 'dsh-kb-btn',
							onClick: async () => {
								try {
									const data = await api('/reindex-all', { method: 'POST' });
									patch({ notice: `已排队重建 ${data.queued} 篇文档的索引` });
								} catch (error) {
									patch({ notice: error.message || '重建失败' });
								}
							},
						}, h(Icon, { name: 'refresh', size: 14 }), '重建全部索引'),
						h('button', {
							type: 'button', className: 'dsh-kb-btn',
							onClick: () => loadState(current.kbId, true),
						}, '刷新'),
						h('button', {
							type: 'button', className: 'dsh-kb-btn',
							title: '删掉转换出来的 PDF 和逐页图片（下次打开会重新生成）',
							onClick: async () => {
								try {
									const data = await api('/purge-previews', { method: 'POST' });
									patch({ notice: `已清理 ${data.cleared} 篇文档的预览缓存`, previewInfo: null });
								} catch (error) {
									patch({ error: error.message || '清理失败' });
								}
							},
						}, '清理预览缓存'))),
				h('section', { className: 'dsh-kb-card' },
					h('h4', null, '向量检索'),
					embedding
						? h('p', { className: 'dsh-kb-hint' },
							embedding.enabled ? `已启用（模型 ${embedding.model}）：检索时会与关键词结果融合。`
								: embedding.configured ? '已开启但缺少 baseUrl 或 model，当前仍只做关键词检索。'
									: '未启用。关键词检索已经可用；需要语义检索时，在插件配置里填 OpenAI 兼容的 embeddings 接口。')
						: h('p', { className: 'dsh-kb-hint' }, '未启用。')),
				current.error
					? h('p', { className: 'dsh-kb-banner dsh-kb-banner--bad', role: 'alert' }, current.error)
					: null,
				current.notice ? h('p', { className: 'dsh-kb-hint' }, current.notice) : null);
		}

		// ── 左侧栏图标 ──────────────────────────────────────────────────────
		function PanelIcon({ size, active }) {
			return h('span', { className: cx('dsh-kb-barIcon', active && 'dsh-kb-barIcon--active'), 'aria-hidden': 'true' },
				h(Icon, { name: 'book', size: size || 18 }));
		}

		// ── 样式（只用 --dsw-alias-* token，跟随明暗主题）─────────────────────
		function installStyles() {
			const style = document.createElement('style');
			style.id = 'dsh-plugin-knowledge-base-styles';
			style.textContent = [
				'.dsh-kb-barIcon{display:inline-flex;align-items:center;justify-content:center;color:inherit;opacity:.8;}',
				'.dsh-kb-page{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);}',
				'.dsh-kb-page--drag{outline:2px dashed var(--dsw-alias-label-brand,#1f6feb);outline-offset:-8px;}',
				'.dsh-kb-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap;}',
				'.dsh-kb-brand{display:flex;align-items:center;gap:6px;min-width:0;}',
				'.dsh-kb-brandIcon{display:inline-flex;color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-select{max-width:200px;height:28px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:12.5px;padding:0 6px;}',
				'.dsh-kb-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
				'.dsh-kb-iconBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-searchBox{position:relative;display:flex;align-items:center;flex:1;min-width:180px;max-width:420px;}',
				'.dsh-kb-searchIcon{position:absolute;left:9px;color:var(--dsw-alias-label-secondary);pointer-events:none;}',
				'.dsh-kb-searchInput{width:100%;height:28px;padding:0 26px 0 28px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:12.5px;}',
				'.dsh-kb-searchInput:focus{outline:none;border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-searchClear{position:absolute;right:7px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;display:inline-flex;}',
				'.dsh-kb-headActions{display:flex;gap:6px;margin-left:auto;}',
				'.dsh-kb-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;text-decoration:none;white-space:nowrap;}',
				'.dsh-kb-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-btn:disabled{opacity:.5;cursor:default;}',
				'.dsh-kb-btn--primary{border-color:transparent;background:var(--dsw-alias-label-brand,#1f6feb);color:#fff;}',
				'.dsh-kb-btn--primary:hover{filter:brightness(1.06);background:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-btn--danger{color:var(--dsw-alias-label-danger,#d14343);}',
				'.dsh-kb-banner{display:flex;align-items:center;gap:8px;padding:7px 16px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-banner--info{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-banner--bad{background:rgba(209,67,67,.10);color:var(--dsw-alias-label-danger,#d14343);}',
				'.dsh-kb-bannerClose{margin-left:auto;border:none;background:transparent;color:inherit;cursor:pointer;display:inline-flex;}',
				'.dsh-kb-body{display:flex;flex:1;min-height:0;}',
				'.dsh-kb-side{width:250px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow-y:auto;padding:6px 0 20px;}',
				'.dsh-kb-rail{flex:none;width:26px;padding:0;border:none;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;}',
				'.dsh-kb-rail:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-rot180{transform:rotate(180deg);}',
				'.dsh-kb-tree{display:flex;flex-direction:column;}',
				'.dsh-kb-row{display:flex;align-items:center;gap:5px;height:28px;padding-right:8px;cursor:pointer;color:var(--dsw-alias-label-primary);border-radius:6px;margin:0 6px;}',
				'.dsh-kb-row:hover{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-row--active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-caret{display:inline-flex;width:12px;color:var(--dsw-alias-label-secondary);transition:transform .12s ease;}',
				'.dsh-kb-caret--open{transform:rotate(90deg);}',
				'.dsh-kb-rowIcon{display:inline-flex;color:var(--dsw-alias-label-secondary);flex:none;}',
				'.dsh-kb-rowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
				'.dsh-kb-dot{width:6px;height:6px;border-radius:50%;flex:none;}',
				'.dsh-kb-dot--busy{background:var(--dsw-alias-label-warning,#d9a441);}',
				'.dsh-kb-dot--bad{background:var(--dsw-alias-label-danger,#d14343);}',
				'.dsh-kb-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;}',
				'.dsh-kb-empty{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:40px 28px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-empty--side{padding:18px 16px;}',
				'.dsh-kb-emptyIcon{color:var(--dsw-alias-border-l1);}',
				'.dsh-kb-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-hint--pad{padding:10px 14px;}',
				'.dsh-kb-doc{display:flex;flex-direction:column;flex:1;min-height:0;}',
				'.dsh-kb-docHead{padding:14px 20px 0;}',
				'.dsh-kb-docTitle{font-size:15px;font-weight:600;word-break:break-word;}',
				'.dsh-kb-docMeta{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-docActions{display:flex;gap:6px;flex-wrap:wrap;padding:10px 20px 0;}',
				'.dsh-kb-reader{flex:1;min-height:0;overflow-y:auto;padding:12px 24px 40px;}',
				// 视觉阅读（PDF / Office）：铺满整块区域，去掉内边距和外框，让阅读器自己占满
				'.dsh-kb-reader--visual{display:flex;flex-direction:column;padding:0;overflow:hidden;}',
				'.dsh-kb-reader--visual .dsh-kb-frame{flex:1 1 auto;width:100%;height:100%;min-height:0;border:none;border-radius:0;background:transparent;}',
				'.dsh-kb-reader--visual .dsh-kb-frameWrap{flex:1 1 auto;min-height:0;display:flex;}',
				'.dsh-kb-reader--visual .dsh-kb-frameLoading{border:none;border-radius:0;}',
				// 逐页图片阅读器（Office）：自己画，不套浏览器 PDF 阅读器
				'.dsh-kb-pages{flex:1;min-height:0;overflow-y:auto;padding:16px 18px 32px;display:flex;flex-direction:column;align-items:center;gap:14px;background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-pageShot{position:relative;width:min(100%,1180px);}',
				'.dsh-kb-pageImg{display:block;width:100%;height:auto;border-radius:6px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.18);}',
				'.dsh-kb-pageNo{position:absolute;left:8px;top:8px;padding:1px 7px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;line-height:1.6;}',
				'.dsh-kb-pagesNote{font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 4px 6px;text-align:center;}',
				'.dsh-kb-viewer{display:flex;flex-direction:column;flex:1;min-height:0;}',
				'.dsh-kb-viewerBar{display:flex;flex:none;align-items:center;gap:6px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
				'.dsh-kb-viewerGrow{flex:1;min-width:8px;}',
				'.dsh-kb-navBtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:inherit;font-size:15px;line-height:1;cursor:pointer;}',
				'.dsh-kb-navBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-navBtn:disabled{opacity:.4;cursor:default;}',
				'.dsh-kb-pageInput{width:46px;height:24px;padding:0;text-align:center;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:12px;}',
				'.dsh-kb-pageInput:focus{outline:none;border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-pageTotal{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
				'.dsh-kb-pages--single{align-items:center;justify-content:center;padding:12px;overflow:hidden;}',
				'.dsh-kb-pages--single .dsh-kb-pageShot{width:100%;height:100%;max-width:1180px;display:flex;align-items:center;justify-content:center;}',
				'.dsh-kb-pages--single .dsh-kb-pageImg{width:100%;height:100%;object-fit:contain;border-radius:0;box-shadow:none;background:transparent;}',
				'.dsh-kb-pages--single .dsh-kb-pageNo{display:none;}',
				'.dsh-kb-viewerBody{display:flex;flex:1;min-height:0;}',
				'.dsh-kb-thumbs{flex:none;width:118px;overflow-y:auto;padding:8px 6px 16px;display:flex;flex-direction:column;gap:8px;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
				'.dsh-kb-thumb{position:relative;display:block;padding:0;margin:0;border:2px solid transparent;border-radius:6px;background:transparent;cursor:pointer;line-height:0;}',
				'.dsh-kb-thumb:hover{border-color:var(--dsw-alias-border-l1);}',
				'.dsh-kb-thumb--on{border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-thumbImg{display:block;width:100%;height:auto;border-radius:4px;background:#fff;}',
				'.dsh-kb-thumbNo{position:absolute;right:3px;bottom:3px;padding:0 4px;border-radius:4px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;line-height:1.6;}',
				'.dsh-kb-pagesLoading{flex:1;min-height:320px;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6;background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-text{max-width:820px;font-size:13.5px;line-height:1.78;}',
				'.dsh-kb-p{margin:0 0 10px;white-space:pre-wrap;word-break:break-word;}',
				'.dsh-kb-h{margin:16px 0 8px;font-weight:600;}',
				'.dsh-kb-h1{font-size:16px;}.dsh-kb-h2{font-size:15px;}.dsh-kb-h3{font-size:14px;}.dsh-kb-h4,.dsh-kb-h5,.dsh-kb-h6{font-size:13.5px;}',
				'.dsh-kb-pageMark{margin:14px 0 6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;}',
				'.dsh-kb-tablerow{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-mark{background:rgba(217,164,65,.32);color:inherit;border-radius:2px;}',
				'.dsh-kb-image{max-width:100%;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-frame{width:100%;height:100%;min-height:520px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:#fff;}',				'.dsh-kb-frame--pending{opacity:0;}',
				'.dsh-kb-frameWrap{position:relative;flex:1;min-height:520px;display:flex;}',
				'.dsh-kb-frameLoading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 24px;text-align:center;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6;}',
				'.dsh-kb-spinner{width:14px;height:14px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-label-brand,#1f6feb);animation:dsh-kb-spin .8s linear infinite;}',
				'@keyframes dsh-kb-spin{to{transform:rotate(360deg);}}',
				'.dsh-kb-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;}',
				'.dsh-kb-segBtn{height:22px;padding:0 9px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}',
				'.dsh-kb-segBtn--on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}',
				'.dsh-kb-more{margin-top:14px;}',
				'.dsh-kb-hits{display:flex;flex-direction:column;gap:8px;padding:14px 20px 30px;overflow-y:auto;}',
				'.dsh-kb-hitsHead{font-size:12px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-hit{display:flex;flex-direction:column;gap:4px;text-align:left;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer;}',
				'.dsh-kb-hit:hover{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-hitName{font-size:12.5px;font-weight:600;}',
				'.dsh-kb-hitHead{font-weight:400;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-hitSnippet{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;}',
				'.dsh-kb-settings{display:flex;flex-direction:column;gap:14px;}',
				'.dsh-kb-settingsIntro{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-card{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;}',
				'.dsh-kb-card h4{margin:0;font-size:13px;font-weight:600;}',
				'.dsh-kb-code{display:block;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Menlo,monospace;font-size:11.5px;word-break:break-all;}',
				'.dsh-kb-kv{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:6px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);align-items:center;}',
				'.dsh-kb-kv strong{color:var(--dsw-alias-label-primary);font-weight:600;}',
				'.dsh-kb-row2{display:flex;gap:8px;}',
				'.dsh-kb-barIcon--active{opacity:1;color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-rowActions{display:none;gap:2px;flex:none;}',
				'.dsh-kb-row:hover .dsh-kb-rowActions,.dsh-kb-row:focus-visible .dsh-kb-rowActions{display:inline-flex;}',
				'.dsh-kb-rowBtn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;}',
				'.dsh-kb-rowBtn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-rowBtn--danger:hover{color:var(--dsw-alias-label-danger,#d14343);}',
				'.dsh-kb-row:focus-visible{outline:2px solid var(--dsw-alias-label-brand,#1f6feb);outline-offset:-2px;}',
				'.dsh-kb-rowHint{font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:4px 8px 4px 0;}',
				'.dsh-kb-moveList{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow-y:auto;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;}',
				'.dsh-kb-moveItem{padding:6px 10px;border:none;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12.5px;text-align:left;cursor:pointer;}',
				'.dsh-kb-moveItem:hover{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-big{position:fixed;inset:0;z-index:3000;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1);}',
				'.dsh-kb-bigBar{display:flex;flex:none;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-bigTitle{font-size:13px;font-weight:600;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
				'.dsh-kb-bigNav{display:flex;align-items:center;gap:8px;}',
				'.dsh-kb-bigBody .dsh-kb-pages--single .dsh-kb-pageShot{max-width:1400px;}',
				'.dsh-kb-bigBody{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-bigBody .dsh-kb-pages{padding:18px 22px 40px;}',
				'.dsh-kb-bigBody .dsh-kb-pageShot{max-width:1400px;}',
				'.dsh-kb-bigImg{max-width:100%;max-height:100%;object-fit:contain;margin:auto;display:block;}',
				'.dsh-kb-bigFrame{flex:1;min-height:0;width:100%;border:none;background:#fff;}',
				'.dsh-kb-btn--dangerSolid{border-color:transparent;background:var(--dsw-alias-label-danger,#d14343);color:#fff;}',
				'.dsh-kb-btn--dangerSolid:hover{filter:brightness(1.06);}',
				'.dsh-kb-mask{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.28);}',
				'.dsh-kb-modal{width:min(380px,86%);display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 12px 32px rgba(0,0,0,.18);}',
				'.dsh-kb-modalTitle{font-size:13px;font-weight:600;line-height:1.5;}',
				'.dsh-kb-modalInput{height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:12.5px;}',
				'.dsh-kb-modalInput:focus{outline:none;border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-modalActions{display:flex;justify-content:flex-end;gap:8px;}',
			].join('\n');
			document.head.appendChild(style);
			return () => style.remove();
		}

		// ── 插件入口 ────────────────────────────────────────────────────────
		function apply(ctx) {
			const slots = ctx.get('slots');
			if (!slots) return;
			ctx.effect(installStyles, 'knowledge-base: styles');

			// 组件拿不到 ctx，所以把"开会话"这件事留在模块作用域里
			sessionStarter = (prompt) => {
				const workspace = ctx.get('uiWorkspace');
				if (!workspace?.startSession) {
					patch({ error: '会话服务还没就绪，稍后再点一次' });
					return;
				}
				try {
					workspace.startSession(undefined, { prompt, whenDraftExists: 'append' });
				} catch (error) {
					patch({ error: `开会话失败：${error.message || error}` });
				}
			};

			ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
				name: 'sidebar.panellist',
				id: PANEL_ID,
				order: 25,
				label: () => '知识库',
			}, PanelIcon)), 'knowledge-base: panellist icon');

			ctx.effect(() => slots.inject('main', () => slots.register({
				name: 'main',
				key: PANEL_ID,
			}, KbPage)), 'knowledge-base: main page');

			ctx.effect(() => slots.inject('settings.section', () => slots.register({
				name: 'settings.section',
				id: 'dsh-knowledge-base-settings',
				order: 26,
				label: () => '知识库',
			}, SettingsSection)), 'knowledge-base: settings section');
		}

		const plugin = { inject: ['slots'], apply };
		// 仅测试用：让离线冒烟测试能摆出各种状态再渲染（浏览器里不生效）
		if (typeof globalThis !== 'undefined' && globalThis.__DSH_KB_TEST__) {
			plugin.__test = { patch, state, askText, askConfirm, renderText, isImage };
		}
		return plugin;
	},
});
