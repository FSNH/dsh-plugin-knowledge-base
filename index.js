// ============================================================================
// dsh-plugin-knowledge-base — Host 半部
//
// 职责：
//   1. 把库、树、文档存在本机（$DSH_HOME/kb，可配），解析正文并建全文索引
//   2. 给浏览器端一组同源 HTTP 接口（树 / 上传 / 阅读 / 检索 / 预填提问）
//   3. 给模型三个只读工具：kb_list / kb_search / kb_read
//   4. 库非空时注入一小段系统提示，告诉模型怎么用这些工具
//
// 不做的事：不新增 session 事件类型、不碰 profile 配置、不把文件放进工作区。
// ============================================================================
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { openStore } from './lib/store.mjs';
import { createEmbedder, createIndex } from './lib/index.mjs';
import { createPipeline } from './lib/pipeline.mjs';
import { createPreviewer } from './lib/preview.mjs';
import { createKnowledgeBaseTools } from './lib/tools.mjs';
import { createSettingsStore } from './lib/settings.mjs';
import { createRoutes } from './lib/routes.mjs';

export const name = 'dsh-knowledge-base';
export const inject = ['webServer'];

function resolveRoot(config) {
	const configured = typeof config?.root === 'string' ? config.root.trim() : '';
	if (configured) return path.resolve(configured);
	const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
	return path.join(home, 'kb');
}

export function apply(ctx, config = {}) {
	const webServer = ctx.get('webServer');
	if (!webServer?.register) {
		ctx.logger?.(name)?.warn?.('[knowledge-base] webServer 不可用，插件未启动');
		return;
	}
	const logger = ctx.logger?.(name) ?? console;
	const root = resolveRoot(config);

	let store;
	try {
		store = openStore({ root, logger });
	} catch (error) {
		logger.error?.(`[knowledge-base] 打不开存储 ${root}：${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	// 向量配置：界面改的写进 settings.json，优先级高于插件 YAML 里的 config.embedding
	const settings = createSettingsStore({ root, logger });
	const resolveEmbedding = () => {
		if (settings.hasSaved()) return settings.embedding();
		const base = config.embedding ?? {};
		return { enabled: Boolean(base.enabled), baseUrl: base.baseUrl ?? '', model: base.model ?? '', apiKey: base.apiKey ?? '' };
	};

	const embedder = createEmbedder({ resolve: resolveEmbedding, logger });
	const index = createIndex({ store, embedder });
	// Office 原版式预览要用宿主的 officeKit（LibreOffice 转换），它可能比本插件晚加载，
	// 所以用 getter 在调用时取。
	const previewer = createPreviewer({ store, getOfficeKit: () => ctx.get('officeKit'), logger });
	const pipeline = createPipeline({ store, index, embedder, logger, config, previewer });

	// ── HTTP 路由 ──────────────────────────────────────────────────────────
	// 二进制预览（<img>/<iframe>）带不了自定义头，给它一条带启动令牌的通道。
	const token = crypto.randomUUID();
	const { routes } = createRoutes({
		store, index, pipeline, embedder, settings, config, logger, webServer, token, previewer,
	});
	for (const route of routes) {
		ctx.effect(() => webServer.register(route), `knowledge-base: ${route.path}`);
	}

	// ── 模型工具 ───────────────────────────────────────────────────────────
	const tools = createKnowledgeBaseTools({ store, index, pipeline });
	if (typeof ctx.inject === 'function') {
		ctx.inject(['tools'], (toolCtx) => {
			for (const definition of tools) {
				toolCtx.effect(() => toolCtx.tools.register(definition), `knowledge-base: tool ${definition.name}`);
			}
			logger.info?.(`[knowledge-base] tools registered: ${tools.map((item) => item.name).join(', ')}`);
		});
	} else if (ctx.tools?.register) {
		for (const definition of tools) ctx.effect(() => ctx.tools.register(definition), `knowledge-base: tool ${definition.name}`);
	}

	// ── 系统提示（库非空时才说）─────────────────────────────────────────────
	ctx.inject(['systemPrompt'], (promptCtx) => {
		promptCtx.effect(() => promptCtx.systemPrompt.section({
			name: 'personal-knowledge-base',
			order: 60,
			interpolate: false,
			text: () => {
				try {
					const kbs = store.listKbs();
					if (!kbs.length) return '';
					const docs = kbs.reduce((sum, kb) => sum + kb.docs, 0);
					const names = kbs.slice(0, 6).map((kb) => kb.name).join('、');
					return [
						'## 个人知识库',
						'用户在这台机器上有一个本地知识库，可用工具：kb_list / kb_search / kb_read。',
						'当用户提到"知识库""我的资料""我之前存的那份文档"，或问题明显依赖本地资料时：',
						'先用 kb_list 看有哪些库，用 kb_search 检索（中文短词也能命中），必要时用 kb_read 读片段周围的正文。',
						'回答时给出处（知识库 → 目录 → 文件 → 章节/页码），文档里没有的内容不要编造。',
						`现状：${kbs.length} 个知识库（${names}${kbs.length > 6 ? ' 等' : ''}），共 ${docs} 篇文档。`,
					].join('\n');
				} catch {
					return '';
				}
			},
		}), 'knowledge-base: prompt section');
	});

	// 上次进程没跑完的解析任务接着跑
	const recovered = pipeline.recover();

	// ── 卸载清理 ───────────────────────────────────────────────────────────
	ctx.effect(() => () => {
		try {
			// 正在解析的文档回到 pending，下次启动会重新排队
			store.raw.q(`UPDATE nodes SET status = 'pending' WHERE status = 'parsing'`).run();
		} catch { /* ignore */ }
		store.close();
	}, 'knowledge-base: close store');

	logger.info?.(`[knowledge-base] ready · root=${root} · recovered=${recovered}`
		+ ` · embedding=${embedder.enabled ? 'on' : 'off'}`);
}

export default { name, inject, apply };
