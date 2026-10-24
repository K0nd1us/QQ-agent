// Create data-2/config.json from the primary configuration without copying login state.
// Re-running this script leaves an existing secondary configuration untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(ROOT, 'data');
const targetDir = path.join(ROOT, 'data-2');
const sourceFile = path.join(sourceDir, 'config.json');
const targetFile = path.join(targetDir, 'config.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`无法读取配置 ${file}: ${error.message}`);
  }
}

function numberOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

if (!fs.existsSync(sourceFile)) {
  console.error(`[错误] 找不到主实例配置：${sourceFile}`);
  process.exitCode = 1;
} else if (fs.existsSync(targetFile)) {
  console.log(`[跳过] ${targetFile} 已存在，没有覆盖已有第二实例配置。`);
  console.log('       如需重新生成，请先备份后手动删除 data-2/config.json。');
} else {
  const config = readJson(sourceFile);
  const consolePort = numberOption('console-port', (Number(config.server?.port) || 3210) + 100);
  const wsPort = numberOption('ws-port', 3011 + 100);
  const httpPort = numberOption('http-port', 3010 + 100);
  const secondary = structuredClone(config);

  secondary.server = { ...(secondary.server || {}), port: consolePort, token: '' };
  secondary.snowluma = {
    ...(secondary.snowluma || {}),
    wsUrl: `ws://127.0.0.1:${wsPort}`,
    httpUrl: `http://127.0.0.1:${httpPort}`,
    accessToken: '',
    httpAccessToken: ''
  };
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, `${JSON.stringify(secondary, null, 2)}\n`, 'utf8');
  console.log(`[完成] 已生成 ${targetFile}`);
  console.log(`[端口] 控制台 ${consolePort}，OneBot HTTP ${httpPort}，WS ${wsPort}`);
  console.log('[提示] 未复制登录态；请在第二实例中重新填写 OneBot 令牌。');
}
