// ============================================================================
// 分块：把抽取出来的块序列渲染成正文文本，同时切成检索用的片段。
//
// 渲染出来的 text 会存进 doc_text，阅读器按字符偏移分页读；片段只存
// [charStart, charEnd) 与正文副本，用于检索与命中定位。
// ============================================================================

const TARGET_CHARS = 600;
const MAX_CHUNK_CHARS = 1600;
const MIN_CHUNK_CHARS = 80;

/** 渲染后的正文里，标题行会带 '#'，分页会插一行〔第 N 页〕，方便人和模型读。 */
function lineOf(block, level) {
	if (block.kind === 'page') return `\u3014第 ${block.page ?? '?'} 页\u3015`;
	if (block.kind === 'heading') {
		const depth = Math.min(6, Math.max(1, block.level || 1));
		return `${'#'.repeat(depth)} ${block.text}`;
	}
	return block.text;
}

export function renderDocument(blocks) {
	const pieces = [];
	let offset = 0;
	let page = 0;
	const headingStack = [];
	const lines = [];

	const push = (text, meta) => {
		lines.push({
			start: offset,
			end: offset + text.length,
			text,
			heading: meta.heading,
			page: meta.page,
			kind: meta.kind,
		});
		pieces.push(text);
		offset += text.length + 1;
	};

	for (const block of blocks) {
		if (!block) continue;
		if (block.kind === 'page') {
			page = Number(block.page) || page;
			push(lineOf(block, 0), { heading: headingStack.map((item) => item.text).join(' > '), page, kind: 'page' });
			push('', { heading: headingStack.map((item) => item.text).join(' > '), page, kind: 'text' });
			continue;
		}
		if (block.kind === 'heading') {
			const level = Math.min(6, Math.max(1, block.level || 1));
			while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
			headingStack.push({ level, text: block.text });
			push(lineOf(block, level), { heading: headingStack.map((item) => item.text).join(' > '), page, kind: 'heading' });
			push('', { heading: headingStack.map((item) => item.text).join(' > '), page, kind: 'text' });
			continue;
		}
		const text = String(block.text ?? '');
		if (!text.trim()) continue;
		push(text, { heading: headingStack.map((item) => item.text).join(' > '), page: Number(block.page) || page, kind: block.kind });
	}

	const text = pieces.join('\n').replace(/\n{4,}/g, '\n\n\n');
	return { text, lines };
}

/** 把渲染后的行切成检索片段。 */
export function chunkDocument(lines) {
	const chunks = [];
	let buffer = [];
	let bufferChars = 0;
	let start = 0;
	let end = 0;
	let heading = '';
	let page = 0;

	const flush = (soft) => {
		if (!buffer.length) return;
		const body = buffer.join('\n').trim();
		const charStart = start;
		const charEnd = end;
		buffer = [];
		bufferChars = 0;
		if (!body) return;
		if (soft && body.length < MIN_CHUNK_CHARS) return;
		chunks.push({
			ord: chunks.length,
			heading: heading.slice(0, 300),
			page: page || null,
			charStart,
			charEnd,
			text: body,
		});
	};

	for (const line of lines) {
		const lineText = line.text;
		if (!lineText.trim() && bufferChars === 0) continue;

		// 单行超长：硬切成多段，保证每块都有上限
		const pieces = lineText.length > MAX_CHUNK_CHARS
			? lineText.match(new RegExp(`[\\s\\S]{1,${TARGET_CHARS}}`, 'g')) ?? [lineText]
			: [lineText];

		for (const piece of pieces) {
			if (bufferChars === 0) {
				start = line.start;
				heading = line.heading || '';
				page = line.page || 0;
			}
			buffer.push(piece);
			bufferChars += piece.length + 1;
			end = line.end;
			if (bufferChars >= TARGET_CHARS) flush(false);
		}
	}
	flush(false);
	return chunks;
}

export { TARGET_CHARS, MAX_CHUNK_CHARS };
