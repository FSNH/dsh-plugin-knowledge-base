// ============================================================================
// 模型工具：kb_list / kb_search / kb_read（全部只读）
//
// 只依赖 ctx.tools.register 约定，不 import 任何 @deepseek-ai 包：
//   { name, description, parameters, output: { schema, render }, execute, presentCall }
// parameters 只能使用 DSH 支持的 JSON Schema 子集。
// ============================================================================

const MAX_READ_CHARS = 6000;
const MAX_SEARCH_LIMIT = 20;

const HIT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['docId', 'name', 'locator', 'snippet', 'charStart'],
	properties: {
		docId: { type: 'string', description: '文档 id，可直接传给 kb_read' },
		name: { type: 'string', description: '文件名' },
		locator: { type: 'string', description: '给人看的定位：知识库 → 目录 → 文件' },
		heading: { type: 'string', description: '所在章节（可能为空）' },
		snippet: { type: 'string', description: '命中片段' },
		charStart: { type: 'number', description: '片段在正文里的起始字符偏移，传给 kb_read 的 offset' },
		page: { type: 'number', description: '页码（PDF/PPT），没有则为 0' },
	},
};

function formatBytes(bytes) {
	const value = Number(bytes) || 0;
	if (value < 1024) return `${value} B`;
	if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / 1048576).toFixed(1)} MB`;
}

export function createKnowledgeBaseTools({ store, index, pipeline, exam }) {
	// ── kb_list ────────────────────────────────────────────────────────────
	const listTool = {
		name: 'kb_list',
		description:
			'列出用户的「个人知识库」：有哪些库、每个库里的目录结构。'
			+ '用户提到"知识库""我的资料""我之前存的那份文档"时，先调用它确认有什么，再用 kb_search 检索。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				kbId: { type: 'string', description: '只列这个知识库；省略则列出全部库的概览' },
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['summary', 'libraries'],
				properties: {
					summary: { type: 'string', description: '一句话概览' },
					libraries: {
						type: 'array',
						description: '知识库清单',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['id', 'name', 'docs'],
							properties: {
								id: { type: 'string', description: '知识库 id，可传给 kb_search 的 kbIds' },
								name: { type: 'string', description: '知识库名称' },
								docs: { type: 'number', description: '文档数' },
								tree: { type: 'string', description: '缩进的目录树文本（只在该库被指定时返回）' },
							},
						},
					},
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.summary + (value.libraries.length ? `\n${value.libraries.map((item) => item.tree || `- ${item.name}（${item.docs} 篇）`).join('\n')}` : '') }],
		},
		async execute(args) {
			const only = typeof args.kbId === 'string' ? args.kbId.trim() : '';
			const libraries = store.listKbs().filter((kb) => !only || kb.id === only);
			if (!libraries.length) {
				return { summary: '还没有任何知识库（用户可以在左下角「知识库」页面新建）。', libraries: [] };
			}
			const out = libraries.map((kb) => {
				const base = { id: kb.id, name: kb.name, docs: kb.docs, tree: '' };
				if (!only) return base;
				const nodes = store.listNodes(kb.id);
				const byParent = new Map();
				for (const node of nodes) {
					const key = node.parentId ?? '';
					if (!byParent.has(key)) byParent.set(key, []);
					byParent.get(key).push(node);
				}
				const lines = [`- ${kb.name}（${kb.docs} 篇）`];
				const walk = (parentKey, depth) => {
					if (depth > 6) return;
					for (const node of byParent.get(parentKey) ?? []) {
						const mark = node.kind === 'folder' ? '📁' : '📄';
						const size = node.kind === 'doc' ? ` ${formatBytes(node.bytes)}` : '';
						const bad = node.status === 'failed' ? '（解析失败）' : '';
						lines.push(`${'  '.repeat(depth)}${mark} ${node.name}${size}${bad}`);
						if (node.kind === 'folder') walk(node.id, depth + 1);
					}
				};
				walk('', 1);
				return { ...base, tree: lines.join('\n') };
			});
			const total = out.reduce((sum, item) => sum + item.docs, 0);
			return { summary: `共 ${out.length} 个知识库、${total} 篇文档。`, libraries: out };
		},
	};

	// ── kb_search ──────────────────────────────────────────────────────────
	const searchTool = {
		name: 'kb_search',
		description:
			'在用户的个人知识库里做全文检索（中文、英文、编号都行），返回命中片段与定位。'
			+ '回答本地资料相关的问题前先用它；命中后可用 kb_read 读片段周围的正文。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['query'],
			properties: {
				query: { type: 'string', description: '检索词，可以是关键词、短语或一句话' },
				kbIds: {
					type: 'array',
					description: '只在这些知识库里搜（可选）',
					items: { type: 'string' },
				},
				limit: { type: 'number', description: `最多返回几条（默认 8，上限 ${MAX_SEARCH_LIMIT}）` },
				mode: { type: 'string', enum: ['keyword', 'hybrid'], description: 'keyword=关键词；hybrid=关键词+向量（需要用户配置了向量服务）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['summary', 'hits'],
				properties: {
					summary: { type: 'string', description: '一句话结论：命中几条、用了什么模式' },
					hits: { type: 'array', description: '命中片段', items: HIT_SCHEMA },
				},
			},
			render: (_args, value) => {
				const lines = [value.summary];
				value.hits.forEach((hit, index) => {
					lines.push(`${index + 1}. ${hit.locator}${hit.heading ? ` · ${hit.heading}` : ''}${hit.page ? `（第 ${hit.page} 页）` : ''}`);
					lines.push(`   ${hit.snippet}`);
					lines.push(`   docId=${hit.docId} offset=${hit.charStart}`);
				});
				return [{ type: 'text', text: lines.join('\n') }];
			},
		},
		async execute(args) {
			const query = String(args.query ?? '').trim();
			const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Number(args.limit) || 8));
			const kbIds = Array.isArray(args.kbIds) ? args.kbIds.filter((item) => typeof item === 'string') : [];
			if (!query) return { summary: '检索词为空。', hits: [] };
			const result = await index.search({
				query,
				kbIds,
				limit,
				mode: args.mode === 'hybrid' ? 'hybrid' : 'keyword',
			});
			if (!result.hits.length) {
				return {
					summary: `在知识库里没有找到与「${query}」相关的内容（模式：${result.mode}）。可以先 kb_list 看看有哪些库和文档。`,
					hits: [],
				};
			}
			return {
				summary: `在知识库里命中 ${result.hits.length} 段与「${query}」相关的内容（模式：${result.mode}）。`,
				hits: result.hits.map((hit) => ({
					docId: hit.nodeId,
					name: hit.name,
					locator: hit.locator,
					heading: hit.heading || '',
					snippet: hit.snippet,
					charStart: hit.charStart,
					page: hit.page ?? 0,
				})),
			};
		},
	};

	// ── kb_read ────────────────────────────────────────────────────────────
	const readTool = {
		name: 'kb_read',
		description:
			'读取知识库里某篇文档的正文（按字符偏移分页，单次最多 6000 字）。'
			+ '先用 kb_search 拿到 docId 和 charStart，再用 offset 读命中位置附近的内容。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['docId'],
			properties: {
				docId: { type: 'string', description: 'kb_search / kb_list 返回的文档 id' },
				offset: { type: 'number', description: '起始字符偏移，默认 0' },
				limit: { type: 'number', description: `本次最多读多少字（默认 ${MAX_READ_CHARS}，上限 ${MAX_READ_CHARS}）` },
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['ok', 'summary', 'text'],
				properties: {
					ok: { type: 'boolean', description: '是否读取成功' },
					summary: { type: 'string', description: '一句话说明：哪个文件的哪一段' },
					text: { type: 'string', description: '正文片段' },
					next: { type: 'number', description: '下一页的 offset；为 0 表示已读完' },
					totalChars: { type: 'number', description: '全文总字数' },
				},
			},
			render: (_args, value) => [{ type: 'text', text: `${value.summary}\n\n${value.text}${value.next ? `\n\n（未完，next offset=${value.next}）` : ''}` }],
		},
		async execute(args) {
			const docId = String(args.docId ?? '').trim();
			const node = docId ? store.getNode(docId) : null;
			if (!node || node.kind !== 'doc') {
				return { ok: false, summary: `找不到文档 ${docId || '(空)'}；先用 kb_search 检索。`, text: '', next: 0, totalChars: 0 };
			}
			if (node.status === 'failed') {
				return { ok: false, summary: `《${node.name}》解析失败：${node.error || '未知原因'}`, text: '', next: 0, totalChars: 0 };
			}
			if (node.status !== 'ready') {
				return { ok: false, summary: `《${node.name}》还在解析中，稍后再试。`, text: '', next: 0, totalChars: 0 };
			}
			const full = store.getText(node.id);
			if (!full) {
				return { ok: false, summary: `《${node.name}》没有可读的正文。`, text: '', next: 0, totalChars: 0 };
			}
			const offset = Math.max(0, Math.min(full.length, Math.trunc(Number(args.offset) || 0)));
			const limit = Math.min(MAX_READ_CHARS, Math.max(200, Number(args.limit) || MAX_READ_CHARS));
			const end = Math.min(full.length, offset + limit);
			const text = full.slice(offset, end);
			const next = end < full.length ? end : 0;
			const crumb = store.breadcrumb(node.id);
			return {
				ok: true,
				summary: `《${node.name}》（${crumb}）第 ${offset}-${end} 字，共 ${full.length} 字。`,
				text,
				next,
				totalChars: full.length,
			};
		},
	};

	// ── kb_topic_save ──────────────────────────────────────────────────────
	// 让 agent 把"和用户谈定的学习目标 + 大纲"写回知识库（面板上的卡片就是它）。
	const topicSaveTool = {
		name: 'kb_topic_save',
		description:
			'把学习主题保存到知识库：学习目标 + 大纲（若干知识点）。'
			+ '只有在和用户确认过目标与知识点之后才调用；保存成功后告诉用户"已保存，回知识库的「对练」页就能看到"。',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['kbId', 'objective', 'outline'],
			properties: {
				kbId: { type: 'string', description: '知识库 id（kb_list 返回）' },
				docIds: { type: 'array', items: { type: 'string' }, description: '只考这些文档；省略或空数组 = 整库' },
				objective: { type: 'string', description: '学习目标，一句话，覆盖多个知识点（不是单个事实）' },
				totalTurns: { type: 'number', description: '总题数，默认 10；用户指定了就用他说的' },
				outline: {
					type: 'array',
					description: '大纲，按考察顺序排列，3~6 个知识点',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['title'],
						properties: {
							title: { type: 'string', description: '知识点标题' },
							turns: { type: 'number', description: '这个知识点考几题，1~4' },
							difficulty: { type: 'string', enum: ['recall', 'discern', 'apply'], description: '难度' },
						},
					},
				},
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['ok', 'summary', 'topicId'],
				properties: {
					ok: { type: 'boolean' },
					summary: { type: 'string' },
					topicId: { type: 'string' },
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.summary }],
		},
		async execute(args) {
			if (!exam?.saveTopic) return { ok: false, summary: '这个版本没有对练功能', topicId: '' };
			try {
				const outline = (Array.isArray(args.outline) ? args.outline : [])
					.map((item, index) => ({
						id: `kp${index + 1}`,
						title: String(item?.title ?? '').trim(),
						docIds: [],
					}))
					.filter((item) => item.title);
				const blueprint = (Array.isArray(args.outline) ? args.outline : []).map((item, index) => ({
					kpId: `kp${index + 1}`,
					turns: Math.min(Math.max(Number(item?.turns) || 2, 1), 4),
					difficulty: ['recall', 'discern', 'apply'].includes(item?.difficulty) ? item.difficulty : 'discern',
				}));
				const topic = exam.saveTopic({
					kbId: String(args.kbId ?? ''),
					docIds: Array.isArray(args.docIds) ? args.docIds.map(String) : [],
					objective: String(args.objective ?? ''),
					outline,
					totalTurns: Number(args.totalTurns) || 10,
					blueprint,
				});
				return {
					ok: true,
					summary: `已保存学习主题（${outline.length} 个知识点）：${topic.objective}`,
					topicId: topic.id,
				};
			} catch (error) {
				return { ok: false, summary: `保存失败：${error?.message ?? error}`, topicId: '' };
			}
		},
	};

	// ── kb_topic_list ──────────────────────────────────────────────────────
	const topicListTool = {
		name: 'kb_topic_list',
		description: '列出已经保存的学习主题（目标 + 知识点数），用来避免重复建同一个主题。',
		parameters: { type: 'object', additionalProperties: false, properties: {} },
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['summary', 'topics'],
				properties: {
					summary: { type: 'string' },
					topics: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							required: ['id', 'objective', 'kbName', 'kps'],
							properties: {
								id: { type: 'string' },
								objective: { type: 'string' },
								kbName: { type: 'string' },
								kps: { type: 'number' },
							},
						},
					},
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.summary }],
		},
		async execute() {
			const topics = exam?.listTopics ? exam.listTopics(50) : [];
			return {
				summary: topics.length ? `已保存 ${topics.length} 个学习主题` : '还没有保存过学习主题',
				topics: topics.map((topic) => ({
					id: topic.id,
					objective: topic.objective,
					kbName: topic.kbName ?? '',
					kps: topic.outline.length,
				})),
			};
		},
	};

	return [listTool, searchTool, readTool, topicSaveTool, topicListTool];
}
