// 运行期本地表情库管理：图片转存、备注、笔记和使用计数。
// 通过通用 get_image 获取消息图片，不管理外部客户端的收藏。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';
import { safeFetchBinary } from './safe-fetch.js';
import {
  loadStickerStore, saveStickerStore,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed
} from './stickers.js';

// 收藏表情的本地图片目录：收藏时把图片转存到这里（QQ 图床 rkey 会过期，
// 直接存 url 的话过 1 小时左右 send_sticker 就发不出去了 —— 这是"收藏频发故障"的根因）。
// 注意：用函数延迟取 DATA_DIR，而不是模块加载时定死 —— 测试/便携场景会重定向数据目录。
function stickerImagesDir() {
  return path.join(DATA_DIR, 'sticker-images');
}

/**
 * 只允许访问由收藏功能维护的本地图片，拒绝配置/存档中指向目录外的 file URI。
 * 返回绝对路径（存在且是文件）；不合法返回 null。
 *
 * 搬家自愈（2026-09-26）：严格路径失效但同名文件在受控目录里 —— 部署换目录 /
 * data 被整体拷贝后，旧绝对路径全部失效，16 条历史收藏曾因此集体发不出去。
 * 这时按文件名重定位到受控目录里的那份（仍然只在受控目录内，安全边界不变）。
 */
export function localStickerPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  // file:///C:/... 在 Windows URL pathname 前面多一个斜杠。
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  const root = path.resolve(stickerImagesDir()) + path.sep;
  const inside = (p) => String(p).toLowerCase().startsWith(root.toLowerCase());
  const isFile = (p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } };
  const full = path.resolve(pathname);
  if (inside(full) && isFile(full)) return full;
  const base = path.basename(pathname);
  if (base && base !== '.' && base !== '..') {
    const cand = path.resolve(path.join(stickerImagesDir(), base));
    if (inside(cand) && isFile(cand)) return cand;
  }
  return null;
}

// 图片类型嗅探统一在 image-type.js：原先这里是第三份副本，且**漏了 JPEG 分支**
// （靠"默认返回 .jpg"歪打正着），加新格式时要改三处、极易漏。
import { detectImageExt } from './image-type.js';

// ── 收藏时自动看图写备注（本地扩展，2026-10-21）──────────────────────────────
// 背景：模型判断"要不要发这张表情"靠的是提示词里那行备注（desc/localNote）。
// 收藏来的表情如果只有一句"好图偷了"，下次它自己都认不出这张画的是什么，
// 于是要么每次都先调 get_sticker_image（多一次视觉调用），要么干脆不发。
// 这里在收藏成功后就地看一眼图，把画面 + 适用语境写成 localNote，并给 tags。
const ANNOTATE_SYSTEM = [
  '你是 QQ 群聊表情包的标注助手。用户给你一张刚收藏的表情包图片，你要用中文写一条备注。',
  '严格输出一行 JSON：{"note":"…","tags":["…"]}',
  'note 规则：不超过 26 个字；先说画面里是谁/什么、什么表情或图上文字，再说适合用在什么语境（如 嘲讽/卖萌/无语/赞同/挑衅/震惊/点赞/安慰）；',
  '不要出现"这张图""表情包""图片中"这类废话，不要描述配色和画质。',
  'tags 规则：2~4 个简短中文词，用于检索。',
  '只输出 JSON，不要解释、不要代码块。'
].join('\n');

/** 从模型输出里抠出 {note, tags}；失败返回 null。 */
function parseAnnotation(text) {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (!raw) return null;
  const brace = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (brace >= 0 && end > brace) {
    try {
      const obj = JSON.parse(raw.slice(brace, end + 1));
      const note = String(obj?.note ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const tags = (Array.isArray(obj?.tags) ? obj.tags : [])
        .map((t) => String(t).trim()).filter(Boolean).slice(0, 4);
      if (note) return { note, tags };
    } catch { /* 落到下面按纯文本兜底 */ }
  }
  const fallback = raw.replace(/\s+/g, ' ').slice(0, 40);
  return fallback ? { note: fallback, tags: [] } : null;
}

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.collectTimes = [];
    this.healLocalPaths();
  }

  /**
   * 搬家自愈：条目里的旧绝对路径若文件已在受控目录中（按文件名匹配），重写 url。
   * 构造时跑一次（幂等）——部署换目录后第一次启动即可复活全部本地收藏。
   */
  healLocalPaths() {
    let changed = 0;
    for (const e of this.entries) {
      const u = String(e.url || '');
      if (!u.toLowerCase().startsWith('file:///')) continue;
      const healed = localStickerPath(u);
      if (!healed) continue;
      const fresh = `file:///${healed.replace(/\\/g, '/')}`;
      if (fresh.toLowerCase() !== u.toLowerCase()) {
        e.url = fresh;
        e.localFile = fresh;
        changed += 1;
      }
    }
    if (changed) {
      try { saveStickerStore(this.entries); } catch { /* 自愈写盘失败不影响运行 */ }
    }
    return changed;
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  /** 从本地文件刷新表情库，不向外部客户端同步收藏。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    if (force) {
      this.entries = loadStickerStore();
      this.healLocalPaths();
    }
    return { entries: this.entries, fromCache: true };
  }

  /**
   * 发送前预检：确保表情有一个"当前可发送"的地址。
   *
   * ── 为什么需要它（"表情包经常发送失败"的第二根因）──────────────────────
   * 表情库里 http 直链的寿命只有 1 小时左右（QQ 图床 rkey 过期）。
   * 发送前检查本地文件或尝试转存仍可访问的远端地址：
   *   · 本地转存（file:///）→ 永久有效，直接返回
   *   · http 直链 → 尝试下载转存到 data/sticker-images/：
   *       成功 = 库里 url 升级成本地路径（下次发送永久有效，这正是收藏
   *       功能已有的转存逻辑，这里复用同一目录与安全边界）；
   *       失败（直链已过期）= 保持原 url，让 sender 的回退链去试
   *       get_image/base64（那边有完整的三级回退）。
   * 每个条目只试一次（缓存在 entry._persistTried），避免同一轮反复下载。
   *
   * @param {object} sticker 表情条目（原地升级 url 字段）
   * @returns {Promise<object>} 同一引用（方便链式使用）
   */
  async ensureSendable(sticker) {
    if (!sticker?.id || !sticker?.url) return sticker;
    const url = String(sticker.url);
    if (url.toLowerCase().startsWith('file:///')) {
      // 已是本地路径：顺手做搬家自愈（旧绝对路径 → 受控目录内同名文件）
      const healed = localStickerPath(url);
      if (healed) {
        const fresh = `file:///${healed.replace(/\\/g, '/')}`;
        if (fresh.toLowerCase() !== url.toLowerCase()) {
          sticker.url = fresh;
          sticker.localFile = fresh;
          try { saveStickerStore(this.entries); } catch { /* 持久化失败不影响本次 */ }
        }
      }
      return sticker;
    }
    if (sticker._persistTried) return sticker;                      // 本轮已试过，别反复下载
    sticker._persistTried = true;
    try {
      // 带上消息缓存 file id：直链下载失败时 get_image 还有一次机会
      const local = await this.#persistImage(`st_${sticker.id}`, { url, file: sticker.qqFile || '' });
      if (local) {
        sticker.url = local;
        sticker.localFile = local;
        sticker.persistFailed = false;
        // 升级后的条目写回库里（find() 返回的是 this.entries 里的同一对象引用，
        // 直接 save 即可持久化；失败不影响本次发送）
        try { saveStickerStore(this.entries); } catch { /* 持久化失败不影响本次 */ }
      }
    } catch {
      // 转存失败：保持原 url 交给 sender 回退链，并打上"僵尸条目"预警标记
      sticker.persistFailed = true;
      try { saveStickerStore(this.entries); } catch { /* ignore */ }
    }
    return sticker;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  /**
   * 收藏一条消息里的图片。
   *
   * 图片优先转存到本地；失败时保留原地址并明确标记，绝不声称已持久化。
   */
  async collect(messageId, { url, note = '', file = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    // 限频
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    file = String(file || '');
    if (!url && !file) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const noteText = String(note || '');
    const existing = this.entries.find((e) => e.id === id);

    // ① 图片字节：协议端缓存优先（get_image），其次直链下载
    let bytes = null;
    try { bytes = await this.#getImageBytes({ url, file }); } catch { bytes = null; }
    // ② 本地转存（双保险，发送最稳的形态）
    let localFile = '';
    if (bytes) {
      try { localFile = this.#saveLocalImage(id, bytes); }
      catch (error) { console.warn(`[sticker] 本地转存写盘失败: ${error?.message ?? error}`); }
    }

    const sendUrl = localFile || url;
    const persistFailed = !localFile;

    if (existing) {
      // 幂等：重复收藏更新本地备注和图片。
      this.note(id, { note: noteText });
      const target = this.entries.find((e) => e.id === id) || existing;
      if (localFile) { target.url = localFile; target.localFile = localFile; }
      else if (sendUrl && !String(target.url || '').startsWith('file:///')) target.url = sendUrl;
      if (file) target.qqFile = file;
      target.persistFailed = !String(target.url || '').startsWith('file:///');
      saveStickerStore(this.entries);
      await this.#autoAnnotate(target, bytes, noteText);
      return target;
    }

    const entry = {
      id,
      resId: id,
      qqFile: file,
      url: sendUrl,
      sourceUrl: url,                  // 保留原始 url 备查
      localFile,
      md5: '',
      desc: noteText.slice(0, 20),
      localNote: noteText,
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      persistFailed,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    saveStickerStore(this.entries);
    await this.#autoAnnotate(entry, bytes, noteText);
    return entry;
  }

  /**
   * 把一张图片持久化到 data/sticker-images/，返回 file:/// 绝对路径。
   * 路径 1：OneBot get_image（消息里的 file id → 本地缓存文件，不依赖 url 时效）
   * 路径 2：直接下载 url（新消息 url 未过期时有效）
   */
  /**
   * 收藏后自动看一眼图写备注（失败静默，绝不影响收藏本身）。
   * 备注写进 localNote、标签写进 tags —— 提示词列表情时会带上它们，
   * 否则模型每次想发表情都得先 get_sticker_image 看图，最后干脆不发。
   */
  async #autoAnnotate(entry, bytes, tasteNote = '') {
    try {
      if (!entry?.id) return;
      if (getConfig().sticker?.autoAnnotate === false) return;
      if (!bytes || !bytes.length) return;
      // 已经有备注就别覆盖：可能是我手动写的、或之前标注过的，重复收藏不该把好备注冲掉
      const existing = this.entries.find((e) => e.id === entry.id);
      if (String(existing?.localNote || existing?.note || '').trim()) return;
      const ext = String(detectImageExt(bytes) || '.png').toLowerCase();
      const mime = ext === '.gif' ? 'image/gif'
        : ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : 'image/jpeg';
      const { chatCompletion } = await import('./llm.js');
      const res = await chatCompletion({
        messages: [
          { role: 'system', content: ANNOTATE_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张是刚从群聊里收藏的表情包，请按要求输出 JSON。' },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` } }
            ]
          }
        ],
        temperature: 0.2,
        maxTokens: 220
      });
      const text = String(res?.message?.content ?? res?.content ?? '');
      const parsed = parseAnnotation(text);
      if (!parsed?.note) return;
      const patch = { note: parsed.note };
      if (parsed.tags.length) patch.tags = parsed.tags;
      const taste = String(tasteNote || '').trim();
      if (taste && taste !== parsed.note) patch.usage = taste.slice(0, 200);
      this.note(entry.id, patch);
    } catch (error) {
      console.warn(`[sticker] 自动备注失败（不影响收藏）: ${error?.message ?? error}`);
    }
  }

  async #persistImage(id, { url, file }) {
    const buf = await this.#getImageBytes({ url, file });
    if (!buf) throw new Error('图片转存失败（get_image 无缓存且 url 下载失败）');
    return this.#saveLocalImage(id, buf);
  }

  /** 取图片字节：协议端缓存（get_image）优先，其次直链下载。拿不到返回 null。 */
  async #getImageBytes({ url, file }) {
    if (file) {
      try {
        const ret = await this.onebot.call('get_image', { file: String(file) });
        const srcPath = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
        if (srcPath) {
          const buf = fs.readFileSync(srcPath);
          if (buf.length) return buf;
        }
        // 有的实现返回可下载 url
        if (ret?.url) {
          const buf = await this.#downloadBytes(String(ret.url));
          if (buf) return buf;
        }
      } catch { /* 缓存没有就走下载 */ }
    }
    if (url) {
      const buf = await this.#downloadBytes(url);
      if (buf) return buf;
    }
    return null;
  }

  /** 字节 → data/sticker-images/<id><ext>，返回 file:/// URI。 */
  #saveLocalImage(id, buffer) {
    const imgDir = stickerImagesDir();
    fs.mkdirSync(imgDir, { recursive: true });
    const dest = path.join(imgDir, `${id}${detectImageExt(buffer)}`);
    fs.writeFileSync(dest, buffer);
    return `file:///${dest.replace(/\\/g, '/')}`;
  }

  async #downloadBytes(url, timeoutMs = 15000) {
    try {
      // 走 safe-fetch：这里的 url 来自 OneBot 消息段（发送方可影响），
      // 裸 fetch 等于给了一条"让本机去抓内网"的 SSRF 通道。
      void timeoutMs;
      const { buffer } = await safeFetchBinary(String(url), 15 * 1024 * 1024);
      return buffer?.length ? buffer : null;
    } catch {
      return null;
    }
  }
}
