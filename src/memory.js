// 群友印象按 QQ 号全局存储：data/memory/members/<QQ>.json。
// 会话目录只保留 _members.json 关联、_meta.json 和无法确认 QQ 号的旧条目。
// 旧的按群/私聊存储在首次读取时合并、备份迁移；不会按同名猜测身份。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function legacyFile(chatKey) {
  return path.join(MEMORY_DIR, `${chatDirName(chatKey)}.json`);
}

function chatDir(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey));
}

function metaFile(chatKey) {
  return path.join(chatDir(chatKey), '_meta.json');
}

function memberFileName(userId, name = '') {
  if (String(userId ?? '').trim()) {
    const id = String(userId).trim();
    return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  }
  const safe = String(name || 'unknown').trim().replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
}

function memberFile(chatKey, userId, name = '') {
  return path.join(/^\d{1,15}$/.test(String(userId || '')) ? path.join(MEMORY_DIR, 'members') : chatDir(chatKey), memberFileName(userId, name));
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

// Keep original migration sources before any canonical/index changes. Never replace a backup.
function backupSource(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  let target = destination, suffix = 0;
  while (fs.existsSync(target)) {
    if (fs.readFileSync(target).equals(fs.readFileSync(source))) return;
    target = `${destination}.${++suffix}`;
  }
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

function loadMember(chatKey, userId, name = '') {
  const file = memberFile(chatKey, userId, name);
  const raw = readJson(file, null);
  if (fs.existsSync(file) && (!raw || !Array.isArray(raw.impressions) || raw.impressions.some(e => !e || typeof e.content !== 'string') ||
    (/^\d{1,15}$/.test(String(userId || '')) && String(raw.userId) !== String(userId)))) {
    throw new Error(`印象文件损坏或 QQ 号不一致：${file}`);
  }
  return {
    userId: String(raw?.userId ?? userId ?? ''),
    name: String(raw?.name ?? name ?? ''),
    impressions: Array.isArray(raw?.impressions) ? raw.impressions : [],
    updatedAt: Number(raw?.updatedAt) || 0,
    lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0,
    processedMessages: raw?.processedMessages && typeof raw.processedMessages === 'object' ? raw.processedMessages : {},
    revision: Number(raw?.revision) || 0
  };
}

function loadMeta(chatKey) {
  const raw = readJson(metaFile(chatKey), null);
  return { lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0 };
}

export class MemoryStore {
  constructor() {
    this.cache = new Map(); // chatKey -> association view; profiles are always read by QQ id
    this.migrated = false;
    this.migratingLegacy = new Set();
  }

  /** 扫描所有有记忆的会话（文件夹或旧版单文件）。 */
  listChats() {
    const out = new Set();
    try {
      for (const f of fs.readdirSync(MEMORY_DIR)) {
        if (fs.statSync(path.join(MEMORY_DIR, f)).isDirectory()) {
          const m = /^(group|private)_(\d+)$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        } else {
          const m = /^(group|private)_(\d+)\.json$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        }
      }
    } catch { /* 目录不存在 */ }
    return [...out];
  }

  /** 旧版单文件 → 新版每成员文件。迁移后旧文件移到 backups/。 */
  #migrateLegacy(chatKey) {
    const legacy = legacyFile(chatKey);
    if (!fs.existsSync(legacy)) return;
    try {
      if (fs.statSync(legacy).isDirectory()) return;
      const old = readJson(legacy, null);
      if (!old) throw new Error('旧记忆文件无法解析，保留原文件');
      const migrated = [];
      for (const e of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
        if (!e?.content) continue;
        const target = String(e.target || '').trim();
        const userId = /^\d{1,15}$/.test(String(e.userId || '')) ? String(e.userId)
          : (/^\d{5,15}$/.test(target) ? target : '');
        migrated.push({
          userId,
          name: target,
          content: String(e.content).slice(0, 300),
          createdAt: Number(e.createdAt) || Date.now()
        });
      }
      const backup = path.join(MEMORY_DIR, 'backups', path.basename(legacy));
      backupSource(legacy, backup);
      for (const m of migrated) this.#appendRaw(chatKey, m.userId, m.name, m.content, m.createdAt);
      fs.rmSync(legacy);

    } catch (error) {
      console.error('[memory] 旧记忆迁移失败:', error?.message ?? error);
      throw error;
    }
  }

  /** Migrate all chat folders before serving any global profile. Old files are kept in backups. */
  #migrateGlobal() {
    if (this.migrated) return;
    // Only mark complete after all writes succeed, so a partial migration can be retried.
    for (const chatKey of this.listChats()) {
      const dir = chatDir(chatKey);
      const indexFile = path.join(dir, '_members.json');
      const ids = new Set(readJson(indexFile, {}).userIds || []);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { /* legacy single-file chat */ }
      for (const f of files) {
        if (!/^\d{1,15}\.json$/.test(f)) continue;
        const source = path.join(dir, f);
        const raw = readJson(source, null);
        if (!raw || !Array.isArray(raw.impressions) || raw.impressions.some(e => !e || typeof e.content !== 'string')) {
          throw new Error(`无法读取旧印象文件：${source}`);
        }
        const uid = f.slice(0, -5);
        if (raw.userId && String(raw.userId) !== uid) throw new Error(`旧印象 QQ 号与文件名不一致：${source}`);
        const backup = path.join(MEMORY_DIR, 'backups', 'migration-v2', chatDirName(chatKey), f);
        backupSource(source, backup);
        const old = loadMember(chatKey, uid);
            for (const e of raw.impressions || []) {
          if (!e?.content) continue;
          const prior = old.impressions.find(item => item.content === e.content);
          const sourceChatKeys = [...new Set([...(prior?.sourceChatKeys || []), chatKey])];
          if (prior) prior.sourceChatKeys = sourceChatKeys;
          else old.impressions.push({ content: String(e.content), createdAt: Number(e.createdAt) || 0, sourceChatKeys });
        }
        if (Number(raw.updatedAt) >= old.updatedAt && raw.name) old.name = String(raw.name);
        old.updatedAt = Math.max(old.updatedAt, Number(raw.updatedAt) || 0);
        old.lastConsolidatedAt = Math.max(old.lastConsolidatedAt, Number(raw.lastConsolidatedAt) || 0);
        old.revision += 1;
        writeJson(memberFile(chatKey, uid), old);
        ids.add(uid);
        writeJson(indexFile, { userIds: [...ids] });
        fs.rmSync(source);
      }
    }
    this.migrated = true;
    // Import legacy single-file chats too, before any QQ lookup in another chat.
    try { for (const chatKey of this.listChats()) this.#ensureChat(chatKey); }
    catch (error) { this.migrated = false; throw error; }
  }

  #saveIndex(chatKey, map) {
    writeJson(path.join(chatDir(chatKey), '_members.json'), {
      userIds: [...map.keys()].filter(uid => /^\d{1,15}$/.test(uid))
    });
  }

  #ensureChat(chatKey) {
    this.#migrateGlobal();
    if (!this.cache.has(chatKey)) {
      const map = new Map();
      for (const uid of readJson(path.join(chatDir(chatKey), '_members.json'), {}).userIds || []) {
        if (/^\d{1,15}$/.test(String(uid))) map.set(String(uid), loadMember(chatKey, String(uid)));
      }
      try {
        for (const f of fs.readdirSync(chatDir(chatKey))) {
          if (!f.endsWith('.json') || f.startsWith('_meta') || f === '_members.json') continue;
          const raw = readJson(path.join(chatDir(chatKey), f), null);
          if (!raw || raw.userId) continue;
          map.set(`_n_${f}`, loadMember(chatKey, '', raw.name));
        }
      } catch { /* new chat */ }
      this.cache.set(chatKey, map);
    }
    // Put the cache in place before legacy migration, which appends through this same API.
    if (!this.migratingLegacy.has(chatKey)) {
      this.migratingLegacy.add(chatKey);
      try { this.#migrateLegacy(chatKey); } finally { this.migratingLegacy.delete(chatKey); }
    }
    const map = this.cache.get(chatKey);
    // No stale per-chat copies after another chat edits/deletes the shared profile.
    for (const uid of map.keys()) {
      if (/^\d{1,15}$/.test(uid)) map.set(uid, loadMember(chatKey, uid));
    }
    return map;
  }

  /** Bind a confirmed QQ identity to this chat; no name-based matching. */
  associateMember(chatKey, userId) {
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) return;
    const map = this.#ensureChat(chatKey);
    if (!map.has(uid)) {
      map.set(uid, loadMember(chatKey, uid));
      this.#saveIndex(chatKey, map);
    }
  }

  #appendRaw(chatKey, userId, name, content, createdAt = Date.now()) {
    const map = this.#ensureChat(chatKey);
    const key = userId ? String(userId) : `_n_${memberFileName('', name)}`;
    const member = map.get(key) || loadMember(chatKey, userId, name);
    const entry = {
      content: String(content ?? '').slice(0, 300),
      createdAt: Number(createdAt) || Date.now(),
      sourceChatKeys: [chatKey]
    };
    const previous = member.impressions.find(e => e.content === entry.content);
    if (!previous) member.impressions.push(entry);
    else previous.sourceChatKeys = [...new Set([...(previous.sourceChatKeys || []), chatKey])];
    member.userId = String(userId ?? member.userId ?? '');
    member.name = String(name || member.name || '');
    member.updatedAt = Date.now();
    member.revision = (member.revision || 0) + 1;
    writeJson(memberFile(chatKey, userId, name), member);
    map.set(key, member);
    this.#saveIndex(chatKey, map);
    return entry;
  }

  /** 记一条对群友的印象。extra: { userId, target } */
  append(chatKey, category, content, extra = {}) {
    if (category !== 'memberImpression') return null;
    const userId = String(extra.userId ?? '').trim();
    const target = String(extra.target ?? '').trim().slice(0, 60);
    if (userId && !/^\d{1,15}$/.test(userId)) return null;
    if (!userId && !target) return null;
    return this.#appendRaw(chatKey, userId, target || userId, content);
  }

  /** 所有成员的印象（扁平列表，兼容旧消费方）。 */
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const map = this.#ensureChat(chatKey);
    const memberImpression = [];
    for (const m of map.values()) {
      for (const e of m.impressions) {
        memberImpression.push({
          userId: String(m.userId || ''),
          target: String(m.name || m.userId || '某人'),
          content: e.content,
          createdAt: e.createdAt,
          sourceChatKeys: e.sourceChatKeys || []
        });
      }
    }
    memberImpression.sort((a, b) => b.createdAt - a.createdAt);
    return { memberImpression };
  }

  /** 成员级视图（记忆页签用）。 */
  members(chatKey) {
    const map = this.#ensureChat(chatKey);
    const list = [];
    for (const m of map.values()) {
      if (!m.impressions.length) continue;
      list.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || '某人'),
        impressions: m.impressions.map((e) => ({ ...e })),
        updatedAt: m.updatedAt,
        lastConsolidatedAt: m.lastConsolidatedAt,
        processedMessages: structuredClone(m.processedMessages || {}),
        revision: m.revision || 0
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  /** 单个成员的印象（含空成员）。 */
  getMember(chatKey, userId) {
    this.#ensureChat(chatKey);
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    return structuredClone(loadMember(chatKey, uid));
  }

  /** Advance only the messages actually read by a successful model response. */
  markMemberProcessed(chatKey, userId, cursor, at = Date.now()) {
    const m = this.getMember(chatKey, userId);
    m.lastConsolidatedAt = at;
    m.processedMessages[chatKey] = { id: Number(cursor?.id) || 0, ts: Number(cursor?.ts) || 0 };
    writeJson(memberFile(chatKey, userId), m);
    this.associateMember(chatKey, userId);
  }

  /** 编辑群友印象（管理端）：QQ 号由调用方提供，自动回填名字，保存备注到配置。 */
  editMemberImpression(chatKey, { userId, name = '', note = '', impressions = [] }) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(impressions) ? impressions : [impressions];
    const now = Date.now();
    const entries = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => {
        const text = content.slice(0, 300);
        const sources = old.impressions.find(e => e.content === text)?.sourceChatKeys;
        return { content: text, createdAt: now, ...(sources ? { sourceChatKeys: [...sources] } : {}) };
      });
    const member = {
      userId: uid,
      name: finalName,
      impressions: entries,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0,
      processedMessages: old.processedMessages || {},
      revision: (old.revision || 0) + 1
    };
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    this.#saveIndex(chatKey, map);
    // 备注写入配置 memberNotes
    if (note !== undefined && note !== null) {
      const notes = { ...(getConfig().memberNotes || {}) };
      const n = String(note ?? '').trim();
      if (n) notes[uid] = n;
      else delete notes[uid];
      updateConfig({ memberNotes: notes });
    }
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt,
      note: String(note ?? '').trim()
    };
  }

  /** 手动替换某成员的全部印象（管理端编辑用）。返回更新后的成员。 */
  replaceMember(chatKey, userId, name, contents, state = {}) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(contents) ? contents : [contents];
    const now = Date.now();
    const impressions = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => {
        const text = content.slice(0, 300);
        const sources = old.impressions.find(e => e.content === text)?.sourceChatKeys;
        return { content: text, createdAt: now, ...(sources ? { sourceChatKeys: [...sources] } : {}) };
      });
    const member = {
      userId: uid,
      name: finalName,
      impressions,
      updatedAt: now,
      lastConsolidatedAt: state.lastConsolidatedAt ?? old.lastConsolidatedAt ?? 0,
      processedMessages: state.processedMessages ?? old.processedMessages ?? {},
      revision: (old.revision || 0) + 1
    };
    // 修改全局印象前备份（按发起会话归档，保留最近一次）。
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.mkdirSync(backupDir, { recursive: true });
      const src = memberFile(chatKey, uid, finalName);
      if (fs.existsSync(src)) {
        const dst = path.join(backupDir, path.basename(src));
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.copyFileSync(src, dst);
      }
    } catch { /* 备份失败不阻塞 */ }
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    this.#saveIndex(chatKey, map);
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt
    };
  }

  /** Clear shared impressions but retain processed-message cursors, avoiding replay after deletion. */
  removeMember(chatKey, userId) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) return false;
    const m = this.getMember(chatKey, uid);
    this.replaceMember(chatKey, uid, m.name, []);
    return true;
  }

  /** Remove this chat's association view; shared QQ profiles survive. */
  removeChat(chatKey) {
    this.#ensureChat(chatKey);
    const dir = chatDir(chatKey);
    let removed = false;
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed = true;
    }
    this.cache.delete(chatKey);
    return removed;
  }

  remove(chatKey, category, { userId = '', target = '', content = '' } = {}) {
    if (category !== 'memberImpression') return false;
    if (userId) this.associateMember(chatKey, userId);
    const map = this.#ensureChat(chatKey);
    let removed = false;
    for (const [key, m] of [...map.entries()]) {
      if (userId) {
        if (String(m.userId) === String(userId)) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            if (m.userId) {
              m.updatedAt = Date.now();
              m.revision = (m.revision || 0) + 1;
              writeJson(memberFile(chatKey, m.userId, m.name), m);
            } else {
              map.delete(key);
              fs.rmSync(memberFile(chatKey, '', m.name), { force: true });
            }
          } else {
            m.updatedAt = Date.now();
            m.revision = (m.revision || 0) + 1;
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      } else if (target) {
        const matchName = String(target).trim();
        if (!m.userId && String(m.name) === matchName) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            if (m.userId) {
              m.updatedAt = Date.now();
              m.revision = (m.revision || 0) + 1;
              writeJson(memberFile(chatKey, m.userId, m.name), m);
            } else {
              map.delete(key);
              fs.rmSync(memberFile(chatKey, '', m.name), { force: true });
            }
          } else {
            m.updatedAt = Date.now();
            m.revision = (m.revision || 0) + 1;
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      }
    }
    return removed;
  }

  clear(chatKey) {
    return this.removeChat(chatKey);
  }

  /**
   * 生成提示词里的【对群友的印象】摘要。
   * opts.userIds 提供时只包含这些成员（相关成员注入，控制 token）。
   */
  formatForPrompt(chatKey, { userIds = null } = {}) {
    const notes = getConfig().memberNotes || {};
    const all = this.members(chatKey);
    const seen = new Set(all.map(m => m.userId));
    for (const uid of userIds || []) {
      const id = String(uid);
      if (!/^\d{1,15}$/.test(id) || seen.has(id)) continue;
      const member = this.getMember(chatKey, id);
      if (member.impressions.length) all.push(member);
    }
    if (!all.length) return '';
    const filter = userIds ? new Set([...userIds].map(String)) : null;
    const picked = filter
      ? all.filter((m) => filter.has(String(m.userId)))
      : all.slice(0, 15);
    if (!picked.length) return '';
    const lines = ['【对群友的印象】'];
    for (const m of picked) {
      const who = notes[String(m.userId)] || m.name || String(m.userId || '') || '某人';
      for (const e of m.impressions.slice(-3)) {
        const scope = e.sourceChatKeys?.length ? `〔来源：${e.sourceChatKeys.join('、')}；群内关系仅适用于对应会话〕` : '';
        lines.push(`- ${who}：${scope}${e.content}`);
      }
    }
    return lines.join('\n');
  }

  // ── 自动整理（consolidation）──

  consolidationState(chatKey) {
    const map = this.#ensureChat(chatKey);
    let total = 0;
    let lastConsolidatedAt = 0;
    const members = [];
    for (const m of map.values()) {
      total += m.impressions.length;
      lastConsolidatedAt = Math.max(lastConsolidatedAt, m.lastConsolidatedAt || 0);
      members.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || ''),
        count: m.impressions.length,
        lastConsolidatedAt: m.lastConsolidatedAt || 0
      });
    }
    return {
      lastConsolidatedAt: loadMeta(chatKey).lastConsolidatedAt || lastConsolidatedAt,
      counts: { memberImpression: total },
      members
    };
  }

  /**
   * 记录一次整理完成的时间。
   * 同时写会话级 _meta.json（供冷却判断）与各成员文件的 lastConsolidatedAt。
   * userIds 为空时只更新会话级时间。
   */
  markConsolidated(chatKey, at = Date.now(), userIds = []) {
    try {
      fs.mkdirSync(chatDir(chatKey), { recursive: true });
      const prev = readJson(metaFile(chatKey), {}) || {};
      writeJson(metaFile(chatKey), { ...prev, lastConsolidatedAt: Number(at) || Date.now() });
    } catch (error) {
      console.warn('[memory] 写整理时间失败:', error?.message ?? error);
    }
    const map = this.#ensureChat(chatKey);
    for (const uid of userIds || []) {
      const key = String(uid ?? '').trim();
      if (!key) continue;
      const m = map.get(key);
      if (!m) continue;
      m.lastConsolidatedAt = Number(at) || Date.now();
      try { writeJson(memberFile(chatKey, m.userId, m.name), m); } catch { /* ignore */ }
    }
  }

  /**
   * 用整理结果整体替换本会话的印象（按成员写回各自文件）。
   * next.memberImpression: [{ userId?, target?, content }]
   */
  replaceConsolidated(chatKey, next) {
    const groups = new Map();
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {
      const uid = String(item.userId || '').trim();
      const name = String(item.target || uid).trim();
      const content = String(item.content || '').trim().slice(0, 300);
      if (!content || !/^\d{1,15}$/.test(uid)) continue;
      if (!groups.has(uid)) groups.set(uid, { name, contents: [] });
      groups.get(uid).contents.push(content);
    }
    const before = this.members(chatKey);
    for (const m of before) {
      if (/^\d{1,15}$/.test(m.userId) && !groups.has(m.userId)) this.replaceMember(chatKey, m.userId, m.name, []);
    }
    for (const [uid, g] of groups) this.replaceMember(chatKey, uid, g.name, g.contents);
    this.markConsolidated(chatKey, Date.now(), [...groups.keys()]);
    const memberImpression = this.query(chatKey).memberImpression;
    return { memberImpression, count: memberImpression.length };
  }
}
