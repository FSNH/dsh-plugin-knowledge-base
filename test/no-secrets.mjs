// ============================================================================
// 密钥防泄漏检查：仓库里绝不能出现真实 API Key / 私钥 / token。
//
// 检查的是「会被提交的文件」——即 git 跟踪的文件（本地目录安装时也用 git ls-files
// 取清单；没有 git 就退化成遍历目录，跳过 node_modules 与 .git）。
// 运行：node test/no-secrets.mjs
// ============================================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 常见密钥形态。注意：这里只匹配「看起来像真的」的串，不会误伤代码里的 apiKey 这个词。 */
const PATTERNS = [
	{ name: 'OpenAI / 百炼 / 硅基流动 等 sk- 密钥', re: /sk-[A-Za-z0-9_-]{16,}/ },
	{ name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
	{ name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
	{ name: '私钥块', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
	{ name: 'Bearer 长串', re: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
];

/** 允许出现的占位符（文档示例、测试替身）。 */
const ALLOW = [
	'sk-test-1234',
	'sk-xxx',
	'sk-your',
	'sk-…',
];

function listFiles() {
	try {
		const out = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' });
		return out.split(/\r?\n/).filter(Boolean).map((relative) => path.join(root, relative));
	} catch {
		const files = [];
		const walk = (dir, depth) => {
			if (depth > 6) return;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (['node_modules', '.git'].includes(entry.name)) continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full, depth + 1);
				else if (fs.statSync(full).size < 2 * 1024 * 1024) files.push(full);
			}
		};
		walk(root, 0);
		return files;
	}
}

const files = listFiles();
const hits = [];
for (const file of files) {
	// 二进制和大文件跳过
	if (!/\.(js|mjs|cjs|ts|tsx|json|yml|yaml|md|txt|svg|patch|html|css)$/i.test(file)) continue;
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		continue;
	}
	const lines = text.split(/\r?\n/);
	lines.forEach((line, index) => {
		if (ALLOW.some((placeholder) => line.includes(placeholder))) return;
		for (const pattern of PATTERNS) {
			if (pattern.re.test(line)) {
				hits.push({
					file: path.relative(root, file),
					line: index + 1,
					kind: pattern.name,
					// 只回显前 8 个字符，避免把检查日志本身变成泄漏源
					preview: line.trim().slice(0, 80),
				});
			}
		}
	});
}

// 运行时密钥文件不允许出现在仓库目录里
const forbidden = ['settings.json', '.env', '.env.local', 'credentials.json', 'id_rsa'];
const strayFiles = files
	.filter((file) => forbidden.includes(path.basename(file)))
	.map((file) => path.relative(root, file));

console.log(`扫描 ${files.length} 个文件`);

if (hits.length === 0 && strayFiles.length === 0) {
	console.log('没有发现密钥 ✓');
	process.exit(0);
}

if (strayFiles.length) {
	console.log('\n发现不该进仓库的密钥文件：');
	for (const file of strayFiles) console.log(` - ${file}`);
}
if (hits.length) {
	console.log('\n发现疑似密钥：');
	for (const hit of hits) console.log(` - ${hit.file}:${hit.line}  ${hit.kind}\n   ${hit.preview}`);
}
console.log('\n请把密钥从文件里移除（改放到 $DSH_HOME/kb/settings.json 或环境变量），再重跑。');
process.exit(1);
