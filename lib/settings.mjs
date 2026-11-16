// ============================================================================
// 插件自己的设置文件：$DSH_HOME/kb/settings.json（0600）
//
// 目前只放向量检索的配置，理由：改 YAML 要重载插件才生效，而这个东西用户会反复
// 试（换服务、换模型、填错 key）。放这里可以即改即用，且 KEY 不落到 patch 里。
// 优先级：settings.json > 插件 config.embedding。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

/**
 * 出厂的默认 embeddings 端点（只有地址和模型名，**没有任何密钥**）。
 * 用户装上后在设置里只需要填 API Key + 勾选启用。
 */
export const DEFAULT_EMBEDDING = {
	baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
	model: 'text-embedding-v4',
};

function clean(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmbedding(input) {
	const raw = input && typeof input === 'object' ? input : {};
	return {
		enabled: Boolean(raw.enabled),
		baseUrl: clean(raw.baseUrl).replace(/\/+$/, ''),
		model: clean(raw.model),
		apiKey: clean(raw.apiKey),
	};
}

export function createSettingsStore({ root, logger }) {
	const file = path.join(root, 'settings.json');

	function readAll() {
		try {
			const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
			return raw && typeof raw === 'object' ? raw : {};
		} catch {
			return {};
		}
	}

	function writeAll(next) {
		try {
			fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			try { fs.chmodSync(file, 0o600); } catch { /* Windows 上可能不支持，忽略 */ }
			return true;
		} catch (error) {
			logger?.warn?.(`[knowledge-base] 写设置失败：${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	/** 读当前向量配置（未填过就是空值）。 */
	function embedding() {
		return normalizeEmbedding(readAll().embedding);
	}

	/** settings.json 里有没有存过 embedding（没存过就回落到插件 YAML 的配置）。 */
	function hasSaved() {
		const raw = readAll().embedding;
		return Boolean(raw && typeof raw === 'object');
	}

	/**
	 * 保存向量配置。
	 * @param {object} patch - { enabled?, baseUrl?, model?, apiKey?, clearKey? }
	 */
	function saveEmbedding(patch) {
		const current = embedding();
		const next = { ...current };
		if (patch && typeof patch === 'object') {
			if ('enabled' in patch) next.enabled = Boolean(patch.enabled);
			if ('baseUrl' in patch) next.baseUrl = clean(patch.baseUrl).replace(/\/+$/, '');
			if ('model' in patch) next.model = clean(patch.model);
			if (patch.clearKey === true) next.apiKey = '';
			else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
		}
		const all = readAll();
		all.embedding = next;
		const ok = writeAll(all);
		return { ok, embedding: next };
	}

	/** 给界面看的版本：key 只留尾号。 */
	function publicEmbedding(fallback = {}) {
		const saved = readAll().embedding;
		const effective = saved && typeof saved === 'object' ? normalizeEmbedding(saved) : normalizeEmbedding(fallback);
		const key = effective.apiKey || process.env.DSH_KB_EMBEDDING_KEY || '';
		return {
			enabled: effective.enabled,
			// 没填过地址/模型就回落到出厂默认，用户只需要补 Key
			baseUrl: effective.baseUrl || DEFAULT_EMBEDDING.baseUrl,
			model: effective.model || DEFAULT_EMBEDDING.model,
			defaultBaseUrl: DEFAULT_EMBEDDING.baseUrl,
			defaultModel: DEFAULT_EMBEDDING.model,
			hasKey: Boolean(key),
			keyTail: key ? key.slice(-4) : '',
			fromFile: Boolean(saved && typeof saved === 'object'),
		};
	}

	return { file, embedding, hasSaved, saveEmbedding, publicEmbedding };
}
