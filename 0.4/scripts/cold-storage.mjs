#!/usr/bin/env node
// 长期冷储存命令行：快照 / 检索 / 还原 / 轮转。
//
//   node scripts/cold-storage.mjs status
//   node scripts/cold-storage.mjs snapshot [--reason "手动"] [--note "..."] [--chat group:123]
//   node scripts/cold-storage.mjs list
//   node scripts/cold-storage.mjs search <关键词...> [--limit 30] [--chat group:123] [--json]
//   node scripts/cold-storage.mjs show <快照id>
//   node scripts/cold-storage.mjs restore [latest|<快照id>] [--mode memory|state] [--force]
//   node scripts/cold-storage.mjs prune [--keep 100] [--dry-run]
//
// 应用内部在每次「清空/删除/重置」之前会自动调用 src/cold-storage.js 的 captureBeforeReset，
// 这个 CLI 是给人用的入口。
import {
  snapshot,
  listSnapshots,
  searchArchives,
  restoreSnapshot,
  pruneArchives,
  archiveStatus,
  formatBytes,
  COLD_DIR
} from '../src/cold-storage.js';

const USAGE = `长期冷储存（QQ Agent）

用法：
  node scripts/cold-storage.mjs status                        概览
  node scripts/cold-storage.mjs snapshot [选项]               手动打一份快照
        --reason <文字>     触发原因（进目录名，默认 manual）
        --note <文字>       备注
        --chat <key>        只归档这个会话（可重复；不传 = 全量）
        --keep <N>          保留份数（默认 100）
  node scripts/cold-storage.mjs list [--json]                 列出所有快照
  node scripts/cold-storage.mjs search <关键词...> [选项]       在全部历史快照里检索
        --limit <N>         最多返回多少条命中（默认 100）
        --per-file <N>      同一文件最多给几条（默认 5）
        --regex <正则>      按正则匹配（替代关键词）
        --snapshot <id>     只在这份快照里找
        --chat <key>        只在这个会话自己的记录里找
        --context <N>       片段左右各留多少字符（默认 60）
        --json              机器可读输出
  node scripts/cold-storage.mjs show <快照id>                 看一份快照的清单
  node scripts/cold-storage.mjs restore [latest|<id>] [选项]   还原
        --mode memory       （默认）只把群友印象并回 memory/
        --mode state        整套覆盖 messages/ + memory/ + sessions/
        --force             应用在跑也强行还原（会被内存态覆盖，慎用）
  node scripts/cold-storage.mjs prune [--keep N] [--dry-run]   只保留最新 N 份

冷储存目录：${COLD_DIR}
（可用环境变量 QQ_AGENT_COLD_STORAGE_DIR 改到别的盘）`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 0) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i += 1; }
    else flags[name] = true;
  }
  return { positional, flags };
}

function isoLocal(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// ── 子命令 ───────────────────────────────────────────────────────────────────

function cmdStatus() {
  const st = archiveStatus();
  console.log('冷储存目录 :', st.root);
  console.log('数据目录   :', st.dataDir);
  console.log('目录存在   :', st.exists ? '是' : '否（还没有快照）');
  console.log('快照份数   :', st.count);
  console.log('占用       :', st.totalText);
  if (st.newest) console.log('最新一份   :', st.newest.id, `(${isoLocal(st.newest.createdAt)}，原因 ${st.newest.reason})`);
  if (st.oldest && st.count > 1) console.log('最旧一份   :', st.oldest.id, `(${isoLocal(st.oldest.createdAt)})`);
  console.log('应用状态   :', st.running ? `运行中（PID ${st.pid}）` : '未运行');
}

async function cmdSnapshot(flags) {
  const chats = flags.chat ? (Array.isArray(flags.chat) ? flags.chat : [flags.chat]) : null;
  const result = await snapshot({
    reason: typeof flags.reason === 'string' ? flags.reason : 'manual',
    note: typeof flags.note === 'string' ? flags.note : '',
    chatKeys: chats,
    keep: num(flags.keep, undefined)
  });
  const m = result.manifest;
  console.log(`✅ 已保存快照 ${result.id}`);
  console.log(`   目录：${result.dir}`);
  console.log(`   文件 ${m.files.length} 个 · 总计 ${formatBytes(m.totalBytes)}`);
  const keys = Object.keys(m.memoryCounts ?? {});
  if (keys.length) {
    console.log('   记忆：');
    for (const key of keys) {
      const c = m.memoryCounts[key];
      console.log(`     ${key} → 群友 ${c.members} · 印象 ${c.impressions} 条`);
    }
  }
  if (m.skipped.length) console.log(`   ⚠️ 跳过：${m.skipped.slice(0, 3).join('；')}${m.skipped.length > 3 ? ' …' : ''}`);
  if (result.pruned?.removed?.length) console.log(`   🧹 轮转删除 ${result.pruned.removed.length} 份旧快照`);
}

function cmdList(flags) {
  const all = listSnapshots();
  if (flags.json) {
    console.log(JSON.stringify(all.map(({ dir, ...rest }) => rest), null, 2));
    return;
  }
  if (!all.length) {
    console.log('还没有任何快照。');
    console.log('打一份：node scripts/cold-storage.mjs snapshot --reason 手动');
    return;
  }
  console.log(`共 ${all.length} 份快照（新 → 旧）：`);
  for (const s of all) {
    const mem = Object.values(s.memoryCounts ?? {}).reduce(
      (acc, c) => ({ m: acc.m + (c.members || 0), i: acc.i + (c.impressions || 0) }),
      { m: 0, i: 0 }
    );
    console.log(`  ${s.id}`);
    console.log(`     ${isoLocal(s.createdAt)} · 原因 ${s.reason}${s.note ? ` · ${s.note}` : ''}`
      + ` · ${formatBytes(s.totalBytes)} · ${(s.files ?? []).length} 文件`
      + (mem.m ? ` · 群友${mem.m}/印象${mem.i}` : ''));
  }
}

function cmdSearch(positional, flags) {
  const result = searchArchives(positional, {
    limit: num(flags.limit, 100),
    perFile: num(flags['per-file'], 5),
    snapshotId: typeof flags.snapshot === 'string' ? flags.snapshot : null,
    regex: typeof flags.regex === 'string' ? flags.regex : null,
    context: num(flags.context, 60),
    onlyChat: typeof flags.chat === 'string' ? flags.chat : null
  });

  if (flags.json) {
    console.log(JSON.stringify({
      total: result.total,
      terms: result.terms,
      results: result.results.map((r) => ({
        id: r.snapshot.id,
        createdAt: r.snapshot.createdAt,
        reason: r.snapshot.reason,
        hits: r.hits
      }))
    }, null, 2));
    return;
  }
  if (!result.total) {
    console.log(`没有命中：${result.terms.join(' ')}`);
    console.log(`（检索范围：${COLD_DIR}）`);
    return;
  }
  console.log(`命中 ${result.total} 条，来自 ${result.results.length} 份快照：\n`);
  for (const { snapshot: snap, hits } of result.results) {
    console.log(`■ ${snap.id}  ${isoLocal(snap.createdAt)}  原因 ${snap.reason}`);
    for (const hit of hits) {
      console.log(`  · ${hit.label}`);
      console.log(`    ${hit.snippet}`);
    }
    console.log('');
  }
}

function cmdShow(target) {
  if (!target) throw new Error('要给一个快照 id（用 list 看有哪些）');
  const snap = listSnapshots().find((s) => s.id === target || s.id.startsWith(target));
  if (!snap) throw new Error(`找不到快照：${target}`);
  console.log(`快照 ${snap.id}`);
  console.log(`  时间：${isoLocal(snap.createdAt)}`);
  console.log(`  原因：${snap.reason}${snap.note ? `（${snap.note}）` : ''}`);
  console.log(`  会话：${(snap.chatKeys ?? []).join(', ') || '（无）'}`);
  console.log('  文件：');
  for (const f of snap.files ?? []) console.log(`    ${f.path}  ${formatBytes(f.bytes)}`);
  if (snap.skipped?.length) console.log(`  ⚠️ 跳过：${snap.skipped.join('；')}`);
}

function cmdRestore(target, flags) {
  const mode = flags.mode === 'state' ? 'state' : 'memory';
  const report = restoreSnapshot(target, { mode, force: flags.force === true });
  console.log(`✅ 已从快照 ${report.snapshot} 还原（模式 ${mode}）`);
  if (report.safety) console.log(`   还原前的现场已另存为 ${report.safety}（后悔药）`);
  if (mode === 'state') {
    console.log(`   覆盖文件：${report.written} 个`);
  } else {
    const keys = Object.keys(report.chats ?? {});
    if (!keys.length) console.log('   没有可并回的记忆（快照里没印象，或当前已经都有）。');
    for (const key of keys) {
      const c = report.chats[key];
      console.log(`   ${key} → 补回 群友 ${c.members} · 印象 ${c.impressions} 条`);
    }
  }
  console.log('\n提醒：记忆只在应用**启动/读取时**才进内存。若应用正在运行，请先退出再还原。');
}

function cmdPrune(flags) {
  const keep = num(flags.keep, 100);
  const dryRun = flags['dry-run'] === true;
  const result = pruneArchives({ keep, dryRun });
  if (!result.removed.length) {
    console.log(`共 ${result.kept} 份快照，未超过保留上限 ${keep}，无需清理。`);
    return;
  }
  console.log(`${dryRun ? '（演练）将' : '已'}删除 ${result.removed.length} 份旧快照，保留 ${result.kept} 份：`);
  for (const id of result.removed) console.log(`  - ${id}`);
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional.shift() ?? 'status';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return; }

  switch (cmd) {
    case 'status': cmdStatus(); break;
    case 'snapshot': await cmdSnapshot(flags); break;
    case 'list': cmdList(flags); break;
    case 'search': cmdSearch(positional, flags); break;
    case 'show': cmdShow(positional[0]); break;
    case 'restore': cmdRestore(positional[0] ?? 'latest', flags); break;
    case 'prune': cmdPrune(flags); break;
    default:
      console.error(`未知子命令：${cmd}\n`);
      console.log(USAGE);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`❌ ${error?.message ?? error}`);
  process.exitCode = 1;
});
