// ============================================================================
// 插件自己的设置文件：$DSH_HOME/kb/settings.json（0600）
//
// 放两类会反复试的配置：向量检索（embeddings）和图片理解（视觉模型）。
// 理由：改 YAML 要重载插件才生效，而这两样用户会来回换服务、换模型、填错 key。
// 放这里可以即改即用，且 KEY 不落到 patch 里。
// 优先级：settings.json > 插件 config。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

/**
 * 出厂的默认端点（只有地址和模型名，**没有任何密钥**）。
 * 用户装上后在设置里只需要填 API Key + 勾选启用。
 */
export const DEFAULT_EMBEDDING = {
	baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
	model: 'text-embedding-v4',
};

export const DEFAULT_VISION = {
	baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
	model: 'qwen3-vl-plus',
};

function clean(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function normalizeEndpoint(input) {
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
		return normalizeEndpoint(readAll().embedding);
	}

	/** 读当前图片理解配置。 */
	function vision() {
		return normalizeEndpoint(readAll().vision);
	}

	/** 某个配置块有没有被界面保存过（没保存就回落到插件 YAML）。 */
	function hasSaved(section = 'embedding') {
		const raw = readAll()[section];
		return Boolean(raw && typeof raw === 'object');
	}

	function saveSection(section, patch) {
		const current = normalizeEndpoint(readAll()[section]);
		const next = { ...current };
		if (patch && typeof patch === 'object') {
			if ('enabled' in patch) next.enabled = Boolean(patch.enabled);
			if ('baseUrl' in patch) next.baseUrl = clean(patch.baseUrl).replace(/\/+$/, '');
			if ('model' in patch) next.model = clean(patch.model);
			if (patch.clearKey === true) next.apiKey = '';
			else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
		}
		const all = readAll();
		all[section] = next;
		const ok = writeAll(all);
		return { ok, [section]: next };
	}

	/**
	 * 保存向量配置。
	 * @param {object} patch - { enabled?, baseUrl?, model?, apiKey?, clearKey? }
	 */
	function saveEmbedding(patch) {
		const result = saveSection('embedding', patch);
		return { ok: result.ok, embedding: result.embedding };
	}

	/** 保存图片理解配置。 */
	function saveVision(patch) {
		const result = saveSection('vision', patch);
		return { ok: result.ok, vision: result.vision };
	}

	/** 给界面看的版本：key 只留尾号。 */
	function publicSection(section, fallback, defaults, keyFallback = '') {
		const saved = readAll()[section];
		const effective = saved && typeof saved === 'object' ? normalizeEndpoint(saved) : normalizeEndpoint(fallback);
		const key = effective.apiKey || keyFallback || process.env[`DSH_KB_${section.toUpperCase()}_KEY`] || '';
		return {
			enabled: effective.enabled,
			// 没填过地址/模型就回落到出厂默认，用户只需要补 Key
			baseUrl: effective.baseUrl || defaults.baseUrl,
			model: effective.model || defaults.model,
			defaultBaseUrl: defaults.baseUrl,
			defaultModel: defaults.model,
			hasKey: Boolean(key),
			keyTail: key ? key.slice(-4) : '',
			fromFile: Boolean(saved && typeof saved === 'object'),
		};
	}

	function publicEmbedding(fallback = {}) {
		return publicSection('embedding', fallback, DEFAULT_EMBEDDING);
	}

	/** 图片理解常和向量检索用同一个服务商，没单独填 key 时可以复用嵌入的 key。 */
	function publicVision(fallback = {}) {
		const embeddingKey = embedding().apiKey || process.env.DSH_KB_EMBEDDING_KEY || '';
		return publicSection('vision', fallback, DEFAULT_VISION, embeddingKey);
	}

	return {
		file,
		embedding,
		vision,
		hasSaved,
		saveEmbedding,
		saveVision,
		publicEmbedding,
		publicVision,
	};
}
