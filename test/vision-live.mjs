// ============================================================================
// 真实视觉服务联调（不是 mock）：读取这台机器上插件自己的配置
// （$DSH_HOME/kb/settings.json），拿一张图真的请求一次，打印模型返回的描述。
//
// 默认跳过，只有显式打开时才跑（会真的花钱）：
//   $env:ELECTRON_RUN_AS_NODE=1
//   $env:KB_TEST_LIVE=1
//   & "<DSH_NODE_EXECUTABLE>" test/vision-live.mjs [图片路径]
//
// 不传图片路径时，会用内置的 64×64 格纹图当样例。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsStore } from '../lib/settings.mjs';
import { createVisionClient } from '../lib/vision.mjs';

if (process.env.KB_TEST_LIVE !== '1') {
	console.log('跳过：这是真实接口联调，设置 KB_TEST_LIVE=1 才会执行（会产生调用费用）');
	process.exit(0);
}

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const root = path.join(home, 'kb');
const settings = createSettingsStore({ root, logger: { warn: (message) => console.log(`warn: ${message}`) } });

const saved = settings.vision();
const embeddingKey = settings.embedding().apiKey || '';
const config = {
	enabled: true,
	baseUrl: saved.baseUrl,
	model: saved.model,
	apiKey: saved.apiKey || embeddingKey,
};

if (!config.baseUrl || !config.model) {
	console.log('跳过：设置里还没有配图片理解的接口地址/模型（先在知识库设置里填好）');
	process.exit(0);
}

const imagePath = process.argv[2];
const buffer = imagePath
	? fs.readFileSync(imagePath)
	: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgElEQVR4nO3RoQ3AAAzAsP7/anH5jhiwpoUEW8rc3e5+t8MFLztc0AEt6IAWdEALOqAFHdCCDmhBB7SgA1rQAS3ogBZ0QAs6oAUd0IIOaEEHtKADWtABLeiAFnRACzqgBR3Qgg5oQQe0oANa0AEt6IAWdEALOqAFHdCCDmjB3w880FECpN+biKgAAAAASUVORK5CYII=', 'base64');
const ext = imagePath ? path.extname(imagePath).replace('.', '').toLowerCase() : 'png';

console.log(`服务：${config.baseUrl}`);
console.log(`模型：${config.model}`);
console.log(`图片：${imagePath || '（内置 64×64 格纹图）'} ${buffer.length} bytes\n`);

const client = createVisionClient({ config, logger: { warn: (message) => console.log(`warn: ${message}`) } });
const startedAt = Date.now();
const text = await client.describeImage(buffer, ext);
console.log(`耗时 ${Date.now() - startedAt} ms，返回 ${text.length} 字：\n`);
console.log(text);
