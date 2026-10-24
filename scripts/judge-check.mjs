#!/usr/bin/env node
/**
 * 回复安全网开启前提的第二项量测：用标注样本验证裁判准确率。
 * 裁判会产生真实调用成本；必须先确认误发风险，再开启自动兜底。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { judgeTextOnly } from '../skills/reply-safety/salvage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `用法：node scripts/judge-check.mjs [选项]

对 test/judge-cases.json 调用正文裁判并计算准确率。
  --limit <N>  只跑前 N 条（省额度）
  --json        输出 JSON
  --help        显示本帮助`;
function parseArgs(argv) {
  const out = { limit: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--help' || argv[i] === '-h') { console.log(HELP); process.exit(0); }
    if (argv[i] === '--json') { out.json = true; continue; }
    if (argv[i] === '--limit') { out.limit = Number(argv[++i]); continue; }
    throw new Error(`未知参数：${argv[i]}`);
  }
  if (out.limit !== null && (!Number.isInteger(out.limit) || out.limit < 1)) throw new Error('--limit 必须是正整数');
  return out;
}
function configured(c) {
  const api = c?.api || {};
  return Boolean(String(api.baseUrl || '').trim() && String(api.model || '').trim() && String(api.apiKey || '').trim());
}
function estimate(count) { return Math.max(1, Math.round(count * 270)); }

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const file = path.join(ROOT, 'test', 'judge-cases.json');
  let cases;
  try { cases = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`无法读取样本集：${e.message}`); }
  if (!Array.isArray(cases)) throw new Error('样本集必须是数组');
  const selected = opt.limit ? cases.slice(0, opt.limit) : cases;
  const cfg = getConfig();
  const notice = `这将发起 ${selected.length} 次模型调用，约消耗 ${estimate(selected.length)} token`;
  if (!opt.json) console.log(notice);
  if (!configured(cfg)) {
    const message = '需要先配置模型才能跑（请在设置里填写 API Base URL、模型和 API Key）。';
    if (opt.json) console.log(JSON.stringify({ skipped: true, message, plannedCalls: selected.length }, null, 2)); else console.log(message);
    return;
  }
  const rows = [];
  let localSkipped = 0;
  for (const item of selected) {
    const result = await judgeTextOnly({ text: item.text, trigger: item.trigger, api: cfg.api });
    const actual = result.say ? 'say' : 'skip';
    if (result.error && /本地端点跳过/.test(result.error)) localSkipped += 1;
    rows.push({ id: item.id, text: item.text, expect: item.expect, actual, correct: actual === item.expect, error: result.error || undefined });
  }
  const wrong = rows.filter((r) => !r.correct);
  const falseSend = rows.filter((r) => r.expect === 'skip' && r.actual === 'say').length;
  const missedSend = rows.filter((r) => r.expect === 'say' && r.actual === 'skip').length;
  const output = { total: rows.length, correct: rows.length - wrong.length, accuracy: rows.length ? (rows.length - wrong.length) / rows.length : 0, confusion: { falseSend, missedSend }, localSkipped, wrong };
  if (opt.json) { console.log(JSON.stringify(output, null, 2)); return; }
  console.log(`\n准确率：${(output.accuracy * 100).toFixed(1)}%（${output.correct}/${output.total}）`);
  console.log(`混淆矩阵：误发（该 skip → say）${falseSend} 次；漏发（该 say → skip）${missedSend} 次`);
  if (wrong.length) { console.log('\n判错样本：'); for (const r of wrong) console.log(`- ${r.id}：${r.text}；期望 ${r.expect}，实际 ${r.actual}`); }
  if (localSkipped) console.log('\n提示：本地端点被跳过，请在设置里打开 allowLocalJudge 或换用远程模型。');
  if (falseSend > 0) console.log('\n⚠️ 警告：误发把内心话发进群，严重得多；误发超过 0 例，不建议开启兜底。');
  else console.log('\n结论：误发（把内心话发进群）比漏发严重得多；本次误发为 0 例。');
}
main().catch((e) => { console.error(`错误：${e.message}\n\n${HELP}`); process.exitCode = 1; });
