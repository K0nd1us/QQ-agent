// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';
import { safeFetchBinary } from './safe-fetch.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
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

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.syncedAt = 0;
    this.syncing = null;
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

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        const merged = mergeStickerLibrary(this.entries, fetched);
        this.entries = merged;
        this.syncedAt = Date.now();
        saveStickerStore(this.entries);
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  /**
   * 发送前预检：确保表情有一个"当前可发送"的地址。
   *
   * ── 为什么需要它（"表情包经常发送失败"的第二根因）──────────────────────
   * 表情库里 http 直链的寿命只有 1 小时左右（QQ 图床 rkey 过期）。
   * 同步 TTL 也是 60 秒 —— 但 sync 只在**收消息**的运行里刷新，
   * 一次运行 12 轮工具循环可能跑几分钟，中途直链就会过期；
   * 更糟的是 sync 失败时（协议端断连）库里的 url 全是旧的，
   * 发送必失败。这个方法在**发送前**做一次兜底：
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
   * 2026-09-26 起**必定调用 add_custom_face 入 QQ 收藏**（QQ 客户端里
   * "把图片变成自己的表情"的同款能力）：QQ 侧托管后图片永久有效 —— 不怕
   * 图床 rkey 过期、不怕部署目录搬家。此前只做本地转存，直链一过期就产生
   * "收藏成功却永远发不出去"的僵尸条目（现场实测直链 400），搬家后历史条目
   * 还会集体失效。流程：取字节 → 本地转存（双保险）→ add_custom_face（必定）
   * → 备注回写 → 定可发地址。QQ 入库失败不阻断本地收藏，但会在返回里如实
   * 标注（qqCollectError）。
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

    // ③ QQ 原生收藏（必定调用）：有字节走 base64；没字节把 url 交给 QQ 服务端自取
    let emojiId = String(existing?.emojiId || '').trim();
    let qqCollectError = '';
    if (!emojiId) {
      try {
        const addRef = bytes ? `base64://${bytes.toString('base64')}` : url;
        const ret = await this.onebot.call('add_custom_face', { file: addRef });
        emojiId = String(ret?.emoji_id ?? '').trim();
        if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
      } catch (error) {
        qqCollectError = String(error?.message ?? error);
      }
    }

    // ④ 备注写进 QQ 收藏（best-effort，QQ 面板里能看到这条备注）
    if (emojiId && noteText) {
      try { await this.onebot.call('modify_custom_face', { emoji_id: emojiId, desc: noteText.slice(0, 20) }); }
      catch { /* 备注失败不影响收藏 */ }
    }

    // ⑤ 定"当前可发送"的地址：本地转存 > QQ 收藏回查的长效表情 url > 原 url（僵尸）
    let sendUrl = localFile;
    if (!sendUrl && emojiId) {
      try {
        const list = await this.onebot.call('fetch_custom_face_detail', { count: 200 });
        const items = Array.isArray(list) ? list : (Array.isArray(list?.data) ? list.data : []);
        const hit = items.find((x) => String(x?.emoji_id ?? x?.resId ?? x?.id ?? '') === emojiId);
        const qqUrl = String(hit?.url || '').trim();
        if (qqUrl) sendUrl = qqUrl;
      } catch { /* 查不到就往下退 */ }
    }
    // 僵尸预警 = 既没本地转存、也没进 QQ 收藏（只能靠会过期的直链活着）
    const persistFailed = !localFile && !emojiId;
    if (!sendUrl) sendUrl = url;

    if (existing) {
      // 幂等：重复收藏只更新备注 / 补齐 QQ 身份（上面已按需补调 add_custom_face）
      this.note(id, { note: noteText });
      const target = this.entries.find((e) => e.id === id) || existing;
      if (emojiId) target.emojiId = emojiId;
      if (localFile) { target.url = localFile; target.localFile = localFile; }
      else if (sendUrl && !String(target.url || '').startsWith('file:///')) target.url = sendUrl;
      if (file) target.qqFile = file;
      target.persistFailed = !String(target.url || '').startsWith('file:///') && !target.emojiId;
      saveStickerStore(this.entries);
      target.qqCollectError = qqCollectError;   // 仅供本次返回提示
      return target;
    }

    const entry = {
      id,
      resId: emojiId || id,
      emojiId,
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
    entry.qqCollectError = qqCollectError;   // 仅供本次返回提示，不入库
    return entry;
  }

  /**
   * 把一张图片持久化到 data/sticker-images/，返回 file:/// 绝对路径。
   * 路径 1：OneBot get_image（消息里的 file id → 本地缓存文件，不依赖 url 时效）
   * 路径 2：直接下载 url（新消息 url 未过期时有效）
   */
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
