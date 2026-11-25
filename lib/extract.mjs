// ============================================================================
// 文本抽取：把各种文件变成 [{kind, level?, page?, text}] 的块序列。
//
// 统一输出形状便于后面共用分块与阅读器：
//   { blocks: [{ kind: 'heading'|'text'|'table'|'page', level?, page?, text }], pageCount }
//  - heading：章节标题（level 1-6）
//  - text   ：普通段落/行
//  - table  ：表格行（'| a | b |' 形式），给检索和阅读都能看
//  - page   ：分页标记（PPT 幻灯片、PDF 页）
//
// 除 PDF 外都不依赖第三方库：docx/pptx/xlsx 都是 ZIP + XML，自己解。
// ============================================================================
import { inflateRawSync } from 'node:zlib';

// ── ZIP（只解 office 文档需要的那点：中央目录 + stored/deflate）─────────────
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 96 * 1024 * 1024;

function findEocd(buffer) {
	for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i -= 1) {
		if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
	}
	return -1;
}

export function readZip(buffer) {
	const eocd = findEocd(buffer);
	if (eocd < 0) throw new Error('不是有效的 ZIP 容器');
	const count = buffer.readUInt16LE(eocd + 10);
	const cdOffset = buffer.readUInt32LE(eocd + 16);
	if (cdOffset <= 0 || cdOffset >= buffer.length) throw new Error('ZIP 中央目录偏移异常');
	const entries = new Map();
	let pointer = cdOffset;
	for (let index = 0; index < count && pointer + 46 <= buffer.length; index += 1) {
		if (buffer.readUInt32LE(pointer) !== CD_SIG) break;
		const method = buffer.readUInt16LE(pointer + 10);
		const compSize = buffer.readUInt32LE(pointer + 20);
		const uncompSize = buffer.readUInt32LE(pointer + 24);
		const nameLen = buffer.readUInt16LE(pointer + 28);
		const extraLen = buffer.readUInt16LE(pointer + 30);
		const commentLen = buffer.readUInt16LE(pointer + 32);
		const localOffset = buffer.readUInt32LE(pointer + 42);
		const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLen);
		entries.set(name, { method, compSize, uncompSize, localOffset });
		pointer += 46 + nameLen + extraLen + commentLen;
	}
	return {
		names: [...entries.keys()],
		has: (name) => entries.has(name),
		get(name) {
			const entry = entries.get(name);
			if (!entry) return null;
			const local = entry.localOffset;
			if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIG) {
				throw new Error('ZIP 局部头损坏');
			}
			const nameLen = buffer.readUInt16LE(local + 26);
			const extraLen = buffer.readUInt16LE(local + 28);
			const start = local + 30 + nameLen + extraLen;
			const raw = buffer.subarray(start, start + entry.compSize);
			if (entry.method === 0) return raw;
			if (entry.method === 8) {
				if (entry.uncompSize > MAX_ENTRY_BYTES) throw new Error('ZIP 条目过大');
				return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
			}
			throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}`);
		},
	};
}

// ── XML 小工具 ────────────────────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
	return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X'
				? Number.parseInt(body.slice(2), 16)
				: Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[body] ?? whole;
	});
}

function stripTags(xml) {
	return decodeEntities(String(xml).replace(/<[^>]*>/g, ''));
}

/** 把一段 XML 里同名的兄弟元素按配对切出来（正确处理同名嵌套与自闭合）。 */
function sliceElements(xml, name) {
	const out = [];
	const tagRe = new RegExp(`<(/?)${name}(\\s[^>]*)?(/?)>`, 'g');
	let depth = 0;
	let start = -1;
	let match;
	while ((match = tagRe.exec(xml))) {
		const closing = match[1] === '/';
		const selfClosing = match[3] === '/';
		if (closing) {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				out.push(xml.slice(start, tagRe.lastIndex));
				start = -1;
			}
			continue;
		}
		if (depth === 0) start = match.index;
		if (selfClosing) {
			if (depth === 0) {
				out.push(xml.slice(start, tagRe.lastIndex));
				start = -1;
			}
			continue;
		}
		depth += 1;
	}
	return out;
}

function paragraphText(xml) {
	const withBreaks = String(xml)
		.replace(/<w:tab\/>/g, ' ')
		.replace(/<w:br\s*\/>/g, '\n')
		.replace(/<w:cr\s*\/>/g, '\n')
		.replace(/<\/w:p>/g, '\n</w:p>');
	return decodeEntities(withBreaks.replace(/<[^>]*>/g, ''))
		.replace(/\u000b/g, '\n')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function headingLevelOfParagraph(xml) {
	const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(xml);
	if (style) {
		const value = style[1];
		const heading = /^heading\s*(\d)$/i.exec(value);
		if (heading) return Number(heading[1]);
		const numeric = /^(\d)$/.exec(value);
		if (numeric) return Number(numeric[1]);
		const cn = /^标题\s*(\d)$/.exec(value);
		if (cn) return Number(cn[1]);
	}
	const outline = /<w:outlineLvl\s+w:val="(\d)"/.exec(xml);
	if (outline) return Math.min(6, Number(outline[1]) + 1);
	return 0;
}

// ── Markdown ──────────────────────────────────────────────────────────────
function extractMarkdown(text) {
	const blocks = [];
	let fence = false;
	let buffer = [];
	const flush = () => {
		const value = buffer.join('\n').trim();
		if (value) blocks.push({ kind: 'text', text: value });
		buffer = [];
	};
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) {
			fence = !fence;
			buffer.push(line);
			continue;
		}
		if (!fence) {
			const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
			if (heading) {
				flush();
				blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
				continue;
			}
		}
		buffer.push(line);
	}
	flush();
	return { blocks, pageCount: 0 };
}

// ── HTML ──────────────────────────────────────────────────────────────────
function extractHtml(text) {
	const cleaned = String(text)
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '');
	const blocks = [];
	const re = /<(h[1-6]|p|li|div|br|td|th|tr)\b[^>]*>([\s\S]*?)<\/\1>|<br\s*\/?>/gi;
	let last = 0;
	let match;
	const pushText = (value) => {
		const body = stripTags(value).replace(/[ \t]+/g, ' ').trim();
		if (body) blocks.push({ kind: 'text', text: body });
	};
	while ((match = re.exec(cleaned))) {
		if (match.index > last) pushText(cleaned.slice(last, match.index));
		if (match[1] && /^h[1-6]$/i.test(match[1])) {
			const body = stripTags(match[2]).replace(/\s+/g, ' ').trim();
			if (body) blocks.push({ kind: 'heading', level: Number(match[1][1]), text: body });
		} else if (match[1]) {
			pushText(match[2]);
		}
		last = re.lastIndex;
	}
	if (last < cleaned.length) pushText(cleaned.slice(last));
	const merged = [];
	for (const block of blocks) {
		if (block.kind === 'text' && block.text.length < 400) {
			const previous = merged[merged.length - 1];
			if (previous && previous.kind === 'text') {
				previous.text = `${previous.text}\n${block.text}`;
				continue;
			}
		}
		merged.push(block);
	}
	return { blocks: merged, pageCount: 0 };
}

// ── 纯文本 / CSV ──────────────────────────────────────────────────────────
function extractPlain(text) {
	const blocks = [];
	const chunks = String(text).split(/\n{2,}/);
	for (const chunk of chunks) {
		const value = chunk.replace(/[ \t]+\n/g, '\n').trim();
		if (value) blocks.push({ kind: 'text', text: value });
	}
	return { blocks: blocks.length ? blocks : [{ kind: 'text', text: '' }], pageCount: 0 };
}

function parseDelimited(text, delimiter) {
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; }
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"') { quoted = true; continue; }
		if (char === delimiter) { row.push(field); field = ''; continue; }
		if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
		if (char === '\r') continue;
		field += char;
	}
	if (field.length || row.length) { row.push(field); rows.push(row); }
	return rows.filter((item) => item.some((cell) => String(cell).trim() !== ''));
}

function extractCsv(text) {
	const delimiter = (text.split('\n')[0] || '').includes('\t') ? '\t' : ',';
	const rows = parseDelimited(text, delimiter);
	const blocks = [{ kind: 'heading', level: 2, text: '表格' }];
	for (const row of rows) blocks.push({ kind: 'table', text: `| ${row.join(' | ')} |` });
	return { blocks, pageCount: 0, rows };
}

// ── DOCX ──────────────────────────────────────────────────────────────────
function extractDocx(buffer) {
	const zip = readZip(buffer);
	const main = zip.get('word/document.xml');
	if (!main) throw new Error('DOCX 里找不到 word/document.xml');
	const xml = main.toString('utf8');
	const body = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml);
	const content = body ? body[1] : xml;
	const blocks = [];
	const walker = /<w:(p|tbl)\b[^>]*>/g;
	let cursor = 0;
	let match;
	while ((match = walker.exec(content))) {
		if (match.index < cursor) continue;
		const tag = match[1];
		const slice = sliceElements(content.slice(match.index), `w:${tag}`)[0];
		if (!slice) continue;
		cursor = match.index + slice.length;
		walker.lastIndex = cursor;
		if (tag === 'p') {
			const body2 = paragraphText(slice);
			if (!body2) continue;
			const level = headingLevelOfParagraph(slice);
			blocks.push(level ? { kind: 'heading', level, text: body2.replace(/\n+/g, ' ') } : { kind: 'text', text: body2 });
			continue;
		}
		const rows = sliceElements(slice, 'w:tr');
		for (const rowXml of rows) {
			const cells = sliceElements(rowXml, 'w:tc').map((cell) => paragraphText(cell).replace(/\n+/g, ' ').trim());
			if (cells.some(Boolean)) blocks.push({ kind: 'table', text: `| ${cells.join(' | ')} |` });
		}
	}
	return { blocks, pageCount: 0 };
}

// ── PPTX ──────────────────────────────────────────────────────────────────
function extractPptx(buffer) {
	const zip = readZip(buffer);
	const slides = zip.names
		.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
		.sort((left, right) => Number(/(\d+)\.xml$/.exec(left)[1]) - Number(/(\d+)\.xml$/.exec(right)[1]));
	if (!slides.length) throw new Error('PPTX 里找不到幻灯片');
	const blocks = [];
	slides.forEach((name, index) => {
		const page = index + 1;
		blocks.push({ kind: 'page', page, text: `第 ${page} 页` });
		const xml = zip.get(name)?.toString('utf8') ?? '';
		const paragraphs = sliceElements(xml, 'a:p');
		for (const paragraph of paragraphs) {
			const body = paragraphText(paragraph).replace(/\n+/g, ' ').trim();
			if (body) blocks.push({ kind: 'text', text: body, page });
		}
		const notesName = name.replace('slides/slide', 'notesSlides/notesSlide');
		if (zip.has(notesName)) {
			const notes = paragraphText(zip.get(notesName)?.toString('utf8') ?? '').trim();
			if (notes) blocks.push({ kind: 'text', text: `备注：${notes}`, page });
		}
	});
	return { blocks, pageCount: slides.length };
}

// ── XLSX ──────────────────────────────────────────────────────────────────
function extractXlsx(buffer) {
	const zip = readZip(buffer);
	const shared = [];
	if (zip.has('xl/sharedStrings.xml')) {
		const xml = zip.get('xl/sharedStrings.xml').toString('utf8');
		for (const item of sliceElements(xml, 'si')) shared.push(paragraphText(item).replace(/\n+/g, ' ').trim());
	}
	const sheetNames = [];
	if (zip.has('xl/workbook.xml')) {
		const xml = zip.get('xl/workbook.xml').toString('utf8');
		const re = /<sheet\b[^>]*name="([^"]*)"[^>]*\/?>/g;
		let match;
		while ((match = re.exec(xml))) sheetNames.push(decodeEntities(match[1]));
	}
	const sheetFiles = zip.names
		.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
		.sort((left, right) => Number(/(\d+)\.xml$/.exec(left)[1]) - Number(/(\d+)\.xml$/.exec(right)[1]));
	if (!sheetFiles.length) throw new Error('XLSX 里找不到工作表');
	const blocks = [];
	sheetFiles.forEach((name, index) => {
		const title = sheetNames[index] || `Sheet${index + 1}`;
		blocks.push({ kind: 'heading', level: 2, text: title });
		const xml = zip.get(name)?.toString('utf8') ?? '';
		const rows = sliceElements(xml, 'row');
		let emitted = 0;
		for (const rowXml of rows) {
			const cells = sliceElements(rowXml, 'c').map((cellXml) => {
				const type = /\st="([^"]+)"/.exec(cellXml)?.[1] ?? '';
				if (type === 'inlineStr') {
					const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cellXml);
					return inline ? decodeEntities(inline[1]).trim() : '';
				}
				const value = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? '';
				if (type === 's') return shared[Number(value)] ?? '';
				return decodeEntities(value).trim();
			});
			if (!cells.some((cell) => cell !== '')) continue;
			blocks.push({ kind: 'table', text: `| ${cells.join(' | ')} |` });
			emitted += 1;
		}
		if (!emitted) blocks.push({ kind: 'text', text: '（空工作表）' });
	});
	return { blocks, pageCount: sheetFiles.length };
}

// ── 表格网格（给界面画表格用，不参与索引文本）────────────────────────────
// 为什么单独一套：LibreOffice 把 xlsx 转 PDF 时按工作表自带的页面设置走，
// 列一宽就被裁掉（界面上看到的是半截表）。这里直接读单元格，界面可以横向滚动。
const GRID_MAX_ROWS = 300;
const GRID_MAX_COLS = 40;
const GRID_MAX_SHEETS = 3;

function cellText(cellXml, shared) {
	const type = /\st="([^"]+)"/.exec(cellXml)?.[1] ?? '';
	if (type === 'inlineStr') {
		const inline = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cellXml);
		return inline ? decodeEntities(inline[1]).trim() : '';
	}
	const value = /<v>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] ?? '';
	if (type === 's') return shared[Number(value)] ?? '';
	if (!value) return '';
	return decodeEntities(value).trim();
}

function columnIndex(ref) {
	const letters = /^([A-Z]+)/.exec(String(ref ?? '').toUpperCase())?.[1] ?? '';
	let index = 0;
	for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
	return index - 1;
}

function gridFromXlsx(buffer) {
	const zip = readZip(buffer);
	const shared = [];
	if (zip.has('xl/sharedStrings.xml')) {
		const xml = zip.get('xl/sharedStrings.xml').toString('utf8');
		for (const item of sliceElements(xml, 'si')) shared.push(paragraphText(item).replace(/\n+/g, ' ').trim());
	}
	const names = [];
	if (zip.has('xl/workbook.xml')) {
		const xml = zip.get('xl/workbook.xml').toString('utf8');
		const re = /<sheet\b[^>]*name="([^"]*)"[^>]*\/?>/g;
		let matched;
		while ((matched = re.exec(xml))) names.push(decodeEntities(matched[1]));
	}
	const sheetFiles = zip.names
		.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
		.sort((left, right) => Number(/(\d+)\.xml$/.exec(left)[1]) - Number(/(\d+)\.xml$/.exec(right)[1]));
	if (!sheetFiles.length) throw new Error('XLSX 里找不到工作表');

	const sheets = [];
	for (const [sheetIndex, sheetPath] of sheetFiles.slice(0, GRID_MAX_SHEETS).entries()) {
		const xml = zip.get(sheetPath)?.toString('utf8') ?? '';
		const rowXmls = sliceElements(xml, 'row');
		const rows = [];
		let width = 0;
		let truncated = rowXmls.length > GRID_MAX_ROWS;
		for (const rowXml of rowXmls) {
			if (rows.length >= GRID_MAX_ROWS) break;
			const cells = [];
			for (const cellXml of sliceElements(rowXml, 'c')) {
				const ref = /\sr="([A-Z]+)\d+"/.exec(cellXml)?.[1] ?? '';
				const at = columnIndex(ref);
				if (at >= 0 && at < GRID_MAX_COLS) {
					while (cells.length < at) cells.push('');
					cells[at] = cellText(cellXml, shared);
				}
			}
			if (!cells.some((cell) => cell !== '')) continue;
			width = Math.max(width, cells.length);
			rows.push(cells);
		}
		sheets.push({
			name: names[sheetIndex] || `Sheet${sheetIndex + 1}`,
			rows,
			columns: Math.min(width, GRID_MAX_COLS),
			totalRows: rowXmls.length,
			truncated,
		});
	}
	return { kind: 'grid', sheets, sheetCount: sheetFiles.length };
}

function gridFromDelimited(buffer, separator) {
	const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
	const lines = text.split(/\r?\n/);
	const rows = [];
	let truncated = lines.length > GRID_MAX_ROWS;
	for (const line of lines) {
		if (rows.length >= GRID_MAX_ROWS) break;
		if (!line.trim()) continue;
		rows.push(line.split(separator).slice(0, GRID_MAX_COLS).map((cell) => cell.trim()));
	}
	const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
	return {
		kind: 'grid',
		sheets: [{ name: '表格', rows, columns, totalRows: lines.length, truncated }],
		sheetCount: 1,
	};
}

/**
 * 把表格文件解成网格。不支持的格式返回 null（界面继续走逐页预览）。
 * @param {Buffer} buffer
 * @param {string} ext 小写扩展名
 */
export function gridOf(buffer, ext) {
	if (ext === 'xlsx') return gridFromXlsx(buffer);
	if (ext === 'csv') return gridFromDelimited(buffer, ',');
	if (ext === 'tsv') return gridFromDelimited(buffer, '\t');
	return null;
}
// ── 入口 ──────────────────────────────────────────────────────────────────
const TEXT_EXTENSIONS = new Set([
	'md', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml',
	'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'hpp',
	'cs', 'rb', 'php', 'sh', 'ps1', 'sql', 'css', 'scss', 'xml', 'toml', 'ini', 'conf',
]);

export const SUPPORTED_EXTENSIONS = new Set([
	...TEXT_EXTENSIONS,
	'html', 'htm', 'docx', 'pptx', 'xlsx', 'doc', 'ppt', 'xls', 'pdf',
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
]);

/** 这个扩展名是否需要正文索引（图片只做预览）。 */
export function isIndexable(ext) {
	return ext !== 'png' && ext !== 'jpg' && ext !== 'jpeg' && ext !== 'gif'
		&& ext !== 'webp' && ext !== 'bmp' && ext !== 'svg';
}

export const MIME_BY_EXT = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	doc: 'application/msword',
	ppt: 'application/vnd.ms-powerpoint',
	xls: 'application/vnd.ms-excel',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	md: 'text/markdown',
	markdown: 'text/markdown',
	txt: 'text/plain',
	csv: 'text/csv',
	json: 'application/json',
	html: 'text/html',
	htm: 'text/html',
};

/** 抽取主入口。返回 { blocks, pageCount }；不认识就抛错。 */
export async function extract({ ext, buffer, filePath }) {
	if (ext === 'pdf') {
		const { extractPdf } = await import('./pdf.mjs');
		return extractPdf({ buffer, filePath });
	}
	if (ext === 'docx') return extractDocx(buffer);
	if (ext === 'pptx') return extractPptx(buffer);
	if (ext === 'xlsx') return extractXlsx(buffer);
	if (ext === 'doc' || ext === 'ppt' || ext === 'xls') {
		throw new Error('老版 Office 格式暂不支持正文索引（可以预览原文件）');
	}
	if (ext === 'html' || ext === 'htm') return extractHtml(buffer.toString('utf8'));
	if (ext === 'md' || ext === 'markdown') return extractMarkdown(buffer.toString('utf8'));
	if (ext === 'csv' || ext === 'tsv') {
		const { blocks, pageCount } = extractCsv(buffer.toString('utf8'));
		return { blocks, pageCount };
	}
	if (TEXT_EXTENSIONS.has(ext)) return extractPlain(buffer.toString('utf8'));
	throw new Error(`暂不支持 ${ext || '该'} 格式的正文抽取`);
}
