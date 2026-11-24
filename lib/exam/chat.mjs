// ============================================================================
// 对练用的模型调用：把 ctx.llm 的流式接口收成一个"喂 messages、拿一段文本"的函数。
//
// engine 只认这个形状，所以测试里可以换成假模型，面板侧完全不用改。
// ============================================================================

/**
 * 把某个服务商返回的模型列表整理成 { provider, model, efforts }。
 * DSH 的契约是 `listModels(providerId)`：参数必填、异步、每一项的 id 在 `.id`。
 */
function normalizeModels(providerId, raw) {
	const list = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : [];
	return list.map((item) => ({
		provider: providerId,
		model: String(item?.id ?? item?.model ?? item?.name ?? ''),
		efforts: item?.reasoning?.efforts?.map((effort) => effort.id) ?? [],
	})).filter((item) => item.provider && item.model);
}

/**
 * @param {object} options
 * @param {object} options.llm         ctx.get('llm')
 * @param {object} [options.logger]
 * @param {number} [options.timeoutMs] 单次调用超时，默认 45s
 */
export function createExamChat({ llm, getLlm, logger = console, timeoutMs = 45_000 }) {
	const resolve = () => {
		if (typeof getLlm === "function") {
			try { return getLlm(); } catch { return null; }
		}
		return llm ?? null;
	};

	/** 逐个服务商问模型：任何一个失败都跳过，不影响别的服务商。 */
	async function listModels() {
		const service = resolve();
		if (!service) return [];
		let providers = [];
		try {
			providers = Array.isArray(service.listProviders?.()) ? service.listProviders() : [];
		} catch (error) {
			logger.warn?.(`[knowledge-base] 取服务商列表失败：${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
		const out = [];
		for (const provider of providers) {
			const id = provider?.id ?? provider?.providerId ?? provider?.route ?? '';
			if (!id) continue;
			try {
				out.push(...normalizeModels(id, await service.listModels(id)));
			} catch (error) {
				logger.warn?.(`[knowledge-base] 服务商 ${id} 取不到模型：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return out;
	}

	/** 没指定模型时挑第一个可用的，保证"直接就能练"。 */
	async function pickDefault() {
		const models = await listModels();
		return models[0] ?? null;
	}

	/** 面板自检用：告诉用户"能不能练、用的是哪个模型、为什么不能"。 */
	async function diag() {
		const service = resolve();
		if (!service) {
			return { ready: false, reason: 'no_service', message: '插件没拿到模型服务（llm 未注入）', models: [], providers: [] };
		}
		if (typeof service.stream !== 'function') {
			return { ready: false, reason: 'no_stream', message: '模型服务没有 stream 接口', models: [], providers: [] };
		}
		let providers = [];
		try {
			providers = Array.isArray(service.listProviders?.()) ? service.listProviders() : [];
		} catch { /* 有的版本不提供，忽略 */ }
		const models = await listModels();
		if (!models.length) {
			return {
				ready: false,
				reason: 'no_models',
				message: providers.length
					? `有 ${providers.length} 个服务商，但取不到模型列表（可能没配 Key，或模型目录为空）`
					: '没有可用的服务商（先去设置里配一个模型，或在会话里选一个）',
				models,
				providers,
			};
		}
		return { ready: true, picked: models[0], models: models.slice(0, 20), providers };
	}

	/**
	 * @param {{messages: object[], provider?: string, model?: string, effort?: string, maxTokens?: number}} request
	 * @returns {Promise<string>}
	 */
	async function chat({ messages, provider, model, effort, maxTokens = 700 }) {
		const service = resolve();
		if (!service?.stream) throw Object.assign(new Error('当前环境没有可用的模型服务'), { code: 'no_model' });
		const picked = (!provider || !model) ? await pickDefault() : null;
		const useProvider = provider || picked?.provider;
		const useModel = model || picked?.model;
		if (!useProvider || !useModel) throw Object.assign(new Error('没有可用的模型，请先在设置里配置'), { code: 'no_model' });

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		let text = '';
		try {
			const stream = service.stream({
				provider: useProvider,
				model: useModel,
				...(effort ? { reasoningEffort: effort } : {}),
				maxTokens,
				messages,
				signal: controller.signal,
			});
			for await (const chunk of stream) {
				if (chunk?.type === 'text-delta' && chunk.text) text += chunk.text;
				else if (chunk?.type === 'finish' && !text && chunk.text) text = chunk.text;
			}
		} catch (error) {
			const reason = error?.name === 'AbortError' ? '模型调用超时' : (error instanceof Error ? error.message : String(error));
			throw Object.assign(new Error(reason), { code: 'model_failed' });
		} finally {
			clearTimeout(timer);
		}
		return text.trim();
	}

	return { chat, listModels, pickDefault, diag };
}
