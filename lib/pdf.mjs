// ============================================================================
// PDF 正文抽取：pdfjs-dist（legacy build，纯 JS，Node 里只做文字层，不渲染）
//
// 依赖是可选的：装不上 or 加载失败时抛一个能给人看的原因，流水线会把文档标成
// 「解析失败」，但不影响插件其余部分。
// ============================================================================
let pdfjsPromise = null;

function loadPdfjs() {
	if (!pdfjsPromise) {
		pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch((error) => {
			pdfjsPromise = null;
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`PDF 解析器不可用（pdfjs-dist 加载失败：${reason}）`);
		});
	}
	return pdfjsPromise;
}

/** 把一页的 text item 按物理行拼起来。 */
function pageLines(items) {
	const lines = [];
	let current = '';
	let lastY = null;
	for (const item of items) {
		if (typeof item.str !== 'string') continue;
		const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : null;
		if (lastY !== null && y !== null && Math.abs(y - lastY) > 3 && current.trim()) {
			lines.push(current.replace(/\s+/g, ' ').trim());
			current = '';
		}
		current += item.str;
		if (item.hasEOL) {
			if (current.trim()) lines.push(current.replace(/\s+/g, ' ').trim());
			current = '';
		}
		lastY = y;
	}
	if (current.trim()) lines.push(current.replace(/\s+/g, ' ').trim());
	return lines.filter(Boolean);
}

export async function extractPdf({ buffer }) {
	const pdfjs = await loadPdfjs();
	const data = new Uint8Array(buffer);
	let doc;
	try {
		doc = await pdfjs.getDocument({
			data,
			useSystemFonts: false,
			disableFontFace: true,
			isEvalSupported: false,
			useWorkerFetch: false,
			verbosity: 0,
		}).promise;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (/password|encrypt/i.test(reason)) throw new Error('PDF 已加密，无法抽取正文');
		throw new Error(`PDF 打不开：${reason}`);
	}

	const blocks = [];
	let textPages = 0;
	try {
		for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
			const page = await doc.getPage(pageNumber);
			let content;
			try {
				content = await page.getTextContent();
			} finally {
				// 页面对象用完即弃，避免大文档累积内存
				page.cleanup?.();
			}
			const lines = pageLines(content.items ?? []);
			if (!lines.length) continue;
			textPages += 1;
			blocks.push({ kind: 'page', page: pageNumber, text: `第 ${pageNumber} 页` });
			for (const line of lines) blocks.push({ kind: 'text', page: pageNumber, text: line });
		}
	} finally {
		try { await doc.destroy(); } catch { /* ignore */ }
	}

	if (!blocks.length || textPages === 0) {
		throw new Error('这个 PDF 没有可抽取的文字层（可能是扫描件）');
	}
	return { blocks, pageCount: doc.numPages };
}
