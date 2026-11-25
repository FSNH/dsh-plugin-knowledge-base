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
	// 必须等于 package.json 的 name：client-modules 用「包名」做模块表的键，
	// 这里写成裸名会让 factory 注册到别处、arrive() 永远查不到（loaded without registering）。
	id: '@xiaofanzhao/dsh-plugin-knowledge-base',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const API = '/api/kb/v1';
		const PANEL_ID = 'dsh-knowledge-base';
		const TEXT_PAGE = 24000;
		const OFFICE_EXT = ['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'];
// 有单元格网格可画的表格（xls 是老二进制格式，只能走 LibreOffice 的逐页预览）
const SHEET_EXT = ['xlsx', 'csv', 'tsv'];
// 纯文本类文档：大屏里按 Markdown 阅读，而不是提示「没有大屏预览」
const TEXT_DOC_EXT = ['md', 'markdown', 'txt', 'text', 'log', 'json', 'yaml', 'yml', 'html', 'htm',
	'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'hpp',
	'cs', 'rb', 'php', 'sh', 'ps1', 'sql', 'css', 'scss', 'xml', 'toml', 'ini', 'conf'];
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
				settings: ['M2.5 5.5h11', 'M2.5 10.5h11', 'M6 3.5v4', 'M10 8.5v4'],
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
			progress: null,
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
			sheet: null,
			sheetTab: 0,
			sheetError: '',
			currentPage: 1,
			pageMode: 'scroll',
			pageInput: '1',
			thumbsOpen: true,
			bigView: false,
			bigMode: 'single',
			sideOpen: true,
			showSettings: false,
			dashOpen: false,
			examOpen: false,
			examPicked: [],
			dashData: null,
			dashError: '',
			dashLoading: false,
			menu: null,
			importTarget: null,
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
					stats: data.stats, progress: data.progress || null, caps: data.capabilities, root: data.root, token: data.token || '',
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
					showSettings: false,
					dashOpen: false,
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

		/** 行操作下拉菜单的宽度（与 .dsh-kb-menu 的 width 保持一致） */
		const MENU_WIDTH = 184;

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
			// 勾文件夹 = 勾它下面（含子文件夹）的全部文档
			const docsUnder = (folderId) => {
				const out = [];
				const walk = (parentId) => {
					for (const child of byParent.get(parentId) || []) {
						if (child.kind === 'doc') out.push(child.id);
						else walk(child.id);
					}
				};
				walk(folderId);
				return out;
			};
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
					current.examOpen
						? (() => {
							// 对练模式：左侧直接勾选，右侧只显示结果
							const pickedIds = Array.isArray(current.examPicked) ? current.examPicked : [];
							const ids = isFolder ? docsUnder(node.id) : [node.id];
							const on = ids.length > 0 && ids.every((id) => pickedIds.includes(id));
							const partial = !on && ids.some((id) => pickedIds.includes(id));
							return h('input', {
								type: 'checkbox',
								className: 'dsh-kb-rowPick',
								checked: on,
								'aria-label': '选择 ' + node.name,
								ref: isFolder ? (el) => { if (el) el.indeterminate = partial; } : undefined,
								onClick: (event) => event.stopPropagation(),
								onChange: (event) => {
									event.stopPropagation();
									const allOn = ids.length > 0 && ids.every((id) => pickedIds.includes(id));
									patch({
										examPicked: allOn
											? pickedIds.filter((id) => !ids.includes(id))
											: [...new Set([...pickedIds, ...ids])],
									});
								},
							});
						})()
						: null,
					h('span', { className: cx('dsh-kb-caret', isFolder && open && 'dsh-kb-caret--open') },
						isFolder ? h(Icon, { name: 'chevron', size: 12 }) : null),
					h('span', { className: 'dsh-kb-rowIcon' }, h(Icon, { name: isFolder ? (open ? 'folderOpen' : 'folder') : 'doc', size: 14 })),
					h('span', { className: 'dsh-kb-rowName' }, node.name),
					statusDot(node),
					h('span', { className: 'dsh-kb-rowActions' },
						h('button', {
							type: 'button',
							className: cx('dsh-kb-rowBtn dsh-kb-moreBtn', current.menu?.id === node.id && 'dsh-kb-rowBtn--on'),
							title: '更多操作',
							'aria-haspopup': 'menu',
							'aria-expanded': current.menu?.id === node.id,
							onClick: (event) => {
								event?.stopPropagation?.();
								// 菜单从文件树右侧弹出（不压住树里的文字），纵向对齐到这一行
								const target = event?.currentTarget;
								const rowElement = target?.closest?.('.dsh-kb-row') || target;
								const rowRect = rowElement?.getBoundingClientRect?.();
								const sideRect = rowElement?.closest?.('.dsh-kb-side')?.getBoundingClientRect?.();
								const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1280;
								const viewportHeight = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800;
								const menuHeight = (isFolder ? 5 : 4) * 30 + 10;
								let x = sideRect ? Math.round(sideRect.right + 6)
									: rowRect ? Math.round(rowRect.right + 6) : 260;
								if (x + MENU_WIDTH > viewportWidth - 8) x = Math.max(8, viewportWidth - MENU_WIDTH - 8);
								let y = rowRect ? Math.round(rowRect.bottom + 2) : 40;
								y = Math.max(8, Math.min(y, viewportHeight - menuHeight - 8));
								patch({
									menu: current.menu?.id === node.id ? null : { id: node.id, x, y },
								});
							},
						}, '⋯'))),
					isFolder && open
						? ((byParent.get(node.id) || []).length
							? h(TreeRows, { byParent, parentKey: node.id, depth: depth + 1 })
							: h('div', {
								key: `${node.id}-empty`,
								className: 'dsh-kb-rowHint',
								style: { paddingLeft: 6 + (depth + 1) * 14 },
							}, '（空文件夹：把文件拖进来，或用这一行右边的「⋯」新建子文件夹 / 上传文件）'))
						: null);
			});
		}

		// ── 正文渲染：轻量 Markdown（标题 / 列表 / 引用 / 分隔线 / 代码块 / 表格 / 行内格式）──
		// 注意：只做「看得懂」的程度，不做完整 CommonMark——正文是抽取出来的文本，
		// 过度解析反而会把正文里的 * 和 # 吃掉。
		function renderMarkdown(text, query) {
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
				const parts = String(value).split(new RegExp(`(${pattern})`, 'gi'));
				return parts.map((part, index) => (index % 2 === 1
					? h('mark', { key: index, className: 'dsh-kb-mark' }, part)
					: part));
			};

			// 行内格式：粗体 / 斜体 / 行内代码 / 链接；命中搜索词的片段套 <mark>
			const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^)\s]+\))/g;
			const inline = (value) => {
				const source = String(value ?? '');
				if (!/(\*\*|__|`|\]\()/.test(source)) return decorate(source);
				const parts = source.split(INLINE);
				return parts.map((part, index) => {
					if (!part) return null;
					let matched = /^\*\*([^*]+)\*\*$/.exec(part) || /^__([^_]+)__$/.exec(part);
					if (matched) return h('strong', { key: index }, decorate(matched[1]));
					matched = /^`([^`]+)`$/.exec(part);
					if (matched) return h('code', { key: index, className: 'dsh-kb-inlineCode' }, matched[1]);
					matched = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
					if (matched) {
						return h('a', {
							key: index, className: 'dsh-kb-link',
							href: matched[2], target: '_blank', rel: 'noreferrer noopener',
						}, decorate(matched[1]));
					}
					matched = /^\*([^*]+)\*$/.exec(part) || /^_([^_]+)_$/.exec(part);
					if (matched) return h('em', { key: index }, decorate(matched[1]));
					return decorate(part);
				});
			};

			const flush = () => {
				if (!buffer.length) return;
				const body = buffer.join('\n');
				buffer = [];
				out.push(h('p', { key: out.length, className: 'dsh-kb-p' }, inline(body)));
			};

			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index];
				const trimmed = line.trim();

				// 代码块
				const fence = /^```(.*)$/.exec(trimmed);
				if (fence) {
					flush();
					const code = [];
					for (index += 1; index < lines.length && !/^```/.test(lines[index].trim()); index += 1) {
						code.push(lines[index]);
					}
					out.push(h('pre', { key: out.length, className: 'dsh-kb-code' }, code.join('\n')));
					continue;
				}

				const heading = /^(#{1,6})\s+(.*)$/.exec(line);
				if (heading) {
					flush();
					const level = heading[1].length;
					out.push(h('div', {
						key: out.length,
						className: `dsh-kb-h dsh-kb-h${level}`
					}, inline(heading[2])));
					continue;
				}

				const pageMark = /^\u3014第\s*(\d+)\s*页\u3015$/.exec(trimmed);
				if (pageMark) {
					flush();
					out.push(h('div', { key: out.length, className: 'dsh-kb-pageMark' }, `第 ${pageMark[1]} 页`));
					continue;
				}

				// 分隔线：--- / *** / ___（三个以上）
				if (/^([-*_])\1{2,}$/.test(trimmed)) {
					flush();
					out.push(h('hr', { key: out.length, className: 'dsh-kb-hr' }));
					continue;
				}

				// 表格：连续的 | 行，第一行当表头
				if (/^\|/.test(trimmed)) {
					flush();
					const rows = [];
					while (index < lines.length && /^\|/.test(lines[index].trim())) {
						const raw = lines[index].trim();
						if (!/^\|[\s:|-]+\|?$/.test(raw)) {
							rows.push(raw.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
						}
						index += 1;
					}
					index -= 1;
					if (rows.length) {
						const head = rows[0];
						const rest = rows.slice(1);
						out.push(h('div', { key: out.length, className: 'dsh-kb-mdTblWrap' },
							h('table', { className: 'dsh-kb-mdTbl' },
								h('thead', null, h('tr', null, head.map((cell, cellIndex) => h('th', { key: cellIndex }, inline(cell))))),
								h('tbody', null, rest.map((row, rowIndex) => h('tr', { key: rowIndex },
									head.map((_, cellIndex) => h('td', { key: cellIndex }, inline(row[cellIndex] ?? '')))))))));
					}
					continue;
				}

				// 引用：连续 > 行
				if (/^>\s?/.test(trimmed)) {
					flush();
					const quoted = [];
					while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
						quoted.push(lines[index].trim().replace(/^>\s?/, ''));
						index += 1;
					}
					index -= 1;
					out.push(h('blockquote', { key: out.length, className: 'dsh-kb-quote' },
						quoted.map((item, itemIndex) => h('p', { key: itemIndex, className: 'dsh-kb-p' }, inline(item)))));
					continue;
				}

				// 列表：- / * / + 与 1.
				const bullet = /^([-*+])\s+(.*)$/.exec(trimmed);
				const numbered = /^(\d{1,2})[.)]\s+(.*)$/.exec(trimmed);
				if (bullet || numbered) {
					flush();
					const ordered = Boolean(numbered);
					const items = [];
					while (index < lines.length) {
						const next = lines[index].trim();
						const hit = ordered ? /^(\d{1,2})[.)]\s+(.*)$/.exec(next) : /^([-*+])\s+(.*)$/.exec(next);
						if (!hit) break;
						items.push(hit[2]);
						index += 1;
					}
					index -= 1;
					out.push(h(ordered ? 'ol' : 'ul', { key: out.length, className: 'dsh-kb-list' },
						items.map((item, itemIndex) => h('li', { key: itemIndex }, inline(item)))));
					continue;
				}

				if (!trimmed) {
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
			const partialTimer = React.useRef(null);
			// Office 原版式：先让 Host 把每页渲染成图片，界面自己拼阅读器
			React.useEffect(() => {
				const target = state.doc;
				if (!target || !OFFICE_EXT.includes(target.ext)) return undefined;
				if (state.previewMode === 'text' || state.caps?.officePreview === false) return undefined;
				if (state.previewInfo?.docId === target.id && !state.previewInfo?.partial) return undefined;
				let cancelled = false;
				let tries = 0;
				const timer = setTimeout(() => {
					if (!cancelled && state.previewInfo?.docId !== target.id) {
						patch({ previewError: '页面渲染超过 90 秒还没好；可以切到「文字版」，或「下载」原件。' });
					}
				}, 90000);

				const fetchInfo = async () => {
					try {
						const data = await api(`/doc?id=${encodeURIComponent(target.id)}&action=previewinfo`);
						if (cancelled) return;
						patch({
							previewInfo: {
								docId: target.id,
								pages: data.pages,
								pageCount: data.pageCount,
								truncated: Boolean(data.truncated),
								partial: Boolean(data.partial),
								width: data.width,
								height: data.height,
							},
							previewError: '',
						});
						// 首屏几页出来了、后面的还在后台补：过几秒再问一次
						if (data.partial && tries < 20) {
							tries += 1;
							partialTimer.current = setTimeout(fetchInfo, 3000);
						}
					} catch (error) {
						if (cancelled) return;
						const message = error.message || '预览生成失败';
						patch({ previewInfo: { docId: target.id, error: message }, previewError: message });
					}
				};

				fetchInfo();
				return () => {
					cancelled = true;
					clearTimeout(timer);
					if (partialTimer.current) clearTimeout(partialTimer.current);
				};
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
					h('p', null, current.nodes.length ? '从左边选一个文件，或把文件拖进来。' : '这个知识库还是空的。点「上传文件」或把文件拖进来。'),
					h('p', { className: 'dsh-kb-hint' }, '文件只存在这台电脑上，不会上传到云端。'));
			}
			const failed = doc.status === 'failed';
			const pending = doc.status === 'pending' || doc.status === 'parsing';
			const office = OFFICE_EXT.includes(doc.ext);
			const isSheet = SHEET_EXT.includes(doc.ext);
			const previewAvailable = current.caps?.officePreview !== false;
			const officeVisual = office && previewAvailable && current.previewMode !== 'text';
			const visual = isImage(doc.ext) || isSheet ? false : (doc.ext === 'pdf' || officeVisual);
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
							}, isSheet ? '表格' : '原版式'),
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
				// 预览失败的具体原因在下面那块里给（带按钮），这里不重复
				current.previewError && !(current.previewInfo?.docId === doc.id && current.previewInfo?.error)
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
							: isSheet && current.previewMode !== 'text'
								? h(SheetTable, { doc })
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
											h('span', { className: 'dsh-kb-pageTotal' }, `/ ${officeInfo.pageCount || officeInfo.pages}`),
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
											officeInfo.truncated || officeInfo.partial
												? h('div', { className: 'dsh-kb-pagesNote' },
													officeInfo.partial
														? `已生成 ${officeInfo.pages} / 共 ${officeInfo.pageCount || '?'} 页，后面的页面正在后台渲染，稍等几秒会自动出现。`
														: `共 ${officeInfo.pageCount || '?'} 页，这里只渲染了前 ${officeInfo.pages} 页。`)
												: null))
										: current.previewInfo?.docId === doc.id && current.previewInfo?.error
											? h('div', { className: 'dsh-kb-pagesLoading dsh-kb-pagesLoading--error' },
												h('div', { className: 'dsh-kb-pagesErrorTitle' },
													h(Icon, { name: 'warn', size: 16 }), '原版式预览用不了'),
												h('p', { className: 'dsh-kb-pagesErrorText' }, current.previewInfo.error),
												h('div', { className: 'dsh-kb-row2' },
													h('button', {
														type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary',
														onClick: () => patch({ previewMode: 'text' }),
													}, '看文字版'),
													h('button', {
														type: 'button', className: 'dsh-kb-btn',
														onClick: () => {
															patch({ previewInfo: null, previewError: '' });
														},
													}, '重试')))
											: h('div', { className: 'dsh-kb-pagesLoading' },
												h('span', { className: 'dsh-kb-spinner', 'aria-hidden': 'true' }),
												'正在渲染页面…第一次打开会慢一些，之后是缓存。'))
								: h('div', { className: 'dsh-kb-text' }, renderMarkdown(current.docText, current.query)),
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
		// 表格渲染：纯函数，方便测试与复用（文档页 / 大屏都用它）
		function sheetNodes(data, tab, onTab) {
			const sheets = data?.sheets || [];
			if (!sheets.length) return [h('div', { key: 'empty', className: 'dsh-kb-hint' }, '这个文件里没有工作表。')];
			const index = Math.min(Math.max(0, Number(tab) || 0), sheets.length - 1);
			const sheet = sheets[index];
			if (!sheet || !sheet.rows || !sheet.rows.length) return [h('div', { key: 'empty', className: 'dsh-kb-hint' }, '这张表是空的。')];
			const head = sheet.rows[0];
			const rows = sheet.rows.slice(1);
			const width = Math.max(head.length, ...rows.map((row) => row.length), 1);
			const cellAt = (row, at) => (row[at] == null ? '' : String(row[at]));
			return [
				sheets.length > 1
					? h('div', { key: 'tabs', className: 'dsh-kb-sheetTabs' }, sheets.map((item, at) => h('button', {
						type: 'button', key: at,
						className: cx('dsh-kb-sheetTab', at === index && 'dsh-kb-sheetTab--on'),
						onClick: () => onTab?.(at),
					}, item.name)))
					: null,
				h('div', { key: 'scroll', className: 'dsh-kb-sheetScroll' },
					h('table', { className: 'dsh-kb-sheetTbl' },
						h('thead', null, h('tr', null, Array.from({ length: width }, (_, at) => h('th', { key: at }, cellAt(head, at))))),
						h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: rowIndex },
							Array.from({ length: width }, (_, at) => h('td', { key: at }, cellAt(row, at)))))))),
				h('div', { key: 'foot', className: 'dsh-kb-sheetFoot' },
					`${sheet.rows.length} 行 × ${width} 列` + (sheet.totalRows && sheet.totalRows > sheet.rows.length ? `（原表 ${sheet.totalRows} 行，只显示前 ${sheet.rows.length} 行）` : ''),
					h('span', null, ' · 要改格式就点「下载」用 Excel 打开')),
			];
		}

		// 表格视图：自己抓网格，文档页和大屏都用它
		function SheetTable({ doc }) {
			const [data, setData] = React.useState(null);
			const [tab, setTab] = React.useState(0);
			const [error, setError] = React.useState('');
			React.useEffect(() => {
				let cancelled = false;
				setData(null);
				setError('');
				setTab(0);
				(async () => {
					try {
						const payload = await api(`/doc?id=${encodeURIComponent(doc.id)}&action=grid`);
						if (cancelled) return;
						setData({ sheets: payload.sheets || [] });
					} catch (err) {
						if (cancelled) return;
						setError(err.message || '表格解析失败');
					}
				})();
				return () => { cancelled = true; };
			}, [doc.id]);
			if (error) {
				return h('div', { className: 'dsh-kb-banner dsh-kb-banner--bad' },
					h(Icon, { name: 'warn', size: 15 }),
					h('span', null, error));
			}
			if (!data) return h('div', { className: 'dsh-kb-hint' }, '正在读取表格…');
			return h('div', { className: 'dsh-kb-sheet' }, sheetNodes(data, tab, setTab));
		}

		function BigView({ doc }) {
			const current = useStore();
			const office = OFFICE_EXT.includes(doc.ext);
			const isSheetDoc = SHEET_EXT.includes(doc.ext);
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
					office && info && !isSheetDoc
						? h('span', { className: 'dsh-kb-bigNav' },
							h('button', { type: 'button', className: 'dsh-kb-navBtn', title: '上一页', disabled: page <= 1, onClick: () => go(page - 1) }, '‹'),
							h('span', { className: 'dsh-kb-pageTotal' }, `${page} / ${info.pageCount || info.pages}`),
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
						: isSheetDoc
							? h('div', { className: 'dsh-kb-bigSheet' }, h(SheetTable, { doc }))
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
							: TEXT_DOC_EXT.includes(doc.ext)
								? h('div', { className: 'dsh-kb-bigText' },
									h('div', { className: 'dsh-kb-text dsh-kb-text--big' },
										current.docText
											? renderMarkdown(current.docText, current.query)
											: h('div', { className: 'dsh-kb-hint' }, doc.status === 'pending' || doc.status === 'parsing' ? '正在解析，稍等一下…' : '没有可显示的正文')))
								: h('div', { className: 'dsh-kb-pagesLoading' },
									h('span', { className: 'dsh-kb-spinner', 'aria-hidden': 'true' }),
									office ? '正在渲染页面…' : '这个格式没有大屏预览，可以点「下载」用系统应用打开')));
		}

		// ── 看板：知识库规模 + 检索情况 ─────────────────────────────────────
		function Dashboard() {
			const current = useStore();
			const data = current.dashData;
			const error = current.dashError;
			const loading = Boolean(current.dashLoading);

			const load = async () => {
				patch({ dashLoading: true });
				try {
					const result = await api('/dashboard');
					patch({ dashData: result, dashError: '' });
				} catch (problem) {
					patch({ dashError: problem.message || '读取统计失败' });
				} finally {
					patch({ dashLoading: false });
				}
			};

			React.useEffect(() => { if (!state.dashData) load(); }, []);

			if (error && !data) {
				return h('div', { className: 'dsh-kb-dash' },
					h('div', { className: 'dsh-kb-banner dsh-kb-banner--bad', role: 'alert' }, error),
					h('button', { type: 'button', className: 'dsh-kb-btn', onClick: load }, '重试'));
			}
			if (!data) return h('div', { className: 'dsh-kb-hint dsh-kb-hint--pad' }, loading ? '统计中…' : '');

			const stats = data.stats || {};
			const search = data.search || {};
			const coverage = stats.chunks ? Math.round(((stats.vectors || 0) / stats.chunks) * 100) : 0;
			const maxExt = Math.max(1, ...(data.byExt || []).map((item) => item.docs));
			const maxTrend = Math.max(1, ...(data.trend || []).map((item) => item.count));
			const statusLabel = { ready: '已索引', parsing: '解析中', pending: '排队', failed: '失败' };
			const statusColor = { ready: 'ok', parsing: 'busy', pending: 'idle', failed: 'bad' };

			const card = (label, value, hint) => h('div', { className: 'dsh-kb-metric', key: label },
				h('span', { className: 'dsh-kb-metricLabel' }, label),
				h('strong', { className: 'dsh-kb-metricValue' }, value),
				hint ? h('span', { className: 'dsh-kb-metricHint' }, hint) : null);

			return h('div', { className: 'dsh-kb-dash' },
				h('div', { className: 'dsh-kb-dashHead' },
					h('div', { className: 'dsh-kb-docTitle' }, '知识库看板'),
					h('span', { className: 'dsh-kb-hint' }, `数据目录 ${data.root || ''}`),
					h('span', { className: 'dsh-kb-viewerGrow' }),
					h('button', { type: 'button', className: 'dsh-kb-btn', onClick: load, disabled: loading },
						h(Icon, { name: 'refresh', size: 13 }), loading ? '刷新中…' : '刷新')),

				h('div', { className: 'dsh-kb-metrics' },
					card('知识库', stats.kbs ?? 0, '个'),
					card('文档', stats.docs ?? 0, `共 ${bytes(stats.bytes)}`),
					card('检索片段', stats.chunks ?? 0, `平均 ${stats.docs ? Math.round((stats.chunks || 0) / stats.docs) : 0} 段/篇`),
					card('向量', stats.vectors ?? 0, `覆盖率 ${coverage}%`),
					card('检索次数', search.total ?? 0, `今日 ${search.today ?? 0}`)),

				h('div', { className: 'dsh-kb-dashGrid' },
					// 文件类型分布
					h('section', { className: 'dsh-kb-card' },
						h('h4', null, '文件类型分布'),
						(data.byExt || []).length === 0
							? h('p', { className: 'dsh-kb-hint' }, '还没有文档')
							: (data.byExt || []).map((item) => h('div', { className: 'dsh-kb-distRow', key: item.ext },
								h('span', { className: 'dsh-kb-distLabel' }, `.${item.ext}`),
								h('span', { className: 'dsh-kb-bar' },
									h('i', { style: { width: `${Math.round((item.docs / maxExt) * 100)}%` } })),
								h('span', { className: 'dsh-kb-distValue' }, `${item.docs} · ${bytes(item.bytes)}`)))),

					// 解析状态
					h('section', { className: 'dsh-kb-card' },
						h('h4', null, '解析状态'),
						h('div', { className: 'dsh-kb-chips' },
							Object.entries(data.byStatus || {}).map(([status, count]) => h('span', {
								className: `dsh-kb-chip dsh-kb-chip--${statusColor[status] || 'idle'}`,
								key: status,
							}, `${statusLabel[status] || status} ${count}`))),
						h('h4', { className: 'dsh-kb-subHead' }, '各知识库'),
						(data.byKb || []).map((kb) => h('div', { className: 'dsh-kb-distRow', key: kb.id },
							h('span', { className: 'dsh-kb-distLabel dsh-kb-distLabel--wide' }, kb.name),
							h('span', { className: 'dsh-kb-distValue' }, `${kb.docs} 篇 · ${bytes(kb.bytes)}`)))),

					// 检索趋势
					h('section', { className: 'dsh-kb-card' },
						h('h4', null, '最近 7 天检索'),
						(data.trend || []).length === 0
							? h('p', { className: 'dsh-kb-hint' }, '还没有检索记录（搜索框或 AI 检索都会记）')
							: h('div', { className: 'dsh-kb-spark' },
								(data.trend || []).map((item) => h('div', { className: 'dsh-kb-sparkCol', key: item.day, title: `${item.day}：${item.count} 次` },
									h('div', { className: 'dsh-kb-sparkBar', style: { height: `${Math.max(4, Math.round((item.count / maxTrend) * 100))}%` } }),
									h('span', { className: 'dsh-kb-sparkLabel' }, (item.day || '').slice(5))))),
						h('div', { className: 'dsh-kb-kv dsh-kb-kv--tight' },
							h('span', null, '零命中率'), h('strong', null, `${search.zeroRate ?? 0}%`),
							h('span', null, '平均耗时'), h('strong', null, `${search.avgMs ?? 0} ms`),
							h('span', null, '混合检索'), h('strong', null, `${search.hybrid ?? 0} 次`),
							h('span', null, '最近一次'), h('strong', null, search.lastAt ? when(search.lastAt) : '—'))),

					// 热门检索词 + 最近检索
					h('section', { className: 'dsh-kb-card' },
						h('h4', null, '热门检索词'),
						(data.topQueries || []).length === 0
							? h('p', { className: 'dsh-kb-hint' }, '还没有')
							: h('div', { className: 'dsh-kb-chips' },
								(data.topQueries || []).map((item) => h('span', { className: 'dsh-kb-chip', key: item.query }, `${item.query} · ${item.count}`))),
						h('h4', { className: 'dsh-kb-subHead' }, '最近检索'),
						(data.recent || []).length === 0
							? h('p', { className: 'dsh-kb-hint' }, '还没有')
							: h('div', { className: 'dsh-kb-list' },
								(data.recent || []).map((item, index) => h('div', { className: 'dsh-kb-listRow', key: `${item.ts}-${index}` },
									h('span', { className: 'dsh-kb-listMain' }, item.query || '（空查询）'),
									h('span', { className: 'dsh-kb-listMeta' }, `${item.hits} 命中 · ${item.mode} · ${item.tookMs}ms`),
									h('span', { className: 'dsh-kb-listTime' }, when(item.ts)))))),

					// 最近添加
					h('section', { className: 'dsh-kb-card' },
						h('h4', null, '最近添加'),
						(data.recentDocs || []).length === 0
							? h('p', { className: 'dsh-kb-hint' }, '还没有文档')
							: h('div', { className: 'dsh-kb-list' },
								(data.recentDocs || []).map((doc) => h('div', { className: 'dsh-kb-listRow', key: doc.id },
									h('span', { className: 'dsh-kb-listMain' }, doc.name),
									h('span', { className: 'dsh-kb-listMeta' }, `.${doc.ext} · ${bytes(doc.bytes)} · ${statusLabel[doc.status] || doc.status}`),
									h('span', { className: 'dsh-kb-listTime' }, when(doc.createdAt))))))));
		}

		// ── 主页面 ──────────────────────────────────────────────────────────
		// 「问 AI」的会话入口由 apply 注入（组件拿不到 ctx）
		let sessionStarter = null;

		// 检验报告：按行拆成 结论 / 分项 / 其它说明，别让用户读一大坨
		const REPORT_KEYS = /^(结论|共性短板|建议复习|建议|备注|总评)[:：]/;
		function renderReport(text) {
			const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
			const blocks = lines.map((line) => {
				if (REPORT_KEYS.test(line)) {
					const idx = line.search(/[:：]/);
					return { kind: 'key', label: line.slice(0, idx), text: line.slice(idx + 1).trim() };
				}
				if (/^[-·•*]\s*/.test(line)) {
					const body = line.replace(/^[-·•*]\s*/, '');
					const split = body.search(/[:：]/);
					return split > 0
						? { kind: 'item', label: body.slice(0, split), text: body.slice(split + 1).trim() }
						: { kind: 'item', label: '', text: body };
				}
				return { kind: 'para', text: line };
			});
			return blocks.map((block, index) => {
				if (block.kind === 'key') {
					return h('div', { key: index, className: 'dsh-kb-rpKey' },
						h('span', { className: 'dsh-kb-rpKeyName' }, block.label),
						h('span', null, block.text));
				}
				if (block.kind === 'item') {
					return h('div', { key: index, className: 'dsh-kb-rpItem' },
						h('span', { className: 'dsh-kb-rpDot' }, '·'),
						block.label ? h('span', { className: 'dsh-kb-rpLabel' }, block.label) : null,
						h('span', { className: 'dsh-kb-rpText' }, block.text));
				}
				return h('div', { key: index, className: 'dsh-kb-rpPara' }, block.text);
			});
		}

		// ── 学习主题（对练）────────────────────────────────────────────────
		// 面板只做两件事：① 选范围 ② 管卡片。
		// 定目标、拆大纲全部交给 DSH 会话（agent 用 kb_search/kb_read 读库，
		// 谈定后调用 kb_topic_save 把结果写回知识库）。
		function Exam() {
			const current = useStore();
			const [view, setView] = React.useState('list');
			const [topics, setTopics] = React.useState(null);
			const [busy, setBusy] = React.useState('');
			const [error, setError] = React.useState('');
			const [notice, setNotice] = React.useState('');
			// 对练记录：runsFor = 展开的是哪个主题；openedRun = 正在看的那一次
			const [runs, setRuns] = React.useState([]);
			const [openedRun, setOpenedRun] = React.useState(null);
			const [openItems, setOpenItems] = React.useState([]);
			// 卡片右下角「⋯」菜单（详情 / 删除）
			const [menuFor, setMenuFor] = React.useState('');
			// 右侧栏显示哪个：对练记录 or 题库
			const [sideView, setSideView] = React.useState('runs');
			const [quizItems, setQuizItems] = React.useState([]);
			const [recordFor, setRecordFor] = React.useState(null);
			const [sideWidth, setSideWidth] = React.useState(430);
			const [sideFull, setSideFull] = React.useState(false);
			const [detailFor, setDetailFor] = React.useState('');
			// 标题悬浮提示（原生 title 太慢、样式不跟主题，自己做一个）
			const [tip, setTip] = React.useState(null);
			const tipTimer = React.useRef(null);
			const showTip = (event, text) => {
				const rect = event.currentTarget.getBoundingClientRect();
				if (tipTimer.current) clearTimeout(tipTimer.current);
				tipTimer.current = setTimeout(() => {
					const above = rect.bottom + 120 > window.innerHeight;
					setTip({ text, left: rect.left, top: above ? rect.top - 8 : rect.bottom + 8, above });
				}, 200);
			};
			const hideTip = () => {
				if (tipTimer.current) clearTimeout(tipTimer.current);
				setTip(null);
			};

			const docIds = Array.isArray(current.examPicked) ? current.examPicked : [];
			const setDocIds = (next) => patch({ examPicked: typeof next === 'function' ? next(docIds) : next });
			const kbId = current.kbId || '';
			const kbName = current.kbs.find((item) => item.id === kbId)?.name ?? '（未选库）';
			const docs = (current.nodes || []).filter((node) => node.kind === 'doc');
			const picked = docs.filter((doc) => docIds.includes(doc.id));
			const size = (n) => (n >= 10000 ? `约 ${Math.round(n / 1000)}k 字` : `${n} 字`);

			React.useEffect(() => {
				const ids = (current.nodes || []).filter((node) => node.kind === 'doc').map((node) => node.id);
				const kept = (current.examPicked || []).filter((id) => ids.includes(id));
				patch({ examPicked: kept.length ? kept : ids });
			}, [current.kbId, (current.nodes || []).length]);

			/** 404 基本都是"服务端还在跑旧代码"——说清楚，别让人以为是功能坏了。 */
			const friendly = (err) => {
				const message = String(err?.message || err || '');
				if (/HTTP 404|找不到|not found/i.test(message)) {
					return '插件服务端还是旧版本：请完全退出 DeepSeek Harness 再重新打开（只刷新页面不够）';
				}
				return message || '出错了';
			};

			async function loadTopics() {
				setBusy((value) => value || '正在读…');
				try {
					const data = await api('/exam/topics');
					setTopics(data.topics || []);
				} catch (err) {
					setError(friendly(err));
					setTopics([]);
				} finally { setBusy(''); }
			}
			React.useEffect(() => { loadTopics(); }, []);

			/** 选好范围后：不在这里调模型，直接开一个会话让 AI 和用户一起定目标、拆大纲。 */
			async function startDesign() {
				if (!current.kbId) { setError('先在左边选一个知识库'); return; }
				if (!docIds.length) { setError('先在左边勾选要考的文档'); return; }
				setError(''); setBusy('正在准备会话…');
				try {
					const url = `/exam/topic/design-prompt?kbId=${encodeURIComponent(kbId)}`
						+ `&docIds=${encodeURIComponent(docIds.join(','))}`;
					const data = await api(url);
					if (typeof sessionStarter !== 'function') {
						setError('会话服务还没就绪，稍后再点一次');
						return;
					}
					sessionStarter(data.prompt);
					setNotice('已打开会话：和 AI 把目标和大纲谈定，它会把结果写回知识库');
				} catch (err) {
					setError(friendly(err));
				} finally { setBusy(''); }
			}

			async function toggleRuns(topic) {
				if (recordFor?.id === topic.id && sideView === 'runs') { setRecordFor(null); setRuns([]); setOpenedRun(null); return; }
				setRecordFor(topic); setSideView('runs'); setRuns([]); setOpenedRun(null); setSideFull(false);
				try {
					const data = await api(`/exam/runs?topicId=${encodeURIComponent(topic.id)}`);
					setRuns(data.runs || []);
				} catch (err) {
					setError(friendly(err));
				}
			}

			async function toggleQuiz(topic) {
				if (recordFor?.id === topic.id && sideView === 'quiz') { setRecordFor(null); setQuizItems([]); return; }
				setRecordFor(topic); setSideView('quiz'); setQuizItems([]); setOpenedRun(null); setSideFull(false);
				try {
					const data = await api(`/exam/quiz?topicId=${encodeURIComponent(topic.id)}`);
					setQuizItems(data.items || []);
				} catch (err) {
					setError(friendly(err));
				}
			}

			// 拖左边缘调宽：侧栏贴在右边，所以宽度 = 视口右边到指针的距离
			// 菜单开着时，点菜单以外的地方就收起（点在菜单/⋯ 上不处理，否则 click 到不了菜单项）
			React.useEffect(() => {
				if (!menuFor) return undefined;
				const close = (event) => {
					const target = event.target;
					if (target instanceof Element && target.closest('.dsh-kb-menuWrap')) return;
					setMenuFor('');
				};
				window.addEventListener('mousedown', close);
				return () => window.removeEventListener('mousedown', close);
			}, [menuFor]);

			function startResize(event) {
				event.preventDefault();
				const onMove = (moveEvent) => {
					const next = Math.max(320, Math.min(760, window.innerWidth - moveEvent.clientX - 16));
					setSideWidth(next);
				};
				const onUp = () => {
					window.removeEventListener('mousemove', onMove);
					window.removeEventListener('mouseup', onUp);
				};
				window.addEventListener('mousemove', onMove);
				window.addEventListener('mouseup', onUp);
			}

			async function openRun(run) {
				if (openedRun?.id === run.id) { setOpenedRun(null); return; }
				try {
					const data = await api(`/exam/run?id=${encodeURIComponent(run.id)}`);
					setOpenedRun(data.run);
				} catch (err) {
					setError(friendly(err));
				}
			}

			async function startChat(topic, mode) {
				setError('');
				try {
					const data = await api(`/exam/topic/prompt?id=${encodeURIComponent(topic.id)}&mode=${mode === 'quiz' ? 'quiz' : 'spar'}`);
					if (typeof sessionStarter !== 'function') {
						setError('会话服务还没就绪，稍后再点一次');
						return;
					}
					sessionStarter(data.prompt);
					setNotice('已打开会话，题目已经放在输入框里，按回车开始');
				} catch (err) {
					setError(friendly(err));
				}
			}

			async function removeTopic(topic) {
				const doDelete = async () => {
					try {
						await api('/exam/topic/delete', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ id: topic.id }),
						});
						await loadTopics();
					} catch (err) {
						setError(err.message || '删除失败');
					}
				};
				if (typeof askConfirm === 'function') {
					askConfirm(`删除学习主题「${String(topic.objective).slice(0, 20)}…」？会一并删除这个主题的对练记录、逐题记录和题库题目；知识库里的文档不受影响。`, doDelete);
					return;
				}
				await doDelete();
			}

			const errorBar = error
				? h('div', { className: 'dsh-kb-banner dsh-kb-banner--bad' },
					h('span', null, error),
					h('button', { type: 'button', className: 'dsh-kb-bannerClose', onClick: () => setError('') },
						h(Icon, { name: 'close', size: 12 })))
				: null;
			const noticeBar = notice
				? h('div', { className: 'dsh-kb-banner dsh-kb-banner--info' },
					h('span', null, notice),
					h('button', { type: 'button', className: 'dsh-kb-bannerClose', onClick: () => setNotice('') },
						h(Icon, { name: 'close', size: 12 })))
				: null;

			// ① 卡片列表（左列）+ 对练记录（右列）
			if (view === 'list') {
				const list = topics ?? [];

				// 一次对练的逐题：题干独占一行，回答/点评默认收起，分数用颜色区分
				const scoreTone = (score) => {
					if (score == null) return '';
					if (score >= 80) return 'dsh-kb-runScore--good';
					if (score >= 60) return 'dsh-kb-runScore--mid';
					return 'dsh-kb-runScore--bad';
				};
				const runDetail = (run) => {
					if (openedRun?.id !== run.id || (!openedRun.items?.length && !openedRun.summary)) return null;
					const verdictLabel = openedRun.verdict === 'pass' ? '达成'
						: openedRun.verdict === 'near' ? '接近' : openedRun.verdict === 'fail' ? '未达成' : '';
					const reportBlock = !openedRun.summary ? null : h('div', { className: 'dsh-kb-runReport' },
						h('div', { className: 'dsh-kb-runReportHead' },
							h('span', { className: 'dsh-kb-runReportTitle' }, '检验报告'),
							verdictLabel
								? h('span', {
									className: cx('dsh-kb-runScore',
										openedRun.verdict === 'pass' ? 'dsh-kb-runScore--good'
											: openedRun.verdict === 'near' ? 'dsh-kb-runScore--mid' : 'dsh-kb-runScore--bad'),
								}, verdictLabel)
								: null),
						h('div', { className: 'dsh-kb-runReportBody' }, renderReport(openedRun.summary)));
					return h('div', { className: 'dsh-kb-runBody' }, reportBlock,
						openedRun.items.map((item) => {
							const open = openItems.includes(item.id);
							const hasMore = Boolean(item.answer || item.comment);
							return h('div', { key: item.id, className: 'dsh-kb-runItem' },
								h('div', { className: 'dsh-kb-runHeadRow' },
									h('span', { className: 'dsh-kb-runNo' }, `Q${item.seq}`),
									item.kpTitle ? h('span', { className: 'dsh-kb-runKp' }, item.kpTitle) : null,
									item.score != null
										? h('span', { className: cx('dsh-kb-runScore', scoreTone(item.score)) }, `${item.score} 分`)
										: null,
									h('span', { className: 'dsh-kb-viewerGrow' }),
									hasMore
										? h('button', {
											type: 'button', className: 'dsh-kb-runToggle',
											onClick: () => setOpenItems((list) => (open ? list.filter((id) => id !== item.id) : list.concat(item.id))),
										}, open ? '收起' : '看回答')
										: null),
								h('div', { className: 'dsh-kb-runQ' }, item.question),
								open && item.answer ? h('div', { className: 'dsh-kb-runA' }, item.answer) : null,
								open && item.comment ? h('div', { className: 'dsh-kb-runC' }, item.comment) : null);
						}));
				};

				// 卡片统一高度：默认只显示 2 行标题 + 一行元信息，大纲等细节收进「详情」
				// 卡片统一高度：默认只显示 2 行标题 + 一行元信息，大纲等细节收进「详情」
				// 卡片：标题 + 元信息 + 底部两组按钮 + 右下角「⋯」菜单（详情/删除）
				const card = (topic) => {
					const open = detailFor === topic.id;
					const menuOpen = menuFor === topic.id;
					return h('div', { key: topic.id, className: 'dsh-kb-topic' },
						h('div', { className: 'dsh-kb-topicHead' },
							h('div', { className: 'dsh-kb-topicTitle dsh-kb-clamp2', title: topic.objective }, topic.objective)),
						h('div', { className: 'dsh-kb-topicMeta' },
							`${topic.kbName || '知识库'} · ${topic.docIds.length || '整库'} 篇 · ${topic.outline.length} 个知识点 · ${topic.totalTurns || 10} 题 · ${when(topic.createdAt)}`),
						open
							? h('div', { className: 'dsh-kb-topicDetail' },
								h('div', { className: 'dsh-kb-topicKps' },
									topic.outline.map((kp, index) => h('span', { key: kp.id ?? index, className: 'dsh-kb-topicKp' },
										`${index + 1}. ${kp.title}`))),
								topic.docIds.length
									? h('p', { className: 'dsh-kb-hint' }, `考 ${topic.docIds.length} 篇文档`)
									: h('p', { className: 'dsh-kb-hint' }, '考整库'))
							: null,
						h('div', { className: 'dsh-kb-topicFoot' },
							h('div', { className: 'dsh-kb-btnGroup' },
								h('button', {
									type: 'button', className: 'dsh-kb-gBtn dsh-kb-gBtn--primary',
									onClick: () => startChat(topic, 'spar'),
									title: '一问一答，AI 追问、点评、给达成判定',
								}, 'AI 对练'),
								h('button', {
									type: 'button', className: 'dsh-kb-gBtn',
									onClick: () => startChat(topic, 'quiz'),
									title: '单选/多选为主，判完对错顺手存进题库',
								}, '刷题')),
							h('div', { className: 'dsh-kb-btnGroup' },
								h('button', {
									type: 'button',
									className: cx('dsh-kb-gBtn', recordFor?.id === topic.id && sideView === 'runs' && 'dsh-kb-gBtn--on'),
									onClick: () => toggleRuns(topic),
								}, '对练记录'),
								h('button', {
									type: 'button',
									className: cx('dsh-kb-gBtn', recordFor?.id === topic.id && sideView === 'quiz' && 'dsh-kb-gBtn--on'),
									onClick: () => toggleQuiz(topic),
								}, '题库')),
							h('span', { className: 'dsh-kb-viewerGrow' }),
							h('span', { className: 'dsh-kb-menuWrap' },
								h('button', {
									type: 'button',
									className: cx('dsh-kb-menuBtn', menuOpen && 'dsh-kb-menuBtn--on'),
									onClick: () => setMenuFor(menuOpen ? '' : topic.id),
									title: '更多',
								}, '⋯'),
								menuOpen
									? h('div', { className: 'dsh-kb-cardMenu' },
										h('button', {
											type: 'button', className: 'dsh-kb-cardMenuItem',
											onClick: () => { setMenuFor(''); setDetailFor(open ? '' : topic.id); },
										}, open ? '收起详情' : '详情'),
										h('button', {
											type: 'button', className: 'dsh-kb-cardMenuItem dsh-kb-cardMenuItem--danger',
											onClick: () => { setMenuFor(''); removeTopic(topic); },
										}, '删除'))
									: null)));
				};

				const leftColumn = h('div', {
					className: 'dsh-kb-examCol',
					style: { flex: '1 1 auto', minWidth: 0, display: sideFull ? 'none' : 'flex', flexDirection: 'column', gap: '12px', overflow: 'auto' },
				},
					h('div', { className: 'dsh-kb-examHead' },
						h('div', { className: 'dsh-kb-examTitle' }, '学习主题'),
						h('span', { className: 'dsh-kb-examScopeLabel' }, topics === null ? '加载中…' : `${list.length} 个`),
						h('span', { className: 'dsh-kb-viewerGrow' }),
						h('button', { type: 'button', className: 'dsh-kb-examMini', onClick: loadTopics, title: '刷新' }, '刷新'),
						h('button', {
							type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary',
							onClick: () => { setView('scope'); setError(''); setNotice(''); },
						}, '新建学习主题')),
					errorBar,
					noticeBar,
					list.length === 0
						? h('div', { className: 'dsh-kb-examCard dsh-kb-examEmpty' },
							h(Icon, { name: 'book', size: 22 }),
							h('p', { className: 'dsh-kb-examLead' }, '还没有学习主题。'),
							h('p', { className: 'dsh-kb-hint' },
								'建一个：选好要考的文件 → 打开会话，和 AI 把目标与大纲谈定 → 它写回这里，然后随时点开练。'),
							h('button', {
								type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary',
								onClick: () => { setView('scope'); setError(''); setNotice(''); },
							}, '新建学习主题'))
						: h('div', {
							className: 'dsh-kb-topicList',
							style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '10px', alignItems: 'stretch' },
						},
							list.map(card)));

				// 右列只在点了「对练记录」之后才存在，默认不占位、不空着
				// 右列：对练记录 / 题库，二选一显示；默认不存在
				const quizBody = quizItems.length === 0
					? h('div', { className: 'dsh-kb-runEmpty' },
						h('p', { className: 'dsh-kb-hint' }, '这个主题还没有刷过题。'),
						h('p', { className: 'dsh-kb-hint' }, '点卡片上的「刷题」开始，答过的题会自动收进这里。'))
					: h('div', { className: 'dsh-kb-quizList' },
						quizItems.map((item) => h('div', { key: item.id, className: 'dsh-kb-quizItem' },
							h('div', { className: 'dsh-kb-quizHead' },
								h('span', { className: 'dsh-kb-quizKind' }, item.answer.length > 1 ? '多选' : '单选'),
								item.kpTitle ? h('span', { className: 'dsh-kb-runKp' }, item.kpTitle) : null,
								h('span', { className: 'dsh-kb-viewerGrow' }),
								h('span', { className: 'dsh-kb-quizAnswer' }, `答案 ${item.answer.join('')}`)),
							h('div', { className: 'dsh-kb-quizStem' }, item.stem),
							h('div', { className: 'dsh-kb-quizOptions' },
								item.options.map((opt) => h('div', {
									key: opt.key,
									className: cx('dsh-kb-quizOption', item.answer.includes(opt.key) && 'dsh-kb-quizOption--right'),
								},
									h('span', { className: 'dsh-kb-quizKey' }, opt.key),
									h('span', null, opt.text)))),
							item.explanation ? h('div', { className: 'dsh-kb-quizWhy' }, item.explanation) : null)));

				const rightColumn = !recordFor ? null : h('div', {
					className: 'dsh-kb-examSide',
					style: sideFull
						? { flex: '1 1 100%', width: '100%', display: 'flex', flexDirection: 'column', padding: '12px 14px', background: 'var(--dsw-alias-bg-layer-1)', overflow: 'auto' }
						: { flex: '0 0 auto', width: `min(${sideWidth}px, 46vw)`, display: 'flex', flexDirection: 'column', padding: '12px 14px', borderLeft: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', overflow: 'auto' },
				},
					sideFull ? null : h('div', { className: 'dsh-kb-examSideHandle', onMouseDown: startResize, title: '拖动调宽' }),
					h('div', { className: 'dsh-kb-examSideInner', style: { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 } },
						h('div', { className: 'dsh-kb-examSideHead' },
							h('div', { className: 'dsh-kb-examTitle' }, sideView === 'quiz' ? '题库' : '对练记录'),
							h('span', { className: 'dsh-kb-examScopeLabel' }, sideView === 'quiz' ? `${quizItems.length} 题` : `${runs.length} 次`),
							h('span', { className: 'dsh-kb-viewerGrow' }),
							h('button', {
								type: 'button', className: 'dsh-kb-examMini',
								onClick: () => setSideFull((value) => !value),
								title: sideFull ? '退出全屏' : '全屏查看',
							}, sideFull ? '退出全屏' : '全屏'),
							h('button', {
								type: 'button', className: 'dsh-kb-examMini',
								onClick: () => { setRecordFor(null); setRuns([]); setOpenedRun(null); setQuizItems([]); setSideFull(false); },
								title: '关闭',
							}, h(Icon, { name: 'close', size: 12 }))),
						h('p', { className: 'dsh-kb-examSideTopic' }, recordFor.objective),
						sideView === 'quiz'
							? quizBody
							: runs.length === 0
								? h('div', { className: 'dsh-kb-runEmpty' },
									h('p', { className: 'dsh-kb-hint' }, '这个主题还没有对练记录。'),
									h('p', { className: 'dsh-kb-hint' }, '点「AI 对练」或「刷题」开始，每答完一题都会记下来。'),
									h('p', { className: 'dsh-kb-hint' }, '如果刚练过却是空的，点右上角「刷新」再看一次。'))
								: h('div', { className: 'dsh-kb-runList' },
									runs.map((run) => h('div', { key: run.id, className: 'dsh-kb-run' },
										h('button', {
											type: 'button',
											className: cx('dsh-kb-runHead', openedRun?.id === run.id && 'dsh-kb-runHead--on'),
											onClick: () => openRun(run),
										},
											h('span', { className: 'dsh-kb-runTime' }, when(run.startedAt)),
											h('span', { className: 'dsh-kb-runMeta' },
												`${run.turns} 题${run.verdict ? ` · ${run.verdict === 'pass' ? '达成' : run.verdict === 'near' ? '接近' : '未达成'}` : ' · 未结束'}${run.summary ? ' · 有报告' : ''}`)),
										runDetail(run))))));
				const tipLayer = !tip ? null : h('div', {
					className: 'dsh-kb-tip',
					style: { left: tip.left + 'px', top: tip.top + 'px', transform: tip.above ? 'translateY(-100%)' : 'none' },
				}, tip.text);

				return h('div', {
					className: 'dsh-kb-exam dsh-kb-exam--split',
					style: { display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: '14px', overflow: 'hidden' },
				}, leftColumn, rightColumn, tipLayer);
			}


			// ② 选范围 → 交给会话
			return h('div', { className: 'dsh-kb-exam' },
				h('div', { className: 'dsh-kb-examHead' },
					h('button', { type: 'button', className: 'dsh-kb-examMini', onClick: () => setView('list') }, '← 返回'),
					h('div', { className: 'dsh-kb-examTitle' }, '选范围'),
					h('span', { className: 'dsh-kb-examScopeLabel' }, `${kbName} · 已选 ${picked.length}/${docs.length} 篇`),
					h('span', { className: 'dsh-kb-viewerGrow' }),
					h('button', { type: 'button', className: 'dsh-kb-examMini', onClick: () => setDocIds(docs.map((doc) => doc.id)) }, '全选'),
					h('button', { type: 'button', className: 'dsh-kb-examMini', onClick: () => setDocIds([]) }, '清空')),
				errorBar,
				noticeBar,
				h('div', { className: 'dsh-kb-examCard' },
					h('p', { className: 'dsh-kb-examLead' }, '在左边文件树里勾选要考的文件（文件夹可以整块勾）。'),
					h('div', { className: 'dsh-kb-examPicks' },
						!current.kbId
							? h('p', { className: 'dsh-kb-hint' }, '先在左边选一个知识库。')
							: docs.length === 0
								? h('p', { className: 'dsh-kb-hint' }, '这个库里还没有文档，先上传。')
								: picked.length === 0
									? h('p', { className: 'dsh-kb-hint' }, '左边还没勾选任何文件。')
									: picked.map((doc) => h('div', { key: doc.id, className: 'dsh-kb-examPick', title: doc.name },
										h('span', { className: 'dsh-kb-examDocExt' }, String(doc.ext || '').replace(/^\./, '').toUpperCase() || 'FILE'),
										h('span', { className: 'dsh-kb-examPickName' }, doc.name),
										h('span', { className: 'dsh-kb-examPickMeta' }, doc.chars ? size(doc.chars) : '—')))),
					h('p', { className: 'dsh-kb-hint dsh-kb-examNote' },
						'下一步不在面板里做：会打开一个会话，AI 自己读这些文档，和你把学习目标与大纲谈定（题量默认 10 题，可以在对话里改）、写回知识库；'
						+ '存好后它可以直接在同一个会话里开练，也可以之后回这里点卡片上的「开始 AI 对练」。'),
					h('div', { className: 'dsh-kb-examFoot' },
						h('span', { className: 'dsh-kb-examFootHint' }, `将用 ${picked.length} 篇 · ${size(picked.reduce((sum, doc) => sum + (doc.chars || 0), 0))}`),
						h('button', {
							type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary',
							disabled: Boolean(busy) || !current.kbId || !picked.length,
							onClick: startDesign,
						}, busy || '在对话里定目标和大纲'))));
		}


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
				// 搜索时离开看板/设置，否则结果被挡住看不见
				patch({ query: value, view: value.trim() ? 'search' : 'doc', dashOpen: false, showSettings: false });
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
					if (!event.dataTransfer?.files?.length) return; // 树内拖动节点，不是外部文件
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
					h('span', { className: 'dsh-kb-seg', role: 'group', 'aria-label': '视图' },
						h('button', {
							type: 'button',
							className: cx('dsh-kb-segBtn', !current.dashOpen && !current.showSettings && 'dsh-kb-segBtn--on'),
							onClick: () => patch({ dashOpen: false, showSettings: false, examOpen: false }),
						}, '文档'),
						h('button', {
							type: 'button',
							className: cx('dsh-kb-segBtn', current.dashOpen && !current.showSettings && 'dsh-kb-segBtn--on'),
							onClick: () => patch({ dashOpen: true, showSettings: false, examOpen: false }),
						}, '数据看板'),
						h('button', {
							type: 'button',
							className: cx('dsh-kb-segBtn', current.examOpen && !current.showSettings && 'dsh-kb-segBtn--on'),
							onClick: () => patch({ dashOpen: false, showSettings: false, examOpen: true }),
						}, 'AI 实战对练')),
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
					}, h(Icon, { name: 'upload', size: 14 }), current.uploading ? `上传中 ${current.uploading}` : '上传文件'),
					h('input', {
						ref: fileInput, type: 'file', multiple: true, style: { display: 'none' },
						onChange: (event) => {
							// 从行菜单的「⋯ → 上传文件」进来时，落在对应文件夹里
							uploadFiles(event.target.files, state.importTarget || currentFolderId(current));
							event.target.value = '';
							patch({ importTarget: null });
						},
					}),
					h('button', {
						type: 'button', className: cx('dsh-kb-iconBtn', current.showSettings && 'dsh-kb-iconBtn--on'),
						title: '知识库设置',
						'aria-pressed': Boolean(current.showSettings),
						onClick: () => patch({ showSettings: !state.showSettings }),
					}, h(Icon, { name: 'settings', size: 15 })))),

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
										? h('div', { className: 'dsh-kb-hint dsh-kb-hint--pad' }, '空知识库：上传文件，或新建文件夹。')
										: null))
					: null, // 收起时不再画左侧竖条：顶部的箭头按钮就是展开入口
				h('div', { className: 'dsh-kb-main' },
					current.showSettings
						? h('div', { className: 'dsh-kb-settingsPane' },
							h('div', { className: 'dsh-kb-settingsHead' },
								h('div', { className: 'dsh-kb-docTitle' }, '知识库设置'),
								h('span', { className: 'dsh-kb-viewerGrow' }),
								h('button', {
									type: 'button', className: 'dsh-kb-btn',
									onClick: () => patch({ showSettings: false }),
								}, h(Icon, { name: 'chevron', size: 12, className: 'dsh-kb-rot180' }), '返回')),
							h(SettingsSection))
						: current.dashOpen
							? h(Dashboard)
							: current.examOpen
								? h(Exam)
								: (current.view === 'search' && current.query ? h(SearchView) : h(DocView, { onAsk, onReindex, onDelete }))),
			),
			h(Dialog),
			// 行操作菜单：fixed 定位，免得被树栏的滚动裁掉
			current.menu ? (() => {
				const node = current.nodes.find((entry) => entry.id === current.menu.id);
				if (!node) return null;
				const isFolder = node.kind === 'folder';
				const close = () => patch({ menu: null });
				const item = (label, onClick, danger) => h('button', {
					type: 'button', role: 'menuitem',
					className: cx('dsh-kb-menuItem', danger && 'dsh-kb-menuItem--danger'),
					onClick: (event) => {
						event?.stopPropagation?.();
						close();
						onClick();
					},
				}, label);
				return h(React.Fragment, null,
					h('div', { className: 'dsh-kb-menuBackdrop', onClick: close }),
					h('div', {
						className: 'dsh-kb-menu', role: 'menu',
						style: { left: `${current.menu.x}px`, top: `${current.menu.y}px` },
					},
					isFolder
						? item('新建子文件夹', () => askText('新文件夹的名字', '新文件夹', (name) => nodeAction('create', {
							kbId: node.kbId, parentId: node.id, kind: 'folder', name,
						})))
						: null,
					// 文件夹传到自己这儿；文件传到它所在的文件夹 —— 任何一行都能上传
					item(isFolder ? '上传文件到这里' : '上传文件到所在文件夹', () => {
						patch({ importTarget: isFolder ? node.id : (node.parentId || null) });
						fileInput.current?.click();
					}),
					item('重命名', () => askText('重命名', node.name, (name) => nodeAction('rename', { id: node.id, name }))),
					item('移动到…', () => askMove(node)),
					item('删除', () => askConfirm(
						`删除「${node.name}」？${isFolder ? '里面的内容也会一起删除。' : '原文件也会被删掉。'}`,
						() => nodeAction('delete', { id: node.id }),
					), true)));
			})() : null,
			current.bigView && current.doc ? h(BigView, { doc: current.doc }) : null);
		}

		// ── 设置分区 ────────────────────────────────────────────────────────
		function SettingsSection() {
			const current = useStore();
			const [form, setForm] = React.useState(null);
			const [saving, setSaving] = React.useState(false);
			const [probing, setProbing] = React.useState(false);
			const [probe, setProbe] = React.useState(null);
			const [formNotice, setFormNotice] = React.useState('');
			// 图片理解（视觉模型）那一块自己的表单状态
			const [visionForm, setVisionForm] = React.useState(null);
			const [visionSaving, setVisionSaving] = React.useState(false);
			const [visionProbing, setVisionProbing] = React.useState(false);
			const [visionProbe, setVisionProbe] = React.useState(null);
			const [visionNotice, setVisionNotice] = React.useState('');
			const [visionPresets, setVisionPresets] = React.useState([]);
			const [rebuilding, setRebuilding] = React.useState(false);
			const watchRef = React.useRef(null);

			const stopWatch = () => {
				if (watchRef.current) {
					clearInterval(watchRef.current);
					watchRef.current = null;
				}
			};

			/** 点重建后每 1 秒刷一次状态，全部解析完就停。 */
			const startWatch = () => {
				stopWatch();
				watchRef.current = setInterval(async () => {
					try { await loadState(state.kbId, true); } catch { /* ignore */ }
					const progress = state.progress;
					if (!progress || (progress.pending + progress.parsing) === 0) {
						stopWatch();
						setRebuilding(false);
					}
				}, 1000);
			};

			React.useEffect(() => () => stopWatch(), []);

			const rebuildAll = async () => {
				if (rebuilding) return;
				try {
					const data = await api('/reindex-all', { method: 'POST' });
					patch({ notice: `已排队重建 ${data.queued} 篇文档的索引`, error: '' });
					setRebuilding(true);
					startWatch();
				} catch (error) {
					patch({ error: error.message || '重建失败' });
				}
			};
			React.useEffect(() => {
				if (!state.loaded) loadState();
				let cancelled = false;
				api('/settings')
					.then((data) => {
						if (cancelled) return;
						setForm({ ...data.embedding, apiKey: '' });
						setVisionForm({ ...(data.vision || { enabled: false, baseUrl: '', model: '' }), apiKey: '' });
						setVisionPresets(Array.isArray(data.visionPresets) ? data.visionPresets : []);
					})
					.catch(() => {
						if (cancelled) return;
						setForm({ enabled: false, baseUrl: '', model: '', apiKey: '', hasKey: false, keyTail: '' });
						setVisionForm({ enabled: false, baseUrl: '', model: '', apiKey: '', hasKey: false, keyTail: '' });
					});
				return () => { cancelled = true; };
			}, []);

			const saveVision = async () => {
				if (!visionForm || visionSaving) return;
				setVisionSaving(true);
				setVisionNotice('');
				try {
					const data = await api('/settings', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							vision: {
								enabled: Boolean(visionForm.enabled),
								baseUrl: visionForm.baseUrl,
								model: visionForm.model,
								apiKey: visionForm.apiKey,
							},
						}),
					});
					setVisionForm({ ...(data.vision || {}), apiKey: '' });
					setVisionNotice('已保存，立即生效');
					await loadState(state.kbId, true);
				} catch (error) {
					setVisionNotice(`保存失败：${error.message || error}`);
				} finally {
					setVisionSaving(false);
				}
			};

			const testVision = async () => {
				if (!visionForm || visionProbing) return;
				setVisionProbing(true);
				setVisionProbe(null);
				try {
					const data = await api('/vision-test', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ baseUrl: visionForm.baseUrl, model: visionForm.model, apiKey: visionForm.apiKey }),
					});
					setVisionProbe(data.probe || { ok: false, error: '没有返回结果' });
				} catch (error) {
					setVisionProbe({ ok: false, error: error.message || String(error) });
				} finally {
					setVisionProbing(false);
				}
			};

			const saveEmbedding = async () => {
				if (!form || saving) return;
				setSaving(true);
				setFormNotice('');
				try {
					const data = await api('/settings', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							embedding: {
								enabled: Boolean(form.enabled),
								baseUrl: form.baseUrl,
								model: form.model,
								apiKey: form.apiKey,
							},
						}),
					});
					setForm({ ...data.embedding, apiKey: '' });
					setFormNotice('已保存，立即生效');
					await loadState(state.kbId, true);
				} catch (error) {
					setFormNotice(`保存失败：${error.message || error}`);
				} finally {
					setSaving(false);
				}
			};

			const testEmbedding = async () => {
				if (!form || probing) return;
				setProbing(true);
				setProbe(null);
				try {
					const data = await api('/embedding-test', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ baseUrl: form.baseUrl, model: form.model, apiKey: form.apiKey }),
					});
					setProbe(data.probe || { ok: false, error: '没有返回结果' });
				} catch (error) {
					setProbe({ ok: false, error: error.message || String(error) });
				} finally {
					setProbing(false);
				}
			};

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
					(() => {
						const progress = current.progress;
						if (!progress) return null;
						const working = progress.pending + progress.parsing;
						if (!rebuilding && working === 0) return null;
						const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
						return h('div', { className: 'dsh-kb-progress', role: 'status' },
							h('div', { className: 'dsh-kb-progressTrack' },
								h('div', { className: 'dsh-kb-progressFill', style: { width: `${pct}%` } })),
							h('div', { className: 'dsh-kb-progressText' },
								working > 0
									? `重建中：已完成 ${progress.done} / ${progress.total} 篇`
										+ `${progress.parsing ? ` · 解析中 ${progress.parsing}` : ''}`
										+ `${progress.queued ? ` · 排队 ${progress.queued}` : ''}`
									: `重建完成：${progress.done} / ${progress.total} 篇`));
					})(),
					h('div', { className: 'dsh-kb-row2' },
						h('button', {
							type: 'button', className: 'dsh-kb-btn',
							onClick: rebuildAll, disabled: rebuilding,
						}, h(Icon, { name: 'refresh', size: 14 }), rebuilding ? '重建中…' : '重建全部索引'),
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
					h('h4', null, '向量检索（可选）'),
					h('p', { className: 'dsh-kb-hint' },
						'关键词检索已经可用。想让「意思相近但用词不同」也能命中，接一个 OpenAI 兼容的 embeddings 接口 —— DeepSeek 官方没有这个接口，可以接百炼 / 硅基流动 / Ollama。'),
					form
						? h('div', { className: 'dsh-kb-form' },
							h('label', { className: 'dsh-kb-check' },
								h('input', {
									type: 'checkbox',
									checked: Boolean(form.enabled),
									onChange: (event) => setForm({ ...form, enabled: event.target.checked }),
								}),
								'启用向量检索'),
							h('label', { className: 'dsh-kb-field' },
								h('span', { className: 'dsh-kb-label' }, '接口地址'),
								h('input', {
									type: 'text',
									value: form.baseUrl || '',
									placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
									onChange: (event) => setForm({ ...form, baseUrl: event.target.value }),
								}),
								h('span', { className: 'dsh-kb-hint' }, '填到 /v1 为止，不要带 /embeddings')),
							h('label', { className: 'dsh-kb-field' },
								h('span', { className: 'dsh-kb-label' }, '模型'),
								h('input', {
									type: 'text',
									value: form.model || '',
									placeholder: 'text-embedding-v3',
									onChange: (event) => setForm({ ...form, model: event.target.value }),
								})),
							h('label', { className: 'dsh-kb-field' },
								h('span', { className: 'dsh-kb-label' }, 'API Key'),
								h('input', {
									type: 'password',
									value: form.apiKey || '',
									placeholder: form.hasKey ? `已保存（尾号 ${form.keyTail}），留空表示不改` : '接口不需要鉴权就留空',
									onChange: (event) => setForm({ ...form, apiKey: event.target.value }),
								}),
								h('span', { className: 'dsh-kb-hint' }, '只存在本机 ~/.dsh/kb/settings.json，不会写进插件配置')),
							h('div', { className: 'dsh-kb-row2' },
								h('button', {
									type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary',
									onClick: saveEmbedding, disabled: saving,
								}, saving ? '保存中…' : '保存'),
								h('button', {
									type: 'button', className: 'dsh-kb-btn',
									onClick: testEmbedding, disabled: probing,
								}, probing ? '测试中…' : '测试连接')),
							probe
								? h('div', { className: cx('dsh-kb-banner', probe.ok ? 'dsh-kb-banner--ok' : 'dsh-kb-banner--bad'), role: 'status' },
									probe.ok ? `连接成功：返回 ${probe.dim} 维向量（${probe.model}）` : `连接失败：${probe.error}`)
								: null,
							formNotice ? h('p', { className: 'dsh-kb-hint' }, formNotice) : null,
							form.enabled && (stats?.vectors || 0) === 0 && embedding?.enabled
								? h('p', { className: 'dsh-kb-hint' }, '已启用，但现有文档还没有向量 —— 点上面「重建全部索引」补上（只补新增文档不算）。')
								: null)
						: h('p', { className: 'dsh-kb-hint' }, '读取配置中…'),
					embedding?.enabled
						? h('p', { className: 'dsh-kb-hint' }, `当前状态：已启用 · 模型 ${embedding.model} · 检索时与关键词结果融合（RRF）`)
						: null),
				// ── 图片理解（视觉模型）──────────────────────────────────────
				h('section', { className: 'dsh-kb-card' },
					h('h4', null, '图片理解（可选）'),
					h('p', { className: 'dsh-kb-hint' },
						'图片本身没有文字，所以默认搜不到。打开这里，上传或重建时会用视觉模型把图「描述成文字」，再走同一套关键词 + 向量检索 —— 命中后 AI 也能读出图里写了什么。'),
					visionForm
						? h('div', { className: 'dsh-kb-form' },
							h('label', { className: 'dsh-kb-check' },
								h('input', {
									type: 'checkbox',
									checked: Boolean(visionForm.enabled),
									onChange: (event) => setVisionForm({ ...visionForm, enabled: event.target.checked }),
								}),
								'启用图片理解'),
							h('label', { className: 'dsh-kb-field' },
								h('span', { className: 'dsh-kb-label' }, '服务商'),
								h('select', {
									className: 'dsh-kb-select',
									value: visionForm.preset || 'dashscope',
									onChange: (event) => {
										const id = event.target.value;
										const preset = visionPresets.find((item) => item.id === id);
										if (!preset) return;
										setVisionForm({
											...visionForm,
											preset: id,
											baseUrl: preset.baseUrl || visionForm.baseUrl,
											model: preset.model || visionForm.model,
										});
									},
								}, (visionPresets.length ? visionPresets : [{ id: 'dashscope', label: '阿里云百炼' }, { id: 'custom', label: '自定义' }])
									.map((preset) => h('option', { key: preset.id, value: preset.id }, preset.label))),
								h('span', { className: 'dsh-kb-hint' },
									(visionPresets.find((item) => item.id === visionForm.preset) || {}).hint
									|| '选一个服务商，接口地址和模型会自动填好；也可以选「自定义」手填')),
							h('label', { className: 'dsh-kb-field' },
								h('span', { className: 'dsh-kb-label' }, '接口地址'),
								h('input', {
									type: 'text',
									value: visionForm.baseUrl || '',
									placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
									onChange: (event) => {
										const value = event.target.value;
										const normalized = value.trim().replace(/\/+$/, '');
										const matched = visionPresets.find((item) => item.baseUrl && item.baseUrl === normalized);
										setVisionForm({ ...visionForm, baseUrl: value, preset: matched ? matched.id : 'custom' });
									},
								}),
								h('span', { className: 'dsh-kb-hint' }, '和向量检索一样填到 /v1 为止（自定义端点也行，只要兼容 /chat/completions）')),
							h('label', { className: 'dsh-kb-field' },
								h('span', { className: 'dsh-kb-label' }, '视觉模型'),
								h('input', {
									type: 'text',
									value: visionForm.model || '',
									placeholder: 'qwen3-vl-plus',
									onChange: (event) => setVisionForm({ ...visionForm, model: event.target.value }),
								}),
								h('span', { className: 'dsh-kb-hint' }, '百炼用 qwen3-vl-plus；OpenAI 用 gpt-4o-mini 也行')),
							h('label', { className: 'dsh-kb-field' },
								h('span', { className: 'dsh-kb-label' }, 'API Key'),
								h('input', {
									type: 'password',
									value: visionForm.apiKey || '',
									placeholder: visionForm.hasKey
										? `已保存（尾号 ${visionForm.keyTail}），留空表示不改`
										: '留空则复用向量检索那把 Key',
									onChange: (event) => setVisionForm({ ...visionForm, apiKey: event.target.value }),
								})),
							h('div', { className: 'dsh-kb-row2' },
								h('button', {
									type: 'button', className: 'dsh-kb-btn dsh-kb-btn--primary',
									onClick: saveVision, disabled: visionSaving,
								}, visionSaving ? '保存中…' : '保存'),
								h('button', {
									type: 'button', className: 'dsh-kb-btn',
									onClick: testVision, disabled: visionProbing,
								}, visionProbing ? '测试中…' : '测试连接')),
							visionProbe
								? h('div', { className: cx('dsh-kb-banner', visionProbe.ok ? 'dsh-kb-banner--ok' : 'dsh-kb-banner--bad'), role: 'status' },
									visionProbe.ok
										? `连接成功：${visionProbe.model} · ${visionProbe.ms} ms · 返回「${visionProbe.sample || ''}…」`
										: `连接失败：${visionProbe.error}`)
								: null,
							visionNotice ? h('p', { className: 'dsh-kb-hint' }, visionNotice) : null,
							visionForm.enabled && !current.caps?.vision?.enabled
								? h('p', { className: 'dsh-kb-hint' }, '已勾选但还没生效：检查接口地址和模型，保存后这里会显示「已启用」。')
								: null)
						: h('p', { className: 'dsh-kb-hint' }, '读取配置中…'),
					current.caps?.vision?.enabled
						? h('p', { className: 'dsh-kb-hint' },
							`当前状态：已启用 · 模型 ${current.caps.vision.model} · 新建或重建索引时会把图片描述成文字`)
						: h('p', { className: 'dsh-kb-hint' }, '当前状态：未启用（图片只能看，搜不到）')),
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
				'.dsh-kb-btn--primary{white-space:nowrap;border-color:transparent;background:var(--dsw-alias-label-brand,#1f6feb);color:#fff;}',
				'.dsh-kb-btn--primary:hover{filter:brightness(1.06);background:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-btn--danger{color:var(--dsw-alias-label-danger,#d14343);}',
				'.dsh-kb-banner{display:flex;align-items:center;gap:8px;padding:7px 16px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-banner--info{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-banner--bad{background:rgba(209,67,67,.10);color:var(--dsw-alias-label-danger,#d14343);}',
				'.dsh-kb-bannerClose{margin-left:auto;border:none;background:transparent;color:inherit;cursor:pointer;display:inline-flex;}',
				'.dsh-kb-body{display:flex;flex:1;min-height:0;}',
				'.dsh-kb-side{width:250px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow-y:auto;padding:6px 0 20px;}',
				'.dsh-kb-rot180{transform:rotate(180deg);}',
				'.dsh-kb-moreBtn{font-size:15px;line-height:1;letter-spacing:1px;padding-bottom:3px;}',
				'.dsh-kb-rowBtn--on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-menuBackdrop{position:fixed;inset:0;z-index:40;}',
				'.dsh-kb-menu{position:fixed;z-index:41;width:184px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 28px rgba(0,0,0,.3);display:flex;flex-direction:column;}',
				'.dsh-kb-menuItem{display:flex;align-items:center;height:30px;padding:0 10px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer;}',
				'.dsh-kb-menuItem:hover{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-menuItem--danger{color:var(--dsw-alias-label-danger,#d14343);}',
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
				'.dsh-kb-pagesLoading--error{gap:12px;}',
				'.dsh-kb-pagesErrorTitle{display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-pagesErrorText{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.6;max-width:560px;}',
				'.dsh-kb-pagesLoading{flex:1;min-height:320px;display:flex;align-items:center;justify-content:center;gap:8px;padding:0 24px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6;background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-text{max-width:820px;font-size:13.5px;line-height:1.78;}',
				'.dsh-kb-p{margin:0 0 10px;white-space:pre-wrap;word-break:break-word;}',
				'.dsh-kb-h{margin:16px 0 8px;font-weight:600;}',
				'.dsh-kb-h1{font-size:16px;}.dsh-kb-h2{font-size:15px;}.dsh-kb-h3{font-size:14px;}.dsh-kb-h4,.dsh-kb-h5,.dsh-kb-h6{font-size:13.5px;}',
				'.dsh-kb-pageMark{margin:14px 0 6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.04em;}',
  '.dsh-kb-sheet{display:flex;flex-direction:column;min-height:0;flex:1;gap:0;width:100%;color:var(--dsw-alias-label-primary);}',
  '.dsh-kb-sheetTabs{display:flex;gap:6px;padding:8px 10px 0;flex-wrap:wrap;}',
  '.dsh-kb-sheetTab{border:1px solid var(--dsw-alias-border-light);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 10px;border-radius:8px;cursor:pointer;}',
  '.dsh-kb-sheetTab--on{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600;}',
  '.dsh-kb-sheetScroll{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-light);border-radius:10px;margin:8px 10px 0;background:var(--dsw-alias-bg-layer-1);}',
  '.dsh-kb-sheetTbl{border-collapse:separate;border-spacing:0;font-size:12.5px;white-space:nowrap;min-width:100%;color:var(--dsw-alias-label-primary);}',
  '.dsh-kb-sheetTbl th,.dsh-kb-sheetTbl td{padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-light);border-right:1px solid var(--dsw-alias-border-light);text-align:left;color:inherit;}',
  '.dsh-kb-sheetTbl th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-3);font-weight:600;}',
  '.dsh-kb-sheetTbl tbody tr:nth-child(even) td{background:var(--dsw-alias-bg-layer-2);}',
  '.dsh-kb-sheetFoot{padding:8px 12px 12px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
  '.dsh-kb-quote{margin:0 0 10px;padding:8px 12px;border-left:3px solid var(--dsw-alias-border-light);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;}',
  '.dsh-kb-quote .dsh-kb-p{margin:0 0 6px;}',
  '.dsh-kb-hr{border:none;border-top:1px solid var(--dsw-alias-border-light);margin:14px 0;}',
  '.dsh-kb-inlineCode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 4px;}',
  '.dsh-kb-link{color:var(--dsw-alias-label-primary);text-decoration:underline;}',
  '.dsh-kb-mdTblWrap{overflow-x:auto;margin:0 0 12px;border:1px solid var(--dsw-alias-border-light);border-radius:8px;}',
  '.dsh-kb-mdTbl{border-collapse:collapse;font-size:12.5px;min-width:100%;}',
  '.dsh-kb-mdTbl th,.dsh-kb-mdTbl td{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-light);border-right:1px solid var(--dsw-alias-border-light);text-align:left;vertical-align:top;}',
  '.dsh-kb-mdTbl th{background:var(--dsw-alias-bg-layer-2);font-weight:600;}',
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
				'.dsh-kb-settingsPane{display:flex;flex-direction:column;flex:1;min-height:0;padding:14px 20px 36px;overflow-y:auto;}',
				'.dsh-kb-settingsHead{display:flex;align-items:center;gap:10px;margin-bottom:14px;}',
				'.dsh-kb-iconBtn--on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-settingsIntro{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-card{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;}',
				'.dsh-kb-card h4{margin:0;font-size:13px;font-weight:600;}',
				'.dsh-kb-code{display:block;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Menlo,monospace;font-size:11.5px;word-break:break-all;}',
				'.dsh-kb-kv{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:6px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);align-items:center;}',
				'.dsh-kb-kv strong{color:var(--dsw-alias-label-primary);font-weight:600;}',
				'.dsh-kb-row2{display:flex;gap:8px;}',
				'.dsh-kb-form{display:flex;flex-direction:column;gap:10px;}',
				'.dsh-kb-check{display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;}',
				'.dsh-kb-check input{width:14px;height:14px;margin:0;}',
				'.dsh-kb-field{display:flex;flex-direction:column;gap:4px;}',
				'.dsh-kb-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-form input[type=text],.dsh-kb-form input[type=password]{box-sizing:border-box;width:100%;height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:12.5px;}',
				'.dsh-kb-form input:focus{outline:none;border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-banner--ok{background:rgba(34,160,90,.12);color:#228a4e;}',
				'.dsh-kb-progress{display:flex;flex-direction:column;gap:5px;margin:2px 0 4px;}',
				'.dsh-kb-progressTrack{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}',
				'.dsh-kb-progressFill{height:100%;border-radius:999px;background:var(--dsw-alias-label-brand,#1f6feb);transition:width .25s ease;}',
				'.dsh-kb-progressText{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				// 看板
				'.dsh-kb-dash{display:flex;flex-direction:column;gap:14px;flex:1;min-height:0;overflow-y:auto;padding:16px 20px 36px;}',
				'.dsh-kb-dashHead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
				'.dsh-kb-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;}',
				'.dsh-kb-metric{display:flex;flex-direction:column;gap:2px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-metricLabel{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-metricValue{font-size:20px;font-weight:700;line-height:1.3;}',
				'.dsh-kb-metricHint{font-size:11px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-dashGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;align-items:start;}',
				'.dsh-kb-subHead{margin-top:12px!important;}',
				'.dsh-kb-distRow{display:flex;align-items:center;gap:8px;font-size:12px;}',
				'.dsh-kb-distLabel{flex:none;width:46px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Menlo,monospace;font-size:11.5px;}',
				'.dsh-kb-distLabel--wide{width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:inherit;color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-distValue{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-bar{flex:1;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}',
				'.dsh-kb-bar i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-chips{display:flex;flex-wrap:wrap;gap:6px;}',
				'.dsh-kb-chip{padding:2px 8px;border-radius:999px;font-size:11.5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-chip--ok{color:#228a4e;border-color:rgba(34,160,90,.4);}',
				'.dsh-kb-chip--bad{color:var(--dsw-alias-label-danger,#d14343);border-color:rgba(209,67,67,.4);}',
				'.dsh-kb-chip--busy{color:#a8741a;border-color:rgba(217,164,65,.5);}',
				'.dsh-kb-spark{display:flex;align-items:flex-end;gap:6px;height:76px;padding:6px 2px 0;}',
				'.dsh-kb-sparkCol{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;height:100%;}',
				'.dsh-kb-sparkBar{width:100%;max-width:26px;border-radius:4px 4px 0 0;background:var(--dsw-alias-label-brand,#1f6feb);opacity:.75;}',
				'.dsh-kb-sparkLabel{font-size:10px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-kv--tight{grid-template-columns:auto 1fr auto 1fr;font-size:11.5px;}',
				'.dsh-kb-list{display:flex;flex-direction:column;gap:4px;}',
				'.dsh-kb-listRow{display:flex;align-items:baseline;gap:8px;font-size:12px;padding:3px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);}',
				'.dsh-kb-listRow:last-child{border-bottom:none;}',
				'.dsh-kb-listMain{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
				'.dsh-kb-listMeta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-listTime{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);width:56px;text-align:right;}',
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
  '.dsh-kb-bigBar{display:flex;flex:none;align-items:center;gap:10px;min-height:44px;padding:10px 152px 10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-bigTitle{font-size:13px;font-weight:600;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
				'.dsh-kb-bigNav{display:flex;align-items:center;gap:8px;}',
				'.dsh-kb-bigBody .dsh-kb-pages--single .dsh-kb-pageShot{max-width:1400px;}',
				'.dsh-kb-bigBody{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);}',
  '.dsh-kb-bigSheet{flex:1;min-height:0;display:flex;flex-direction:column;padding:14px 18px 20px;}',
  '.dsh-kb-bigSheet .dsh-kb-sheetTbl{font-size:14px;}',
  '.dsh-kb-bigText{flex:1;min-height:0;overflow:auto;padding:28px 40px 60px;display:flex;justify-content:center;}',
  '.dsh-kb-text--big{max-width:900px;width:100%;font-size:15px;line-height:1.9;}',
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
				'.dsh-kb-exam{display:flex;flex-direction:column;gap:12px;padding:16px;height:100%;min-height:0;overflow:auto;box-sizing:border-box;}',
				'.dsh-kb-examSteps{display:flex;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examStep{padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-examStep--on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-examStep--done{color:var(--dsw-alias-label-brand,#1f6feb);border-color:currentColor;}',
				'.dsh-kb-examCard{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
				'.dsh-kb-examLead{margin:0;font-size:13px;line-height:1.6;}',
				'.dsh-kb-examField{display:flex;align-items:center;gap:8px;font-size:12.5px;}',
				'.dsh-kb-examField--stack{flex-direction:column;align-items:stretch;gap:6px;}',
				'.dsh-kb-examTextarea{width:100%;box-sizing:border-box;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:12.5px;line-height:1.6;resize:vertical;}',
				'.dsh-kb-examTextarea:focus{outline:none;border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-examActions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;}',
				'.dsh-kb-examObj{display:flex;flex-direction:column;gap:3px;padding:10px;text-align:left;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;cursor:pointer;}',
				'.dsh-kb-examObj:hover{border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-examObj--on{border-color:var(--dsw-alias-label-brand,#1f6feb);background:var(--dsw-alias-bg-layer-1);}',
				'.dsh-kb-examObjText{font-size:12.5px;line-height:1.6;}',
				'.dsh-kb-examObjMeta{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examKpList{display:flex;flex-direction:column;gap:7px;}',
				'.dsh-kb-examKp{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;}',
				'.dsh-kb-examKpMeta{color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap;}',
				'.dsh-kb-exam--live{padding:12px 16px;}',
				'.dsh-kb-examTop{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}',
				'.dsh-kb-examScore{padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:11.5px;}',
				'.dsh-kb-examList{flex:1;min-height:140px;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:4px 2px;}',
				'.dsh-kb-msg{max-width:86%;padding:8px 10px;border-radius:10px;font-size:12.5px;line-height:1.65;border:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-msg--ai{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-msg--me{align-self:flex-end;background:var(--dsw-alias-bg-layer-1);}',
				'.dsh-kb-msg--ok{border-color:#2da44e;}',
				'.dsh-kb-msg--mid{border-color:#bf8700;}',
				'.dsh-kb-msg--bad{border-color:#cf222e;}',
				'.dsh-kb-msgTag{margin-right:6px;padding:0 5px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:11px;}',
				'.dsh-kb-msgRefs{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;}',
				'.dsh-kb-msgRef{font-size:11px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-msgGradeHead{display:flex;gap:8px;font-size:12px;font-weight:600;}',
				'.dsh-kb-msgMissing{margin-top:3px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examInput{display:flex;gap:8px;align-items:flex-end;}',
				'.dsh-kb-examTextarea--answer{flex:1;}',
				'.dsh-kb-examVerdict{display:flex;align-items:baseline;gap:8px;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:12px;}',
				'.dsh-kb-examVerdict strong{font-size:16px;}',
				'.dsh-kb-examVerdict--ok strong{color:#2da44e;}',
				'.dsh-kb-examVerdict--mid strong{color:#bf8700;}',
				'.dsh-kb-examVerdict--bad strong{color:#cf222e;}',
				'.dsh-kb-examBar{display:flex;align-items:center;gap:8px;font-size:12.5px;}',
				'.dsh-kb-examBarTitle{width:130px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
				'.dsh-kb-examBarTrack{flex:1;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}',
				'.dsh-kb-examBarFill{display:block;height:100%;border-radius:999px;background:#2da44e;}',
				'.dsh-kb-examBarFill--mid{background:#bf8700;}',
				'.dsh-kb-examBarFill--bad{background:#cf222e;}',
				'.dsh-kb-examBarScore{width:100px;flex:none;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11.5px;}',
				'.dsh-kb-examWeak{display:flex;flex-direction:column;gap:5px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-examWeakTitle{font-size:12px;font-weight:600;}',
				'.dsh-kb-examWeakRow{display:flex;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examModel{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-examModel--bad{color:#cf222e;background:transparent;border:1px dashed #cf222e;}',
				'.dsh-kb-examScope{display:flex;align-items:center;gap:8px;font-size:12.5px;}',
				'.dsh-kb-examScopeLabel{color:var(--dsw-alias-label-secondary);flex:none;white-space:nowrap;}',
				'.dsh-kb-examScopeBtn{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;}',
				'.dsh-kb-examScopeBtn:hover{border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-examDocs{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow:auto;padding:4px 2px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;}',
				'.dsh-kb-examDocs--tree{max-height:300px;}',
				'.dsh-kb-examDoc{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;font-size:12.5px;cursor:pointer;}',
				'.dsh-kb-examDoc:hover{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-examDocName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
				'.dsh-kb-examDocMeta{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;}',
				'.dsh-kb-examMode{display:flex;flex-wrap:wrap;gap:8px;}',
				'.dsh-kb-examModeItem{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;font-size:12.5px;cursor:pointer;}',
				'.dsh-kb-examModeItem--on{border-color:var(--dsw-alias-label-brand,#1f6feb);background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-examHead{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;min-width:0;}',
				'.dsh-kb-examTitle{font-size:14px;font-weight:600;flex:none;white-space:nowrap;}',
				'.dsh-kb-examKb{max-width:220px;}',
				'.dsh-kb-examModes{display:grid;grid-template-columns:1fr 1fr;gap:8px;}',
				'.dsh-kb-examModeCard{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}',
				'.dsh-kb-examModeCard:hover{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-examModeCard--on{border-color:var(--dsw-alias-label-brand,#1f6feb);background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-examModeTitle{font-size:12.5px;font-weight:600;}',
				'.dsh-kb-examModeSub{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examNote{margin:0;}',
				'.dsh-kb-examPicker{display:flex;flex-direction:column;gap:6px;}',
				'.dsh-kb-examPickerBar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
				'.dsh-kb-examPickerCount{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examFilter{height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:11.5px;max-width:180px;}',
				'.dsh-kb-examMini{padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer;flex:none;white-space:nowrap;}',
				'.dsh-kb-examMini:hover{border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-examDoc--on{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-examDocExt{width:36px;flex:none;font-size:10px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-examFootHint{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examModel{display:flex;align-items:center;gap:6px;}',
				'.dsh-kb-examDoc--folder{color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examDoc--folder .dsh-kb-examDocName{color:var(--dsw-alias-label-primary);font-weight:500;}',
				'.dsh-kb-examPicks{display:flex;flex-direction:column;gap:3px;max-height:320px;overflow:auto;padding:8px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;}',
				'.dsh-kb-examPick{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:3px 4px;border-radius:6px;}',
				'.dsh-kb-examPick--folder{color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examPickName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
				'.dsh-kb-examPickMeta{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;}',
				'.dsh-kb-rowPick{margin:0 2px 0 0;flex:none;cursor:pointer;}',
				'.dsh-kb-topicList{display:flex;flex-direction:column;gap:10px;}',
				'.dsh-kb-topic{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}',
				'.dsh-kb-topic:hover{border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-topicHead{display:flex;align-items:flex-start;gap:8px;}',
				'.dsh-kb-topicTitle{font-size:13px;font-weight:600;line-height:1.5;}',
				'.dsh-kb-topicMeta{font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-topicKps{display:flex;flex-wrap:wrap;gap:6px;}',
				'.dsh-kb-topicKp{padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-topicFoot{display:flex;align-items:center;gap:8px;}',
				'.dsh-kb-examEmpty{align-items:center;text-align:center;}',
				'.dsh-kb-outlineList{display:flex;flex-direction:column;gap:6px;}',
				'.dsh-kb-outlineRow{display:flex;align-items:center;gap:8px;}',
				'.dsh-kb-outlineNo{width:18px;flex:none;text-align:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-outlineInput{flex:1;min-width:0;height:28px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:12.5px;}',
				'.dsh-kb-outlineInput:focus{outline:none;border-color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-outlineMeta{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-examObjPoints{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;}',
				'.dsh-kb-examObjPoint{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-size:11px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-runList{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);}',
				'.dsh-kb-run{display:flex;flex-direction:column;gap:4px;}',
				'.dsh-kb-runHead{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;text-align:left;}',
				'.dsh-kb-runHead--on{border-color:var(--dsw-alias-label-brand,#1f6feb);background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-runTime{color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-runMeta{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11.5px;}',
				'.dsh-kb-examSideHead{display:flex;align-items:center;gap:8px;}',
				'.dsh-kb-examSideTopic{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin:0;}',
				'.dsh-kb-examMini--on{border-color:var(--dsw-alias-label-brand,#1f6feb);color:var(--dsw-alias-label-brand,#1f6feb);}',
				'.dsh-kb-runEmpty{display:flex;flex-direction:column;gap:4px;}',
				'.dsh-kb-runEmpty .dsh-kb-hint{margin:0;}',
				'.dsh-kb-examSideHandle{position:absolute;left:-6px;top:8px;bottom:8px;width:10px;cursor:col-resize;}',
				'.dsh-kb-examSideHandle:hover{background:linear-gradient(90deg,transparent,rgba(127,127,127,.28));}',
				'.dsh-kb-topic{padding:12px 14px;gap:6px;min-height:118px;justify-content:flex-start;}',
				'.dsh-kb-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
				'.dsh-kb-topicDetail{display:flex;flex-direction:column;gap:6px;padding:8px 0 2px;border-top:1px dashed var(--dsw-alias-border-l1);}',
				'.dsh-kb-topicDetail .dsh-kb-hint{margin:0;}',
				'.dsh-kb-topic{display:flex;flex-direction:column;min-height:132px;box-sizing:border-box;}',
				'.dsh-kb-topicFoot{margin-top:auto;padding-top:8px;}',
				'.dsh-kb-tip{position:fixed;z-index:80;max-width:440px;padding:8px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.65;box-shadow:0 8px 28px rgba(0,0,0,.28);pointer-events:none;white-space:normal;word-break:break-word;}',
				'.dsh-kb-runBody{display:flex;flex-direction:column;gap:2px;padding:4px 0 2px;}',
				'.dsh-kb-runItem{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-runItem:last-child{border-bottom:none;}',
				'.dsh-kb-runHeadRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
				'.dsh-kb-runNo{flex:none;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-runKp{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-runScore{flex:none;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:600;}',
				'.dsh-kb-runScore--good{background:rgba(35,134,54,.16);color:#2da44e;}',
				'.dsh-kb-runScore--mid{background:rgba(212,167,44,.18);color:#bf8700;}',
				'.dsh-kb-runScore--bad{background:rgba(207,34,46,.14);color:#cf222e;}',
				'.dsh-kb-runToggle{flex:none;padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;}',
				'.dsh-kb-runToggle:hover{border-color:var(--dsw-alias-label-brand,#1f6feb);color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-runQ{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;}',
				'.dsh-kb-runA{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;word-break:break-word;}',
				'.dsh-kb-runC{font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;}',
				'.dsh-kb-runReport{display:flex;flex-direction:column;gap:6px;padding:10px 12px;margin:2px 0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-runReportHead{display:flex;align-items:center;gap:8px;}',
				'.dsh-kb-runReportTitle{font-size:12.5px;font-weight:600;}',
				'.dsh-kb-runReportBody{font-size:12px;line-height:1.75;white-space:pre-wrap;word-break:break-word;}',
				'.dsh-kb-runReportBody{display:flex;flex-direction:column;gap:5px;font-size:12px;line-height:1.7;white-space:normal;}',
				'.dsh-kb-rpPara{color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-rpKey{display:flex;gap:6px;padding:2px 0;}',
				'.dsh-kb-rpKeyName{flex:none;font-weight:600;color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-rpItem{display:flex;gap:5px;padding-left:2px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-rpDot{flex:none;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-rpLabel{flex:none;color:var(--dsw-alias-label-primary);font-weight:500;}',
				'.dsh-kb-rpText{min-width:0;word-break:break-word;}',
				'.dsh-kb-quizList{display:flex;flex-direction:column;gap:10px;}',
				'.dsh-kb-quizItem{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-quizItem:last-child{border-bottom:none;}',
				'.dsh-kb-quizHead{display:flex;align-items:center;gap:6px;}',
				'.dsh-kb-quizKind{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);}',
				'.dsh-kb-quizAnswer{flex:none;font-size:11.5px;font-weight:600;color:#2da44e;}',
				'.dsh-kb-quizStem{font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-primary);}',
				'.dsh-kb-quizOptions{display:flex;flex-direction:column;gap:3px;}',
				'.dsh-kb-quizOption{display:flex;gap:7px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);padding:2px 6px;border-radius:6px;}',
				'.dsh-kb-quizOption--right{background:rgba(35,134,54,.14);color:#2da44e;font-weight:500;}',
				'.dsh-kb-quizKey{flex:none;font-weight:600;}',
				'.dsh-kb-quizWhy{font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-divider{flex:none;width:1px;height:18px;background:var(--dsw-alias-border-l1);margin:0 2px;}',
				'.dsh-kb-topicFoot{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;margin-top:auto;padding-top:8px;min-width:0;}',
				'.dsh-kb-btnGroup{display:inline-flex;align-items:center;flex:0 1 auto;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;}',
				'.dsh-kb-gBtn{display:inline-flex;align-items:center;justify-content:center;height:26px;min-width:0;padding:0 8px;border:none;border-radius:0;background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-sizing:border-box;}',
				'.dsh-kb-btnGroup .dsh-kb-gBtn + .dsh-kb-gBtn{border-left:1px solid var(--dsw-alias-border-l1);}',
				'.dsh-kb-btnGroup .dsh-kb-gBtn:hover{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-gBtn--on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-brand,#1f6feb);font-weight:600;}',
				'.dsh-kb-gBtn--primary{background:var(--dsw-alias-label-brand,#1f6feb);color:#fff;}',
				'.dsh-kb-gBtn--primary:hover{filter:brightness(1.08);}',
				'.dsh-kb-gBtn--danger{color:#cf222e;}',
				'.dsh-kb-gBtn--danger:hover{background:rgba(207,34,46,.12);}',
				'.dsh-kb-menuWrap{position:relative;display:inline-flex;flex:none;}',
				'.dsh-kb-menuBtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;line-height:1;cursor:pointer;}',
				'.dsh-kb-menuBtn:hover,.dsh-kb-menuBtn--on{border-color:var(--dsw-alias-label-brand,#1f6feb);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-cardMenu{position:absolute;right:0;bottom:calc(100% + 6px);z-index:30;min-width:132px;display:flex;flex-direction:column;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1));box-shadow:0 10px 28px rgba(0,0,0,.28);}',
				'.dsh-kb-cardMenuItem{display:flex;align-items:center;padding:7px 10px;border:none;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12.5px;line-height:1.2;text-align:left;cursor:pointer;white-space:nowrap;}',
				'.dsh-kb-cardMenuItem:hover{background:var(--dsw-alias-bg-layer-2);}',
				'.dsh-kb-cardMenuItem--danger{color:#cf222e;}',
				'.dsh-kb-cardMenuItem--danger:hover{background:rgba(207,34,46,.12);}',
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
			plugin.__test = { patch, state, askText, askConfirm, renderText: renderMarkdown, renderMarkdown, isImage, sheetNodes };
		}
		return plugin;
	},
});