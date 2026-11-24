// ============================================================================
// 对练模型层测试：锁住 DSH llm 的调用契约
//
// 真契约（从 @deepseek-ai/dsh-llm 的实现里核过）：
//   llm.listProviders()        → [{ id, ... }]
//   llm.listModels(providerId) → Promise<[{ id, reasoning?: { efforts: [{ id }] } }]>
//   llm.stream({ provider, model, messages }) → AsyncIterable<StreamChunk>
//
// 这里曾经写错成「不带参数调 listModels」，结果服务商有 4 个、模型永远 0 个。
// 这个测试就是防止再退回那种写法。
//
//   node test/exam-chat.mjs
// ============================================================================

import { createExamChat } from '../lib/exam/chat.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
	if (ok) { passed += 1; console.log(`  ok   ${name}`); }
	else { failed += 1; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

const quiet = { warn() {}, info() {}, error() {} };

// ── 假 llm：p1 有两个模型，p2 一查就报错（模拟没配 Key） ──────────────
function makeLlm({ throwOn = 'p2' } = {}) {
	const calls = { listModels: [], stream: [] };
	return {
		calls,
		listProviders: () => [{ id: 'p1', name: '服务商一' }, { id: 'p2', name: '服务商二' }],
		async listModels(providerId) {
			calls.listModels.push(providerId);
			if (providerId === throwOn) throw new Error('没有 Key');
			if (providerId === 'p1') {
				return [
					{ id: 'model-a', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } },
					{ id: 'model-b' },
				];
			}
			return [];
		},
		async *stream(options) {
			calls.stream.push(options);
			yield { type: 'text-delta', text: '你好，' };
			yield { type: 'text-delta', text: '这是回答。' };
			yield { type: 'finish' };
		},
	};
}

console.log('\n[1] 模型发现');
{
	const llm = makeLlm();
	const client = createExamChat({ llm, logger: quiet });
	const models = await client.listModels();
	check('按服务商逐个查', llm.calls.listModels.includes('p1'), JSON.stringify(llm.calls.listModels));
	check('跳过报错的服务商', models.every((item) => item.provider === 'p1'), JSON.stringify(models));
	check('拿到 2 个模型', models.length === 2, String(models.length));
	check('字段名是 model', models[0]?.model === 'model-a', JSON.stringify(models[0]));
	check('带出 reasoning efforts', JSON.stringify(models[0]?.efforts) === JSON.stringify(['low', 'high']), JSON.stringify(models[0]?.efforts));

	const picked = await client.pickDefault();
	check('默认取第一个', picked?.provider === 'p1' && picked?.model === 'model-a', JSON.stringify(picked));
}

console.log('\n[2] 自检');
{
	const ok = await createExamChat({ llm: makeLlm(), logger: quiet }).diag();
	check('可用时 ready=true', ok.ready === true);
	check('带出选中的模型', ok.picked?.model === 'model-a', JSON.stringify(ok.picked));

	const empty = await createExamChat({ llm: { listProviders: () => [], listModels: async () => [], stream() {} }, logger: quiet }).diag();
	check('没服务商时 ready=false', empty.ready === false && empty.reason === 'no_models');
	check('提示里说明没有服务商', String(empty.message).includes('没有可用的服务商'), empty.message);

	const none = createExamChat({ llm: null, logger: quiet });
	const d = await none.diag();
	check('没有 llm 服务时 ready=false', d.ready === false && d.reason === 'no_service');
}

console.log('\n[3] 调用模型');
{
	const llm = makeLlm();
	const client = createExamChat({ llm, logger: quiet });
	const text = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
	check('把 text-delta 拼起来', text === '你好，这是回答。', text);
	const call = llm.calls.stream[0];
	check('默认挑了 provider/model', call?.provider === 'p1' && call?.model === 'model-a', JSON.stringify({ p: call?.provider, m: call?.model }));
	check('透传 messages', Array.isArray(call?.messages) && call.messages.length === 1);

	const forced = await client.chat({ messages: [], provider: 'p2', model: 'x' });
	check('指定 provider/model 时不再自动挑', forced === '你好，这是回答。');
}

console.log(`\n${failed ? `失败 ${failed} 项` : '全部通过 ✓'}（通过 ${passed} 项）`);
process.exit(failed ? 1 : 0);
