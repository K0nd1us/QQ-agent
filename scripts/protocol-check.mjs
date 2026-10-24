#!/usr/bin/env node
/**
 * 回复安全网开启前提的第一项量测：确认模型有多常忘记调用工具。
 * 只有先知道协议失败率，才值得承担兜底逻辑可能误判的风险。
 */
import fs from 'node:fs';
import path from 'node:path';

const HELP = `用法：node scripts/protocol-check.mjs [选项]

扫描会话留档，统计未调用工具的运行比例。
  --data-dir <路径>  数据目录（默认 ./data）
  --days <N>         只统计最近 N 天
  --json             输出 JSON
  --help             显示本帮助`;

function args(argv) {
  const out = { dataDir: './data', days: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--data-dir') { out.dataDir = argv[++i] ?? out.dataDir; continue; }
    if (a === '--days') { out.days = Number(argv[++i]); continue; }
    throw new Error(`未知参数：${a}`);
  }
  if (out.days !== null && (!Number.isFinite(out.days) || out.days < 0)) throw new Error('--days 必须是非负数字');
  return out;
}

function hasToolCall(messages) {
  return (Array.isArray(messages) ? messages : []).some((m) => m && (m.toolCall || (Array.isArray(m.tool_calls) && m.tool_calls.length)));
}
function nonEmptyBody(messages) {
  return (Array.isArray(messages) ? messages : []).some((m) => m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
}
function bump(map, key) { const k = String(key || '（未记录）'); map[k] = (map[k] || 0) + 1; }
function pct(n, d) { return d ? `${(n * 100 / d).toFixed(1)}%` : '0.0%'; }
function sortedEntries(obj) { return Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); }

function main() {
  const opt = args(process.argv.slice(2));
  const dir = path.resolve(opt.dataDir, 'sessions');
  const result = { dataDir: path.resolve(opt.dataDir), total: 0, noTool: 0, noToolWithBody: 0, byModel: {}, byFinishReason: {}, skippedFiles: 0 };
  if (!fs.existsSync(dir)) {
    if (opt.json) console.log(JSON.stringify({ ...result, missing: true }, null, 2));
    else console.log(`没有找到会话目录：${dir}\n请先运行机器人产生 data/sessions/*.json。`);
    return;
  }
  const cutoff = opt.days === null ? null : Date.now() - opt.days * 86400000;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const full = path.join(dir, file);
      const s = JSON.parse(fs.readFileSync(full, 'utf8'));
      const started = Number(s.startedAt) || fs.statSync(full).mtimeMs;
      if (cutoff !== null && started < cutoff) continue;
      result.total += 1;
      const noTool = !hasToolCall(s.messages);
      if (noTool) { result.noTool += 1; if (nonEmptyBody(s.messages)) result.noToolWithBody += 1; }
      const model = String(s.model || s.api?.model || '（未记录）');
      const finish = s.finishReason || s.outcome?.finishReason || '（未记录）';
      if (!result.byModel[model]) result.byModel[model] = { total: 0, noTool: 0, noToolWithBody: 0 };
      result.byModel[model].total += 1;
      if (noTool) { result.byModel[model].noTool += 1; if (nonEmptyBody(s.messages)) result.byModel[model].noToolWithBody += 1; }
      bump(result.byFinishReason, finish);
    } catch { result.skippedFiles += 1; }
  }
  if (opt.json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(`数据目录：${result.dataDir}${opt.days === null ? '' : `（最近 ${opt.days} 天）`}`);
  console.log(`\n总体：总运行数 ${result.total}，整轮无工具 ${result.noTool}（${pct(result.noTool, result.total)}），其中正文非空 ${result.noToolWithBody}`);
  console.log('\n按模型：');
  console.log('模型'.padEnd(28) + '总数'.padStart(8) + '无工具'.padStart(10) + '比例'.padStart(10) + '正文非空'.padStart(12));
  for (const [model, v] of sortedEntries(result.byModel)) console.log(model.slice(0, 26).padEnd(28) + String(v.total).padStart(8) + String(v.noTool).padStart(10) + pct(v.noTool, v.total).padStart(10) + String(v.noToolWithBody).padStart(12));
  console.log('\n按 finishReason：');
  for (const [k, v] of sortedEntries(result.byFinishReason)) console.log(`  ${k}: ${v}`);
  if (result.skippedFiles) console.log(`\n跳过损坏/无法读取的文件：${result.skippedFiles}`);
  console.log(`\n结论：不调工具 ${pct(result.noTool, result.total)}（${result.noTool}/${result.total}），其中 ${result.noToolWithBody} 次正文非空；这正是回复安全网的潜在兜底对象。`);
}
try { main(); } catch (e) { console.error(`错误：${e.message}\n\n${HELP}`); process.exitCode = 1; }
