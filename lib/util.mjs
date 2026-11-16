// ============================================================================
// 通用小工具：id、HTTP 收发、请求体读取、跨站防护。
// 只用 Node 内置模块，不引第三方依赖。
// ============================================================================
import { createHash, randomUUID } from 'node:crypto';

export const API_BASE = '/api/kb/v1';

/** 短 id：前缀 + 10 位十六进制，便于在日志和 URL 里辨认。 */
export function newId(prefix) {
	return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

export function nowMs() {
	return Date.now();
}

/** 展示用时间（ISO 会被前端格式化，这里只存毫秒）。 */
export function sha256Hex(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

export function sendJson(res, status, body) {
	const payload = JSON.stringify(body ?? null);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload),
	});
	res.end(payload);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
	const payload = Buffer.isBuffer(text) ? text : Buffer.from(String(text ?? ''), 'utf8');
	res.writeHead(status, {
		'content-type': type,
		'cache-control': 'no-store',
		'content-length': payload.length,
	});
	res.end(payload);
}

export function sendBytes(res, status, buffer, type, extraHeaders = {}) {
	const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	res.writeHead(status, {
		'content-type': type || 'application/octet-stream',
		'cache-control': 'no-store',
		'content-length': payload.length,
		...extraHeaders,
	});
	res.end(payload);
}

/** 读 JSON/文本请求体，带硬上限，避免恶意大包。 */
export function readBody(req, limit = 1 << 20) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let overflow = false;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				overflow = true;
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (overflow) return resolve({ ok: false, code: 'too-large' });
			const buffer = Buffer.concat(chunks);
			try {
				const value = JSON.parse(buffer.toString('utf8') || '{}');
				resolve({ ok: true, value: value && typeof value === 'object' ? value : {} });
			} catch {
				resolve({ ok: false, code: 'bad-json' });
			}
		});
		req.on('error', () => resolve({ ok: false, code: 'aborted' }));
	});
}

/**
 * 跨站防护。
 *
 * webServer 的路由没有全局鉴权，用户浏览器里的任意网页都能向 127.0.0.1:<port>
 * 发“简单请求”。这里要求一个自定义头（会触发预检，而我们不应答 CORS，浏览器
 * 就会拦下跨站请求），并在带 Origin 时校验同源。
 */
export function guard(origin, req) {
	if (req.headers['x-kb-client'] !== '1') return { ok: false, code: 'forbidden' };
	const from = req.headers.origin;
	if (typeof from === 'string' && from && origin && from !== origin) {
		return { ok: false, code: 'forbidden' };
	}
	return { ok: true };
}

/** 从请求头取文件名（客户端用 encodeURIComponent 编码）。 */
export function filenameFromHeader(req) {
	const raw = req.headers['x-kb-filename'];
	if (typeof raw !== 'string' || !raw) return '';
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** 只保留安全字符，用于展示；落盘永远不用它。 */
export function sanitizeName(name, fallback = '未命名') {
	const cleaned = String(name ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.replace(/[\\/:*?"<>|]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);
	return cleaned || fallback;
}

export function extOf(name) {
	const match = /\.([A-Za-z0-9]{1,12})$/.exec(String(name ?? ''));
	return match ? match[1].toLowerCase() : '';
}

export function clampInt(value, min, max, fallback) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(number)));
}
