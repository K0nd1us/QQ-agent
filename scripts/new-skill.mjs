#!/usr/bin/env node
// Skill / 插件脚手架：一条命令生成可运行的骨架，省掉"抄哪个文件当模板"的开销。
//
// 用法：
//   node scripts/new-skill.mjs <id> [选项]
//
// 选项：
//   --name <显示名>        默认用 id
//   --category <分类>      model | message | knowledge | media | utility（默认 utility）
//   --desc <一句话说明>
//   --legacy               生成旧格式（plugins/<id>/plugin.json + register(api)）
//   --root <目录>          生成到指定根目录（默认本仓库根；测试用）
//   --force                目标已存在时覆盖
//
// 生成的骨架是**能直接跑**的最小实现：一个工具 + 一个能力 + 一处提示词片段，
// 加载后状态就应该是"生效中"，不是需要自己填坑的空壳。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// 与 src/skills/manifest.js 的校验保持一致
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const CATEGORIES = ['model', 'message', 'knowledge', 'media', 'utility'];

function parseArgs(argv) {
  const out = { id: '', name: '', category: 'utility', desc: '', legacy: false, root: REPO_ROOT, force: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i] ?? '';
    else if (a === '--category') out.category = argv[++i] ?? '';
    else if (a === '--desc') out.desc = argv[++i] ?? '';
    else if (a === '--root') out.root = argv[++i] ?? REPO_ROOT;
    else if (a === '--legacy') out.legacy = true;
    else if (a === '--force') out.force = true;
    else if (a.startsWith('--')) out.error = `未知参数：${a}`;
    else rest.push(a);
  }
  if (!out.id) out.id = rest[0] ?? '';
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.error) { console.error(`✗ ${args.error}`); process.exit(1); }
if (!args.id) {
  console.error('用法：node scripts/new-skill.mjs <id> [--name 显示名] [--category media] [--desc 说明] [--legacy] [--force]');
  process.exit(1);
}
if (!ID_RE.test(args.id)) {
  console.error(`✗ id 不合法：${args.id}\n  id 只允许字母/数字/._-，且必须以字母或数字开头（加载器会拒绝其它形式）`);
  process.exit(1);
}
if (!CATEGORIES.includes(args.category)) {
  console.error(`✗ category 不合法：${args.category}\n  只允许：${CATEGORIES.join(' / ')}（写别的会被加载器静默降级成 utility）`);
  process.exit(1);
}

const id = args.id;
const name = args.name || id;
const dirName = args.legacy ? 'plugins' : 'skills';
const target = path.resolve(args.root, dirName, id);

if (fs.existsSync(target) && !args.force) {
  console.error(`✗ 目标已存在：${target}\n  要覆盖请加 --force`);
  process.exit(1);
}

const desc = args.desc || `${name}（用一句话说清它解决什么问题）`;
const camelless = id.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
// 工具短名：注册后会自动变成 <skillId>__<toolId>
const toolId = 'run';

const skillJson = {
  id,
  name,
  version: '1.0.0',
  apiVersion: 1,
  category: args.category,
  description: desc,
  author: 'Your Name',
  enabledByDefault: true,
  capabilities: [`${camelless}.run`],
  requires: [],
  settings: { prefix: '结果', verbose: false },
  configSchema: {
    prefix: { type: 'string', label: '输出前缀', description: '工具返回文本的前缀，默认「结果」' },
    verbose: { type: 'boolean', label: '详细输出' }
  },
  prompt: {
    sections: [
      {
        id: `${camelless}-note`,
        title: name,
        priority: 40,
        content: `需要${name}时调用 run 工具。参数从用户消息里提取，不要反问。`
      }
    ]
  }
};

const indexJs = `// ${name} —— Skill 入口。
// 骨架已包含：工具注册 / 能力提供 / 同步自检 / 配置读取 / hook。
// 按需删掉用不到的部分，但 setup 里的 registerTool 至少留一个，
// 否则模型没有任何入口能触发这个 Skill。
let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;          // settings 默认值已合并
  log = api.log;

  api.registerTool({
    id: '${toolId}',                  // 注册后变成 ${id}__${toolId}
    name: '${name}',
    description: '${desc.replace(/'/g, "\\'")}',   // 这句给模型看，决定它会不会调用
    category: '${args.category === 'utility' ? 'system' : args.category}',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '要处理的输入' }
      },
      required: ['input']
    },
    async execute(_ctx, toolArgs) {
      const input = String(toolArgs?.input ?? '').trim();
      if (!input) return { content: '缺少 input 参数', isError: true };
      try {
        const { prefix, verbose } = cfg();
        log('执行:', input);
        // TODO: 这里换成真正的实现。
        const result = input;
        return { content: verbose ? \`\${prefix}：\${result}（输入 \${input.length} 字）\` : \`\${prefix}：\${result}\` };
      } catch (error) {
        return { content: \`执行失败：\${error?.message ?? error}\`, isError: true };
      }
    }
  });
}

// 提供能力：核心模块按能力名取用，不 import 本文件。
// 用不到能力就删掉整个 providers。
export const providers = {
  '${camelless}.run': ({ input = '' } = {}) => ({ ok: true, input })
};

// 依赖自检：⚠️ 必须同步返回。返回 Promise 会被当成"可用"（Promise 是 truthy），
// 表现为界面显示"生效中"但实际跑不通。要异步探测就参考 skills/video-frames。
export function available() { return true; }

export const hooks = {
  'after-tool': ({ toolId: t }) => { if (t === '${id}__${toolId}') log('工具执行完毕'); }
};
`;

const legacyJson = {
  id,
  name,
  version: '1.0.0',
  description: desc,
  author: 'Your Name',
  entry: 'index.js',
  permissions: [],
  prompt: {
    when: `当用户需要${name}时`,
    examples: [`帮我用一下${name}`],
    instruction: `调用 ${id}__${toolId} 工具，input 参数从用户消息提取。`
  },
  tools: [
    {
      id: toolId,
      name,
      description: desc,
      category: args.category === 'utility' ? 'system' : args.category,
      icon: '🧩',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string', description: '要处理的输入' } },
        required: ['input']
      }
    }
  ]
};

// 旧格式：plugin.json 的 tools[] 只是元数据，工具必须在入口 registerTool 注册
const legacyJs = indexJs
  .replace('export function setup(api) {', 'export function register(api) {\n  // 旧格式入口名；tools[] 只是说明性元数据，真正注册靠这里\n')
  .replace(/^export const providers[\s\S]*$/m, '')
  .replace(/^export function available[\s\S]*$/m, '')
  .replace(/^export const hooks[\s\S]*$/m, '');

const readme = `# ${name}

${desc}

## 开发

1. 改 \`${args.legacy ? 'plugin.json' : 'skill.json'}\` 里的 \`description\` / \`configSchema\` / \`prompt\`。
2. 在 \`index.js\` 的 \`execute\` 里写真正的实现。
3. 开发模式启动（保存即热重载）：

   \`\`\`bash
   QQ_AGENT_DEV=1 npm run server
   \`\`\`

4. 控制台 → 技能（Skill）页确认状态是**生效中**，再到模型目录页确认工具 \`${id}__${toolId}\` 可用。
5. 自测：\`npm run test:skill\`（架构 + 端到端）。

## 注意

- 工具 id 会成为发给模型的 function name：只允许 \`[a-zA-Z0-9_-]\`，别用 \`:\` \`.\` 拼接（严格端点会 400）。
- \`available()\` 必须同步返回。
- 需要联网要在清单里加 \`"permissions": ["web_fetch"]\`，否则拿不到 \`api.fetch\`。
`;

fs.mkdirSync(target, { recursive: true });
const write = (file, content) => fs.writeFileSync(path.join(target, file), content, 'utf8');
if (args.legacy) {
  write('plugin.json', JSON.stringify(legacyJson, null, 2) + '\n');
  write('index.js', legacyJs);
} else {
  write('skill.json', JSON.stringify(skillJson, null, 2) + '\n');
  write('index.js', indexJs);
}
write('README.md', readme);

const rel = path.relative(REPO_ROOT, target);
// 目标在仓库外（--root 指到别处）时相对路径是一串 ..\..\，不如直接给绝对路径
const shown = rel && !rel.startsWith('..') ? rel : target;
console.log(`✅ 已生成：${shown}`);
console.log(`   格式：${args.legacy ? '旧格式（plugin.json + register）' : '新格式（skill.json + setup）'}`);
console.log(`   分类：${args.category}`);
console.log(`   工具：${id}__${toolId}`);
console.log('');
console.log('下一步：');
console.log('   1. 在 index.js 的 execute 里写实现');
console.log('   2. QQ_AGENT_DEV=1 npm run server   （保存文件即热重载）');
console.log('   3. 控制台 → 技能页确认「生效中」，模型目录页确认工具可用');
console.log('   4. npm run test:skill');
console.log('   5. 发布：压缩该目录为 zip（含清单与源码）→ Skill 市场「上传 Skill ZIP」');
