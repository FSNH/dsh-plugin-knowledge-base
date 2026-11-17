// ============================================================================
// 图片理解：把图片交给视觉模型，产出「结构化描述」当正文。
//
// 为什么这么做（而不是图片向量）：描述文字能直接进现有的 FTS + 向量链路，
// 检索命中后 AI 还能通过 kb_read 读到图里写了什么，出处可解释。
// 失败时就当作没有正文，不影响图片本身的查看。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

export const VISION_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

const MIME_BY_EXT = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
};

const PROMPT = [
	'请把这张图片转成便于全文检索的文字，用中文，按下面的小标题输出，没有的部分写「无」：',
	'【画面】一句话说清这是什么（照片 / 截图 / 表格 / 示意图 / 扫描件 …），主体是什么。',
	'【文字】逐字抄出图中所有可读的文字、标题、按钮、标注；保持原有顺序。',
	'【数据】如果图里有表格、清单、数值、日期、编号，按行整理出来。',
	'【场景】这张图大概用在什么场景（培训材料 / 会议 / 资质文件 / 现场照片 …）。',
	'不要编造看不到的内容；看不清的字写「（字迹不清）」。',
].join('\n');

// 64×64 的浅灰格纹 PNG，用于「测试连接」。
// 不能用 1×1：百炼的视觉模型要求宽高都大于 10，太小会直接 400。
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgElEQVR4nO3RoQ3AAAzAsP7/anH5jhiwpoUEW8rc3e5+t8MFLztc0AEt6IAWdEALOqAFHdCCDmhBB7SgA1rQAS3ogBZ0QAs6oAUd0IIOaEEHtKADWtABLeiAFnRACzqgBR3Qgg5oQQe0oANa0AEt6IAWdEALOqAFHdCCDmjB3w880FECpN+biKgAAAAASUVORK5CYII=';

const TIMEOUT_MS = 90_000;

function textOf(content) {
	if (typeof content === 'string') return content.trim();
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
			.join('\n')
			.trim();
	}
	return '';
}

/**
 * OpenAI 兼容的视觉客户端（chat/completions + image_url）。
 * 配置每次调用都重新读，界面上改完即时生效。
 */
export function createVisionClient({ resolve, logger }) {
	function effective() {
		const raw = (typeof resolve === 'function' ? resolve() : {}) || {};
		const enabled = Boolean(raw.enabled);
		const baseUrl = String(raw.baseUrl ?? '').replace(/\/+$/, '');
		const model = String(raw.model ?? '');
		const key = String(raw.apiKey || process.env.DSH_KB_VISION_KEY || '');
		return { enabled, baseUrl, model, key, usable: enabled && Boolean(baseUrl) && Boolean(model) };
	}

	async function call(dataUrl) {
		const now = effective();
		if (!now.usable) throw new Error('图片理解未启用或缺少接口地址/模型');
		const response = await fetch(`${now.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(now.key ? { authorization: `Bearer ${now.key}` } : {}),
			},
			body: JSON.stringify({
				model: now.model,
				messages: [{
					role: 'user',
					content: [
						{ type: 'text', text: PROMPT },
						{ type: 'image_url', image_url: { url: dataUrl } },
					],
				}],
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`);
		}
		const data = await response.json();
		const text = textOf(data?.choices?.[0]?.message?.content);
		if (!text) throw new Error('模型没有返回文字内容');
		return text;
	}

	return {
		get enabled() {
			return effective().usable;
		},
		describe() {
			const now = effective();
			return {
				configured: now.enabled,
				enabled: now.usable,
				model: now.model,
				baseUrl: now.baseUrl,
				hasKey: Boolean(now.key),
				missing: now.usable || !now.enabled ? [] : ['baseUrl', 'model'].filter((field) => !now[field]),
			};
		},
		/** 给「测试连接」用：拿一张 1×1 图请求一次，能返回文字就算通。 */
		async probe() {
			const now = effective();
			if (!now.usable) return { ok: false, error: '还没填完整（需要接口地址 + 模型，且已启用）' };
			const startedAt = Date.now();
			try {
				const text = await call(`data:image/png;base64,${PROBE_PNG}`);
				return { ok: true, model: now.model, ms: Date.now() - startedAt, sample: text.slice(0, 80) };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		/** 把一张图描述成文字；失败抛错，由流水线记成「图片理解失败」。 */
		async describeImage(buffer, ext) {
			const mime = MIME_BY_EXT[ext] ?? 'image/png';
			return call(`data:${mime};base64,${buffer.toString('base64')}`);
		},
	};
}

/** 从文件读图片并描述（流水线用）。 */
export async function describeImageFile(client, filePath, ext) {
	const buffer = await fs.promises.readFile(filePath);
	return client.describeImage(buffer, ext);
}

export function isVisionExtension(ext) {
	return VISION_EXTENSIONS.has(String(ext || '').toLowerCase());
}

export function visionFileName(filePath) {
	return path.basename(filePath);
}
