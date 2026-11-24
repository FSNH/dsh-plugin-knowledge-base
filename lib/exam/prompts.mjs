/**
 * 对练模式的 prompt 模板与输出契约。
 *
 * 三条铁律（每个模板的 system 里都会重复一遍，模型漏了任意一条就跑偏）：
 *   1. 只依据给定片段出题/评分，片段里没有的事实不许出现在题面或评分标准里；
 *   2. 一次只出一题，不要把多题塞进一个 JSON；
 *   3. 评分只按 expectedPoints 给分，用户没提到的要点写进 missing，不要替他"大概就是这个意思"。
 */

export const RULES = `你是一个严格但耐心的考官，负责基于给定的知识库片段对用户进行学习对练。

铁律（违反任意一条即为错误输出）：
1. 只能依据【片段】里出现的事实出题和评分。片段里没有的内容，不许出现在题面、参考答案或评分标准里。不确定就不出这道题。
2. 一次只输出一道题，不要一次给多道，也不要在题里附带答案。
3. 评分只按【预期要点】给分。用户答案里没有提到的要点，写进 missing，不要自行脑补。
4. 只输出 JSON，不要任何解释、前后缀或 Markdown 代码块。`;

const json = (value) => JSON.stringify(value, null, 2);

/** P1：读库提议 3 个学习目标。 */
export function promptObjectives({ kbName, docs }) {
	const listing = docs
		.map((doc) => `- 《${doc.name}》：${doc.excerpt.replace(/\s+/g, ' ').slice(0, 220)}`)
		.join('\n');
	return {
		purpose: 'objectives',
		messages: [
			{ role: 'system', content: RULES },
			{
				role: 'user',
				content: `知识库「${kbName}」里有这些文档：\n${listing}\n\n`
					+ '请基于这些内容，提出 3 个不同的学习目标（一句话，描述"练完能做到什么"，要可被问答检验）。\n'
					+ '每个目标给出 why（为什么这个库支撑得起）和 coverage（high/medium/low）。\n'
					+ `只输出这个 JSON：${json({ objectives: [{ text: '…', why: '…', coverage: 'high' }] })}`,
			},
		],
	};
}

/** P2：目标 + 目录 → 知识点大纲与考核计划。 */
export function promptOutline({ kbName, objective, docs }) {
	const listing = docs.map((doc) => `- ${doc.id}：《${doc.name}》（${doc.ext}）`).join('\n');
	return {
		purpose: 'outline',
		messages: [
			{ role: 'system', content: RULES },
			{
				role: 'user',
				content: `知识库「${kbName}」的文档清单：\n${listing}\n\n`
					+ `学习目标是：${objective}\n\n`
					+ '请把它拆成 3~5 个知识点（每个都要对应到上面某篇文档），并为每个知识点安排题量与难度。\n'
					+ '难度取值：recall（回忆）/ discern（辨析）/ apply（应用）。\n'
					+ `只输出这个 JSON：${json({
						kp: [{ id: 'kp1', title: '…', docIds: ['d_xxx'], reason: '…' }],
						plan: [{ kpId: 'kp1', turns: 2, difficulty: 'apply' }],
					})}`,
			},
		],
	};
}

/** P3：出题（只给当前知识点的片段）。 */
export function promptQuestion({ kpTitle, objective, fragments, asked }) {
	const context = fragments
		.map((fragment, index) => `【片段${index + 1}】《${fragment.name}》${fragment.page ? ` 第${fragment.page}页` : ''}\n${fragment.text.slice(0, 1200)}`)
		.join('\n\n');
	const history = asked.length ? `已经问过（不要重复）：\n${asked.map((item) => `- ${item}`).join('\n')}` : '还没有问过任何问题。';
	return {
		purpose: 'question',
		messages: [
			{ role: 'system', content: RULES },
			{
				role: 'user',
				content: `学习目标：${objective}\n当前知识点：${kpTitle}\n\n${context}\n\n${history}\n\n`
					+ '基于【片段】出**一道**简答题，考的是这个知识点的理解或应用，不是背书。\n'
					+ 'expectedPoints 是你判分时唯一依据的要点（2~4 条）。refs 填用到的片段序号（如 "1" 或 "1,2"）。\n'
					+ `只输出这个 JSON：${json({ question: '…', expectedPoints: ['…'], difficulty: 'apply', refs: ['1'] })}`,
			},
		],
	};
}

/** P4：评分（题面 + 预期要点 + 用户答案）。 */
export function promptGrade({ question, expectedPoints, answer }) {
	return {
		purpose: 'grade',
		messages: [
			{ role: 'system', content: RULES },
			{
				role: 'user',
				content: `题目：${question}\n预期要点：\n${expectedPoints.map((point, index) => `${index + 1}. ${point}`).join('\n')}\n\n`
					+ `用户回答：${answer}\n\n`
					+ '按预期要点逐条判断，给出：score（0~2，0 错 / 1 部分 / 2 对）、verdict（wrong/partial/full）、'
					+ 'missing（用户漏掉的要点原文）、comment（一句话反馈，指明对在哪/缺什么）、'
					+ 'followup（verdict=full 时追问一句更深的，否则为空字符串）。\n'
					+ `只输出这个 JSON：${json({
						score: 2,
						verdict: 'full',
						missing: [],
						comment: '…',
						followup: '…',
					})}`,
			},
		],
	};
}
