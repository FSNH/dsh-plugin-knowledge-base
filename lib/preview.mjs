// ============================================================================
// 原版式预览：用宿主 officeKit（LibreOffice）把 Office 文档转成 PDF。
//
// · 转换结果落在库目录 files/<docId>.preview.pdf，源文件更新（mtime 变新）才重转
// · 同一文档的并发请求共用一次转换
// · officeKit 不存在时抛 code='unavailable'，界面降级到"文字阅读"
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

export const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']);
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

function unavailable(message) {
	const error = new Error(message);
	error.code = 'unavailable';
	return error;
}

export function createPreviewer({ store, getOfficeKit, logger }) {
	const jobs = new Map();

	function pathOf(node) {
		return path.join(store.filesDir, `${node.id}.preview.pdf`);
	}

	function available() {
		try {
			return typeof getOfficeKit?.()?.convert === 'function';
		} catch {
			return false;
		}
	}

	/** 已生成且比源文件新，就不用再转。 */
	function cached(node, sourcePath) {
		const out = pathOf(node);
		try {
			return fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(sourcePath).mtimeMs ? out : '';
		} catch {
			return '';
		}
	}

	async function ensure(node, { priority = 'foreground' } = {}) {
		if (!OFFICE_EXTENSIONS.has(node.ext)) {
			const error = new Error('这个格式不需要 Office 转换');
			error.code = 'unsupported';
			throw error;
		}
		const kit = getOfficeKit?.();
		if (!kit || typeof kit.convert !== 'function') {
			throw unavailable('这台机器没有可用的 Office 转换服务（officeKit），没法生成原版式预览');
		}
		const sourcePath = store.raw.q(`SELECT file_path AS filePath FROM nodes WHERE id = ?`).get(node.id)?.filePath;
		if (!sourcePath || !fs.existsSync(sourcePath)) {
			const error = new Error('原始文件不见了，无法生成预览');
			error.code = 'gone';
			throw error;
		}
		const hit = cached(node, sourcePath);
		if (hit) return hit;

		const running = jobs.get(node.id);
		if (running) return running;

		const job = (async () => {
			const stat = fs.statSync(sourcePath);
			const version = `${stat.size}-${Math.round(stat.mtimeMs)}`;
			const result = await kit.convert({
				extension: node.ext,
				priority,
				source: {
					key: `${node.id}:${version}`,
					version,
					bytes: stat.size,
					read: async () => ({ bytes: new Uint8Array(await fs.promises.readFile(sourcePath)), version }),
				},
			});
			const pdf = result?.pdf ?? result;
			if (!pdf || typeof pdf.length !== 'number' || !pdf.length) {
				throw new Error('转换没有返回 PDF 内容');
			}
			const out = pathOf(node);
			await fs.promises.writeFile(out, Buffer.from(pdf));
			logger?.info?.(`[knowledge-base] preview generated for ${node.name} (${Math.round(pdf.length / 1024)} KB)`);
			return out;
		})().finally(() => jobs.delete(node.id));

		jobs.set(node.id, job);
		return job;
	}

	function invalidate(node) {
		try { fs.rmSync(pathOf(node), { force: true }); } catch { /* ignore */ }
		for (const suffix of ['.pages', '.thumbs']) {
			try { fs.rmSync(path.join(store.filesDir, `${node.id}${suffix}`), { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}

	// ── 逐页图片：自己画阅读器，避免把浏览器 PDF 阅读器（带缩略图栏）塞进页面 ──
	// 两套尺寸：正文 96 DPI（清晰），左侧缩略图 24 DPI（小、能一次铺满列表）
	const PAGE_DPI = 96;
	const THUMB_DPI = 24;
	const MAX_PAGES = 200;

	const setDirOf = (node, suffix) => path.join(store.filesDir, `${node.id}${suffix}`);
	const PAGE_SET = { dpi: PAGE_DPI, suffix: '.pages', maxPages: MAX_PAGES };
	const THUMB_SET = { dpi: THUMB_DPI, suffix: '.thumbs', maxPages: MAX_PAGES };

	function readManifest(node, spec, pdfMtime) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(setDirOf(node, spec.suffix), 'manifest.json'), 'utf8'));
			if (raw && raw.dpi === spec.dpi && raw.pdfMtime === pdfMtime && Number.isInteger(raw.pages) && raw.pages > 0) return raw;
			return null;
		} catch {
			return null;
		}
	}

	const setJobs = new Map();

	async function renderPageSet(node, spec) {
		const pdfPath = await ensure(node); // 先保证有 PDF
		const pdfMtime = Math.round(fs.statSync(pdfPath).mtimeMs);
		const cachedManifest = readManifest(node, spec, pdfMtime);
		if (cachedManifest) return cachedManifest;

		const jobKey = `${node.id}:${spec.suffix}`;
		const running = setJobs.get(jobKey);
		if (running) return running;

		const kit = getOfficeKit?.();
		if (!kit || typeof kit.renderImages !== 'function') {
			throw unavailable('这台机器没有可用的 Office 渲染服务，没法生成逐页预览');
		}

		const job = (async () => {
			const stat = fs.statSync(pdfPath);
			const version = `${stat.size}-${Math.round(stat.mtimeMs)}`;
			const request = (extra = {}) => kit.renderImages({
				extension: 'pdf',
				dpi: spec.dpi,
				maxImages: spec.maxPages,
				// officeKit 的上限：每张图 ≤ 16777216 像素、边长 ≤ 4096
				maxPixels: 16_000_000,
				maxDimension: 4096,
				maxBytes: 240 * 1024 * 1024,
				source: {
					key: `${node.id}:pdf:${version}`,
					version,
					bytes: stat.size,
					read: async () => ({ bytes: new Uint8Array(await fs.promises.readFile(pdfPath)), version }),
				},
				...extra,
			});

			let result;
			let truncated = false;
			try {
				result = await request();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// 页数超过上限：退化成只渲染前 maxPages 页
				if (/maxPages/i.test(message)) {
					result = await request({ pages: Array.from({ length: spec.maxPages }, (_, index) => index + 1) });
					truncated = true;
				} else {
					throw error;
				}
			}
			const images = result?.images ?? [];
			if (!images.length) throw new Error('渲染没有返回任何页面');
			const dir = setDirOf(node, spec.suffix);
			fs.rmSync(dir, { recursive: true, force: true });
			fs.mkdirSync(dir, { recursive: true });
			images.forEach((image, index) => {
				const page = Number(image.page) || index + 1;
				fs.writeFileSync(path.join(dir, `p${page}.png`), Buffer.from(image.png));
			});
			const manifest = {
				dpi: spec.dpi,
				pages: images.length,
				pageCount: Number(result.pageCount) || images.length,
				truncated,
				pdfMtime,
				width: images[0]?.width ?? 0,
				height: images[0]?.height ?? 0,
				generatedAt: Date.now(),
			};
			fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
			logger?.info?.(`[knowledge-base] rendered ${images.length} ${spec.suffix} pages for ${node.name}`
				+ `${truncated ? ` (truncated from ${manifest.pageCount})` : ''}`);
			return manifest;
		})().finally(() => setJobs.delete(jobKey));

		setJobs.set(jobKey, job);
		return job;
	}

	const ensurePages = (node) => renderPageSet(node, PAGE_SET);
	const ensureThumbs = (node) => renderPageSet(node, THUMB_SET);
	const pageFile = (node, page) => path.join(setDirOf(node, '.pages'), `p${Number(page)}.png`);
	const thumbFile = (node, page) => path.join(setDirOf(node, '.thumbs'), `p${Number(page)}.png`);

	return {
		ensure,
		ensurePages,
		ensureThumbs,
		pageFile,
		thumbFile,
		available,
		invalidate,
		pathOf,
		supports: (ext) => OFFICE_EXTENSIONS.has(ext),
	};
}
