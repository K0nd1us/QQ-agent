// 长期冷储存：在「清空 / 删除 / 重置」把这些数据毁掉之前，先把快照与记忆落到本地；
// 事后可以按关键词检索，也可以把记忆还原回去。
//
// 为什么需要它
//   QQ Agent 的「上下文」是本地存档：messages/ 存消息、memory/ 存群友印象、sessions/ 存
//   每次会话的完整留档。控制台里几个看起来无害的按钮是**真删**：
//     · 「清空某会话」        POST /api/chats/:key/clear        → store.clearChat()
//     · 「删除选中的消息」     POST /api/chats/:key/delete-messages
//     · 「删除本会话记忆」     DELETE /api/memory-files/:key
//     · 「删除某个群友的记忆」 DELETE /api/memory-files/:key/members/:uid
//     · 「清理已结束会话」     POST /api/sessions/clear-finished
//     · 「重置数据目录」       POST /api/reset-data             → 整个 data/ 被删
//   删完之后没有任何地方能找回「上次它记得我什么、我们聊到哪了」。这个模块就是那道保险。
//
// 三件事：
//   1. captureBeforeReset()：上述路径在动手之前自动打一份快照（同步强刷 + 异步落盘，绝不阻塞）；
//   2. searchArchives()：跨所有历史快照做关键词检索（记忆、消息、会话留档）；
//   3. restoreSnapshot()：把 snapshot 里的记忆并回当前数据（或整套覆盖）。
//
// 存放位置
//   默认是**数据目录的隔壁**：<data>/../cold-storage。刻意不放进 data/ 里——
//   「重置数据目录」会把 data/ 整个删掉（它自己会留一份 .backup-时间戳，但那是一整坨、
//   不可检索的副本）；冷储存要能在这种情况下活下来，并且要能被独立检索。
//   需要换盘：设环境变量 QQ_AGENT_COLD_STORAGE_DIR。
//
// 安全口径
//   · 归档里绝不写 config.json 原文：只留脱敏副本（apiKey / key / token / secret → __REDACTED__）；
//   · 单文件超过 MAX_COPY_BYTES 跳过并在 manifest 里记一笔；
//   · 还原前自动打一份 pre-restore 快照，还原本身可回退。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOCK_FILE = path.join(DATA_DIR, 'qq-agent.lock');

// 冷储存跟着数据目录走，但它是**数据目录的兄弟**而不是子目录：
//   多实例用 QQ_AGENT_PROFILE=2 时数据目录是 data-2/，冷储存就跟着叫 cold-storage-2/，
//   这样两个实例的归档不会混在一起，而「重置数据目录」也删不到它。
const dataBaseName = path.basename(DATA_DIR);
const dataSuffix = dataBaseName.startsWith('data') ? dataBaseName.slice(4) : '';

export const COLD_DIR = process.env.QQ_AGENT_COLD_STORAGE_DIR
  ? path.resolve(process.env.QQ_AGENT_COLD_STORAGE_DIR)
  : path.join(path.dirname(DATA_DIR), `cold-storage${dataSuffix}`);

/** 单文件复制上限：会话留档可能很大，超过就跳过而不是把归档撑爆。 */
const MAX_COPY_BYTES = 16 * 1024 * 1024;
/** 一次快照最多带多少份会话留档（按修改时间取最新）。 */
const MAX_SESSIONS = 200;
/** 默认保留多少份快照。 */
export const DEFAULT_KEEP = 100;
/** 同一原因的自动快照在此窗口内只打一次（清空工作区会连续触发多个会话）。 */
const CAPTURE_COOLDOWN_MS = 4000;

const SECRET_KEY = /^(apiKey|key|token|secret|password|accessToken|clientSecret)$/i;

// ── 基础工具 ─────────────────────────────────────────────────────────────────

const pad = (n, w = 2) => String(n).padStart(w, '0');

function stampOf(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    + `-${pad(date.getMilliseconds(), 3)}`;
}

function slugOf(text) {
  return String(text ?? '').toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function readJsonSafe(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不影响结果 */ }
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** `group:123` → `group_123`，与 store.js / memory.js 的落盘命名保持一致。 */
export function safeChatKey(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 深拷贝并把密钥字段换成哨兵；归档用。 */
function redactSecrets(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const sensitive = SECRET_KEY.test(k) && v !== '' && v !== null && v !== undefined;
    out[k] = sensitive ? '__REDACTED__' : redactSecrets(v, depth + 1);
  }
  return out;
}

/** 进程是否还活着（signal 0 不杀进程，只探测）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 当前是否有 QQ Agent 核心在跑（数据目录里的单实例锁）。 */
export function activeInstancePid() {
  let pid;
  try { pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()); } catch { return null; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return pidAlive(pid) ? pid : null;
}

// ── 记忆摘要 ─────────────────────────────────────────────────────────────────

/**
 * 把 memory/ 的目录树提炼成一份「人读得懂、检索命得中」的记忆摘要。
 *
 * 落盘结构（见 memory.js）：
 *   memory/group_<群号>/<QQ号>.json = { userId, name, impressions: [{ content, createdAt }], updatedAt }
 *   memory/group_<群号>/_meta.json  = 会话级元信息
 */
function buildMemoryDigest() {
  const out = { generatedAt: new Date().toISOString(), chats: {} };
  let chatDirs = [];
  try {
    chatDirs = fs.readdirSync(MEMORY_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const dir of chatDirs) {
    const chatKey = dir.name.replace(/_(\d+)$/, ':$1'); // group_123 → group:123
    const full = path.join(MEMORY_DIR, dir.name);
    const members = {};
    let meta = null;
    let files = [];
    try {
      files = fs.readdirSync(full).filter((f) => f.endsWith('.json'));
    } catch { /* 单个会话读不到就跳过 */ }
    for (const file of files) {
      const data = readJsonSafe(path.join(full, file), null);
      if (!data) continue;
      if (file === '_meta.json') { meta = data; continue; }
      const impressions = Array.isArray(data.impressions)
        ? data.impressions.map((e) => (typeof e === 'string' ? e : String(e?.content ?? ''))).filter(Boolean)
        : [];
      members[String(data.userId ?? file.replace(/\.json$/, ''))] = {
        name: String(data.name ?? ''),
        impressions,
        updatedAt: Number(data.updatedAt) || 0
      };
    }
    out.chats[chatKey] = { meta, members };
  }
  return out;
}

// ── 快照 ─────────────────────────────────────────────────────────────────────

function copyInto(srcFile, destFile, { transform = null } = {}) {
  const stat = fs.statSync(srcFile);
  if (stat.size > MAX_COPY_BYTES) return { skipped: `${path.basename(srcFile)} 超过单文件上限（${formatBytes(stat.size)}）` };
  let buf = fs.readFileSync(srcFile);
  if (transform) buf = transform(buf);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, buf);
  return { bytes: buf.length, sha256: sha256(buf) };
}

/**
 * 打一份快照。
 *
 * @param {object} opts
 * @param {string} opts.reason      触发原因，进目录名与 manifest
 * @param {string[]} [opts.chatKeys] 只归档这些会话（不传 = 全量）
 * @param {string} [opts.note]      备注
 * @param {number} [opts.keep]      保留份数
 */
export async function snapshot(opts = {}) {
  const { reason = 'manual', chatKeys = null, note = '', keep = DEFAULT_KEEP } = opts;
  const createdAt = new Date();
  const id = `${stampOf(createdAt)}_${slugOf(reason) || 'snapshot'}`;
  const dir = path.join(COLD_DIR, id);
  const rel = (abs) => path.relative(dir, abs).replace(/\\/g, '/');

  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const skipped = [];

  // 归档范围：给了 chatKeys 就只抄这些会话，否则全量。
  const wanted = Array.isArray(chatKeys) && chatKeys.length ? [...new Set(chatKeys)] : null;

  // 1) 消息存档
  let messageFiles = [];
  try { messageFiles = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json')); } catch { /* 还没有任何会话 */ }
  for (const name of messageFiles) {
    if (wanted) {
      const base = name.replace(/\.json$/, '');
      if (!wanted.some((k) => safeChatKey(k) === base)) continue;
    }
    const src = path.join(MESSAGES_DIR, name);
    const dest = path.join(dir, 'messages', name);
    try {
      const info = copyInto(src, dest);
      if (info.skipped) { skipped.push(info.skipped); continue; }
      files.push({ path: rel(dest), bytes: info.bytes, sha256: info.sha256 });
    } catch (error) {
      skipped.push(`${name}：${error?.message ?? error}`);
    }
  }

  // 2) 记忆目录
  let memDirs = [];
  try { memDirs = fs.readdirSync(MEMORY_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* 无记忆 */ }
  for (const entry of memDirs) {
    if (wanted && !wanted.some((k) => safeChatKey(k) === entry.name)) continue;
    const srcDir = path.join(MEMORY_DIR, entry.name);
    let names = [];
    try { names = fs.readdirSync(srcDir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      const src = path.join(srcDir, name);
      const dest = path.join(dir, 'memory', entry.name, name);
      try {
        const info = copyInto(src, dest);
        if (info.skipped) { skipped.push(info.skipped); continue; }
        files.push({ path: rel(dest), bytes: info.bytes, sha256: info.sha256 });
      } catch (error) {
        skipped.push(`memory/${entry.name}/${name}：${error?.message ?? error}`);
      }
    }
  }

  // 3) 会话留档：这是「对话全文」，按修改时间取最新 MAX_SESSIONS 份
  if (!wanted) {
    let sessionFiles = [];
    try {
      sessionFiles = fs.readdirSync(SESSIONS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const full = path.join(SESSIONS_DIR, f);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch { /* 忽略 */ }
          return { f, full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, MAX_SESSIONS);
    } catch { /* 没有会话留档 */ }
    for (const item of sessionFiles) {
      const dest = path.join(dir, 'sessions', item.f);
      try {
        const info = copyInto(item.full, dest);
        if (info.skipped) { skipped.push(info.skipped); continue; }
        files.push({ path: rel(dest), bytes: info.bytes, sha256: info.sha256 });
      } catch (error) {
        skipped.push(`sessions/${item.f}：${error?.message ?? error}`);
      }
    }
  }

  // 4) 配置：只留脱敏副本（永不还原）
  const cfg = readJsonSafe(CONFIG_FILE, null);
  if (cfg) {
    const buf = Buffer.from(`${JSON.stringify(redactSecrets(cfg), null, 2)}\n`, 'utf8');
    const dest = path.join(dir, 'config.redacted.json');
    fs.writeFileSync(dest, buf);
    files.push({ path: rel(dest), bytes: buf.length, redacted: true });
  }

  // 5) 记忆摘要（人读 + 检索都靠它）
  const memory = buildMemoryDigest();
  if (wanted) {
    for (const key of Object.keys(memory.chats)) {
      if (!wanted.includes(key)) delete memory.chats[key];
    }
  }
  const memBuf = Buffer.from(`${JSON.stringify(memory, null, 2)}\n`, 'utf8');
  atomicWrite(path.join(dir, 'memory.json'), memBuf);
  files.push({ path: 'memory.json', bytes: memBuf.length });

  const manifest = {
    id,
    createdAt: createdAt.toISOString(),
    reason,
    note,
    chatKeys: wanted ?? Object.keys(memory.chats),
    memoryCounts: Object.fromEntries(Object.entries(memory.chats).map(([key, chat]) => [key, {
      members: Object.keys(chat.members).length,
      impressions: Object.values(chat.members).reduce((sum, m) => sum + m.impressions.length, 0)
    }])),
    files,
    skipped,
    totalBytes: files.reduce((sum, f) => sum + (Number(f.bytes) || 0), 0)
  };
  atomicWrite(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const pruned = pruneArchives({ keep });
  return { id, dir, manifest, pruned };
}

let lastCaptureAt = 0;
let lastCaptureReason = '';

/**
 * 重置前的自动快照入口：**绝不抛错、绝不阻塞调用方**。
 *
 * 同一原因在 CAPTURE_COOLDOWN_MS 内只打一次：一次批量清理会连续触发多个会话的删除，
 * 每个都打一份只会把归档刷成一堆几乎相同的副本。
 */
export function captureBeforeReset(reason, { chatKeys = null, note = '' } = {}) {
  const now = Date.now();
  if (now - lastCaptureAt < CAPTURE_COOLDOWN_MS && lastCaptureReason === reason) return null;
  lastCaptureAt = now;
  lastCaptureReason = reason;
  try {
    const pending = snapshot({ reason, chatKeys, note });
    Promise.resolve(pending).catch(() => { /* 归档失败不影响重置本身 */ });
    return pending;
  } catch {
    return null;
  }
}

// ── 列举 ─────────────────────────────────────────────────────────────────────

export function listSnapshots() {
  let entries = [];
  try { entries = fs.readdirSync(COLD_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(COLD_DIR, entry.name);
    const manifest = readJsonSafe(path.join(dir, 'manifest.json'), null);
    if (!manifest) continue;
    out.push({ ...manifest, dir });
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

// ── 检索 ─────────────────────────────────────────────────────────────────────

/** 把 JSON 摊平成「label → 文本」，让结果能指出命中的是哪一条记忆。 */
function* flattenJson(value, label = '', depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) yield { label, text };
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    yield { label, text: String(value) };
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* flattenJson(value[i], `${label}[${i}]`, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'sha256') continue;
      yield* flattenJson(v, label ? `${label}.${k}` : k, depth + 1);
    }
  }
}

function walkFiles(dir, acc = [], depth = 0) {
  if (depth > 4) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc, depth + 1);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

/**
 * 某份会话留档属于哪个会话：sessions 的 JSON 里带 chatKey。
 * 读不出来就当「不属于任何会话」（限定检索时会被排除）。
 */
function sessionChatKey(file) {
  const data = readJsonSafe(file, null);
  return data?.chatKey ? String(data.chatKey) : null;
}

/**
 * 遍历一份快照里的可检索单元。
 *
 * @param {string} dir 快照目录
 * @param {string|null} onlyChat 限定会话（QQ Agent 的检索只给「这个会话自己的历史」）
 */
function* iterUnits(dir, onlyChat = null) {
  let files = [];
  try { files = walkFiles(dir); } catch { return; }

  for (const abs of files) {
    const rel = path.relative(dir, abs).replace(/\\/g, '/');
    if (rel === 'manifest.json') continue;

    if (onlyChat) {
      const safe = safeChatKey(onlyChat);
      const inMessages = rel === `messages/${safe}.json`;
      const inMemory = rel.startsWith(`memory/${safe}/`);
      let inSessions = false;
      if (rel.startsWith('sessions/')) {
        // 会话留档是跨会话混放的：必须读出来按 chatKey 过滤，不能整目录放行。
        inSessions = sessionChatKey(abs) === onlyChat;
      }
      if (!inMessages && !inMemory && !inSessions) continue;
    }

    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }

    if (abs.endsWith('.json')) {
      const parsed = (() => { try { return JSON.parse(text); } catch { return null; } })();
      if (parsed) {
        // 消息存档逐条展开：label 指向具体那条消息，片段更短更好读。
        if (Array.isArray(parsed.messages)) {
          for (let i = 0; i < parsed.messages.length; i++) {
            const m = parsed.messages[i];
            const body = [m?.sender, m?.text].filter(Boolean).join('：');
            if (body) yield { file: rel, label: `${rel} #${i + 1}`, text: body };
          }
          continue;
        }
        for (const unit of flattenJson(parsed, '')) {
          yield { file: rel, label: unit.label || rel, text: unit.text };
        }
        continue;
      }
    }

    for (const [i, line] of text.split(/\r?\n/).entries()) {
      if (line.trim()) yield { file: rel, label: `${rel}:${i + 1}`, text: line };
    }
  }
}

function snippetOf(text, index, radius = 60) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

/**
 * 在历史快照里按关键词检索。
 *
 * 默认「所有关键词都要出现」（AND），大小写不敏感；传 regex 则按正则。
 * onlyChat 限定在单个会话自己的消息/记忆/留档里（其它会话的内容一律不出）。
 */
export function searchArchives(queries, opts = {}) {
  const { limit = 100, perFile = 5, snapshotId = null, regex = null, context = 60, onlyChat = null } = opts;
  const terms = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q ?? '').trim()).filter(Boolean);
  if (!terms.length && !regex) throw new Error('至少给一个关键词');

  const pattern = regex ? new RegExp(regex, 'i') : null;
  const lowered = pattern ? null : terms.map((t) => t.toLowerCase());

  const list = snapshotId
    ? listSnapshots().filter((s) => s.id === snapshotId || s.id.startsWith(snapshotId))
    : listSnapshots();

  const results = [];
  let total = 0;

  for (const snap of list) {
    const hits = [];
    const perFileCount = new Map();
    for (const unit of iterUnits(snap.dir, onlyChat)) {
      const text = unit.text;
      if (!text) continue;

      let index = -1;
      if (pattern) {
        const m = pattern.exec(text);
        if (m) index = m.index;
      } else {
        const low = text.toLowerCase();
        if (lowered.every((t) => low.includes(t))) index = low.indexOf(lowered[0]);
      }
      if (index < 0) continue;

      const seen = perFileCount.get(unit.file) ?? 0;
      if (seen >= perFile) continue;
      perFileCount.set(unit.file, seen + 1);

      hits.push({ file: unit.file, label: unit.label, snippet: snippetOf(text, index, context) });
      total += 1;
      if (total >= limit) break;
    }
    if (hits.length) results.push({ snapshot: snap, hits });
    if (total >= limit) break;
  }

  return { total, results, terms };
}

// ── 还原 ─────────────────────────────────────────────────────────────────────

function keyOfImpression(item) {
  if (item && typeof item === 'object') return String(item.content ?? item.text ?? JSON.stringify(item));
  return String(item);
}

/**
 * 把快照里的记忆并回 memory/ 目录：只补缺的（按内容去重），已有的不覆盖。
 *
 * 结构对齐 memory.js：memory/<safeChat>/<QQ>.json = { userId, name, impressions, updatedAt }。
 * 只在目标文件缺失该条印象时写入，所以重复执行是幂等的。
 */
function mergeMemoryFiles(snapDir) {
  const report = {};
  const srcRoot = path.join(snapDir, 'memory');
  let chatDirs = [];
  try { chatDirs = fs.readdirSync(srcRoot, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return report; }

  for (const entry of chatDirs) {
    const srcDir = path.join(srcRoot, entry.name);
    const destDir = path.join(MEMORY_DIR, entry.name);
    let files = [];
    try { files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.json')); } catch { continue; }
    let addedImpressions = 0;
    let touchedMembers = 0;

    for (const file of files) {
      if (file === '_meta.json') continue; // 会话级元信息不还原（避免把旧水位带回来）
      const src = readJsonSafe(path.join(srcDir, file), null);
      if (!src) continue;
      const destFile = path.join(destDir, file);
      const dest = readJsonSafe(destFile, null) ?? {
        userId: String(src.userId ?? file.replace(/\.json$/, '')),
        name: String(src.name ?? ''),
        impressions: [],
        updatedAt: 0
      };
      const existing = new Set((Array.isArray(dest.impressions) ? dest.impressions : []).map(keyOfImpression));
      let changed = false;
      for (const imp of Array.isArray(src.impressions) ? src.impressions : []) {
        const k = keyOfImpression(imp);
        if (!k || existing.has(k)) continue;
        existing.add(k);
        dest.impressions.push(imp);
        addedImpressions += 1;
        changed = true;
      }
      if (!changed) continue;
      dest.name = dest.name || String(src.name ?? '');
      dest.updatedAt = Date.now();
      atomicWrite(destFile, `${JSON.stringify(dest, null, 2)}\n`);
      touchedMembers += 1;
    }

    if (addedImpressions) {
      const chatKey = entry.name.replace(/_(\d+)$/, ':$1');
      report[chatKey] = { members: touchedMembers, impressions: addedImpressions };
    }
  }
  return report;
}

/**
 * 从历史快照还原。
 *
 * mode:
 *   'memory'（默认）— 只把群友印象并回 memory/，不动消息存档与会话留档；
 *   'state'        — 把 messages/ + memory/ + sessions/ 整套覆盖回去。
 *
 * 还原本身是破坏性操作：先给当前状态打一份 pre-restore 快照（后悔药）。
 */
export function restoreSnapshot(target, { mode = 'memory', force = false } = {}) {
  if (!force) {
    const pid = activeInstancePid();
    if (pid !== null) {
      throw new Error(
        `QQ Agent 正在运行（数据目录的 qq-agent.lock 指向 PID ${pid}）。`
        + '它的内存态会覆盖磁盘，运行中还原等于白做。请先退出应用（或 npm run server）再还原，'
        + '或加 --force 明确接受被覆盖的风险。'
      );
    }
  }

  const all = listSnapshots();
  if (!all.length) throw new Error(`冷储存目录里还没有任何快照：${COLD_DIR}`);
  // latest 跳过还原前自动生成的 pre-restore 快照，避免「还原上一次还原」
  const usable = all.filter((s) => s.reason !== 'pre-restore');
  const snap = (!target || target === 'latest')
    ? (usable[0] ?? all[0])
    : all.find((s) => s.id === target || s.id.startsWith(target));
  if (!snap) throw new Error(`找不到快照：${target}（用 list 看看有哪些）`);

  let safety = null;
  try { safety = snapshot({ reason: 'pre-restore', note: `还原 ${snap.id} 之前` }); } catch { /* 后悔药失败不阻断 */ }

  const report = { snapshot: snap.id, mode, written: 0, chats: {}, safety: safety?.id ?? null, skipped: [] };

  if (mode === 'state') {
    for (const sub of ['messages', 'memory', 'sessions']) {
      const srcRoot = path.join(snap.dir, sub);
      let names = [];
      try { names = fs.readdirSync(srcRoot, { withFileTypes: true }); } catch { continue; }
      const destRoot = sub === 'messages' ? MESSAGES_DIR : sub === 'memory' ? MEMORY_DIR : SESSIONS_DIR;
      for (const entry of names) {
        if (entry.isDirectory()) {
          const src = path.join(srcRoot, entry.name);
          for (const f of fs.readdirSync(src)) {
            const buf = fs.readFileSync(path.join(src, f));
            atomicWrite(path.join(destRoot, entry.name, f), buf);
            report.written += 1;
          }
        } else if (entry.isFile()) {
          const buf = fs.readFileSync(path.join(srcRoot, entry.name));
          atomicWrite(path.join(destRoot, entry.name), buf);
          report.written += 1;
        }
      }
    }
    return report;
  }

  const merged = mergeMemoryFiles(snap.dir);
  report.chats = merged;
  report.written = Object.keys(merged).length;
  return report;
}

// ── 轮转 ─────────────────────────────────────────────────────────────────────

export function pruneArchives({ keep = DEFAULT_KEEP, dryRun = false } = {}) {
  const all = listSnapshots();
  if (all.length <= keep) return { removed: [], kept: all.length };
  const removed = [];
  for (const snap of all.slice(keep)) {
    if (!dryRun) {
      try { fs.rmSync(snap.dir, { recursive: true, force: true }); } catch { continue; }
    }
    removed.push(snap.id);
  }
  return { removed, kept: Math.min(keep, all.length) };
}

// ── 概览 ─────────────────────────────────────────────────────────────────────

export function archiveStatus() {
  const all = listSnapshots();
  const totalBytes = all.reduce((sum, s) => sum + (Number(s.totalBytes) || 0), 0);
  const pid = activeInstancePid();
  return {
    root: COLD_DIR,
    dataDir: DATA_DIR,
    exists: fs.existsSync(COLD_DIR),
    count: all.length,
    totalBytes,
    totalText: formatBytes(totalBytes),
    newest: all[0] ?? null,
    oldest: all.length ? all[all.length - 1] : null,
    running: pid !== null,
    pid
  };
}
