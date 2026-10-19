// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import fs from 'node:fs';
import { getConfig, DEFAULT_CONFIG } from './config.js';
import { sleep, randInt, createSendChain, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;

/**
 * 本地路径 → OneBot 能识别的 file URI。
 *
 * 为什么要转换而不是直接传路径：裸 Windows 路径（反斜杠 + 盘符）在 OneBot
 * 各实现里支持不一致，而 `file:///C:/a/b.png` 是规范里明确的形式。
 * 空格/中文要编码（协议端会 decodeURIComponent），`#` `?` 在 URI 里是分隔符，
 * 必须手动转义 —— encodeURI 不处理它们。
 */
export function toFileUri(input) {
  // ⚠️ 本函数刻意不使用任何正则转义（用 String.fromCharCode(92) 取反斜杠、
  // 用 split/join 代替路径分隔符替换）。原因：这段代码最初是用脚本批量写入的，
  // 多层转义把 `\/` 吃成了 `/`，写出了一个非法的正则字面量，
  // 而 `node --check` 的结果被 shell 的 `&&` 链掩盖成"通过" ——
  // 结果整个 sender.js 加载即崩，比原本要修的 bug 严重得多。
  // 零反斜杠写法让"写错字符"这件事根本不可能发生。
  const BS = String.fromCharCode(92);                    // 反斜杠字符本身
  let s = String(input || '').trim().split(BS).join('/');
  if (!s) return '';
  if (s.slice(0, 7).toLowerCase() === 'file://') return s;   // 已是 URI → 幂等
  const unc = s.startsWith('//');                        // UNC：\\server\share
  // 去掉前导斜杠（逐个 split 掉，避免再用正则转义）
  const body = unc ? s.slice(2) : s.split('/').filter(Boolean).join('/');
  if (!body) return '';
  // encodeURI 会处理空格/中文，但不转义 `#` `?` —— 它们在 URI 里是分隔符，必须手动转
  const encoded = encodeURI(body).replace(/[?#]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return unc ? 'file://' + encoded : 'file:///' + encoded;
}

export class SendQueue {
  constructor({ onebot, store, onSent = null, log = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    // 回退/降级这类"行为变了但没报错"的事必须留痕，否则排查时看不到曾经降级过
    this.log = typeof log === 'function' ? log : null;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
    this.recentSent = new Map();  // "chatKey::text" -> ts（发送去重窗口）
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    // 回退值必须与 config.js 的默认值一致（80）。此前这里是 8，
    // 配置缺失/为 0 时限频突然收紧 10 倍，行为不可预测。
    if (minute.length >= Math.max(1, Number(cfg.maxPerMinute) || DEFAULT_MAX_PER_MINUTE)) {
      throw new Error(`发送频率超限（每分钟最多 ${cfg.maxPerMinute || DEFAULT_MAX_PER_MINUTE} 条），请等一会再发`);
    }
    if (hour.length >= Math.max(1, Number(cfg.maxPerHour) || DEFAULT_MAX_PER_HOUR)) {
      throw new Error(`发送频率超限（每小时最多 ${cfg.maxPerHour || DEFAULT_MAX_PER_HOUR} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  /**
   * 发送去重：同一会话短时间内完全相同的文本只发一次。
   *
   * 背景（重复消息的根因之一）：模型在一次会话里可能重复调用 send_message
   * 传入相同内容（尤其是内联工具调用解析 + 原生 tool_calls 并存时），
   * 或 OneBot 超时看似失败但实际已发出、上层重试再发一遍。
   * 这里在真正发出前做一道内容指纹去重：窗口期内 identical 文本直接跳过。
   */
  #dedupeWindow() {
    const raw = getConfig().send?.dedupeWindowMs;
    // 0 是明确的关闭值，不能用 `|| 8000` 把它误当默认值。
    if (raw === null || raw === undefined || raw === '') return 8000;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 8000;
  }

  /**
   * 只读判断：窗口期内是否已发出过相同内容。
   * ⚠️ 绝不在发送前记账 —— 发送失败（OneBot 报错/限频）的消息必须允许重试，
   * 提前记账会把合法重试误判为重复、导致消息静默丢失。
   */
  #isDuplicate(chatKey, text) {
    const win = this.#dedupeWindow();
    if (!win) return false;
    const last = this.recentSent.get(`${chatKey}::${String(text)}`);
    return Boolean(last && Date.now() - last < win);
  }

  /** 发送成功后记账（去重指纹）。 */
  #markSent(chatKey, text) {
    const win = this.#dedupeWindow();
    if (!win) return;
    const now = Date.now();
    this.recentSent.set(`${chatKey}::${String(text)}`, now);
    // 顺手清理过期条目，避免 Map 无限增长
    if (this.recentSent.size > 500) {
      for (const [k, t] of this.recentSent) {
        if (now - t > win) this.recentSent.delete(k);
      }
    }
  }

  #gap(text, isLast) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    const byLength = Math.min(8000, (String(text || '').length) * (Number(cfg.byLengthMs) || 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId }
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const parts = [];
    for (const m of list) {
      const plain = mdToPlain(String(m ?? ''));
      if (!plain) continue;
      // 最后防线：任何上游畸形路径漏下来的 "[object Object]" 到这儿直接拦掉，
      // 用户永远不该在 QQ 里看到这串字符。全被拦 → 下方抛"消息内容为空"回给模型。
      if (/^\[object Object\]$/.test(plain)) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    const promises = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      const gap = this.#gap(text, isLast);
      promises.push(chain(async () => {
        this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap);
        // 发送去重：窗口期内 identical 文本跳过（防模型重复调用/超时重试造成的重复发言）
        if (this.#isDuplicate(chatKey, text)) {
          console.warn(`[sender] 跳过重复消息（${this.#dedupeWindow()}ms 内已发过相同内容）：${String(text).slice(0, 30)}`);
          return { text, messageId: null, at: formatClockTime(Date.now()), deduped: true };
        }
        // 跨会话发送等调用方可在真正出站前重查权限，避免排队期间的撤销失效。
        await options.beforeSend?.();
        const data = await this.onebot.sendText(kind, id, text, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null
        });
        this.#markSent(chatKey, text);   // 只有 OneBot 成功返回后才记入去重窗口
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text, ts, mid: data?.message_id ?? null });
        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') sent.push(r.value);
      // 带上 index 和原文：调用方需要知道"哪一条"失败了（才能重发或告知模型）。
      // 原先 failed 里只有 error，没有任何定位信息。
      else failed.push({ index: i, text: parts[i], error: String(r.reason?.message ?? r.reason) });
    }
    // 部分成功也要让调用方知道：原先只在"全败"时抛错，部分成功会静默丢消息
    if (failed.length > 0) {
      const detail = failed.map((f) => `第${f.index + 1}条「${String(f.text).slice(0, 20)}」：${f.error}`).join('；');
      if (sent.length === 0) throw new Error(detail);
      console.warn(`[sender] 部分发送失败（${failed.length}/${parts.length}）：${detail}`);
    }
    return { sent, failed };
  }

  /** 发送一个收藏表情（独立气泡）。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      // ── 发送回退链（修"表情包经常发送失败"）────────────────────────────
      // 表情库里的 url 有三种形态，稳定性天差地别：
      //   1. file:/// 本地转存（收藏功能写入，永久有效）—— 最优先
      //   2. http(s) QQ 图床直链 —— rkey/时效大约 1 小时，过期后 403/404，
      //      这是"经常失败"的主力（老库存里 60/66 条都是这种）
      //   3. 空地址 —— 直接报错给模型
      // 失败自愈：http 直链失败时，用 OneBot get_image（拿协议端本地缓存）
      // 重发一次；再不行转成 base64 内联发（体积上限 15MB，超限明确报错）。
      const sendVia = (ref) => this.onebot.sendSticker(kind, id, ref, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      });
      let data;
      const primary = String(sticker.url || '').trim();
      if (!primary) throw new Error(`表情 ${sticker.id} 没有可发送的图片地址`);
      try {
        data = await sendVia(primary);
      } catch (firstError) {
        if (primary.toLowerCase().startsWith('file:///')) {
          // 本地文件：读出来转 base64 内联再试一次 —— 协议端不同机 / 路径权限 /
          // file:/// 解析差异都可能拒收本地形态，而 base64 是最通用的兜底
          //（sendImage 早有同款回退；这里曾经直接 throw，本地收藏因此"永远发不出去"）。
          const { localStickerPath } = await import('./sticker-manager.js');
          const p = localStickerPath(primary);
          let buf = null;
          try { buf = p ? fs.readFileSync(p) : null; } catch { buf = null; }
          if (!buf?.length) throw firstError;
          try {
            this.log?.(`[sender] 本地表情发送失败（${firstError?.message ?? firstError}），转 base64 重发`);
            data = await sendVia(`base64://${buf.toString('base64')}`);
          } catch (retryError) {
            throw new Error(`本地表情两种形态都发不出去：file=${firstError?.message ?? firstError}；base64=${retryError?.message ?? retryError}`);
          }
        } else {
        // 回退 1：get_image 按文件名/URL 拿协议端本地缓存，绕开过期直链
        try {
          const fileKey = sticker.md5 || sticker.resId || sticker.id || '';
          const ret = await this.onebot.call('get_image', { file: fileKey });
          const cached = ret?.file || ret?.filename || '';
          if (cached) {
            this.log?.(`[sender] 表情直链发送失败（${firstError?.message ?? firstError}），改用协议端缓存重试`);
            data = await sendVia(cached);
          }
        } catch { /* 继续走回退 2 */ }
        // 回退 2：下载直链转 base64 内联（此刻直链可能恰好还有效；或已被
        // image-compat 等场景缓存过）。上限 15MB，防超大图拖垮发送。
        if (!data) {
          const { safeFetchBinary } = await import('./safe-fetch.js');
          const { buffer } = await safeFetchBinary(primary, 15 * 1024 * 1024);
          if (!buffer?.length) throw firstError;
          this.log?.(`[sender] 表情直链发送失败，已下载 ${Math.round(buffer.length / 1024)}KB 转 base64 发送`);
          data = await sendVia(`base64://${buffer.toString('base64')}`);
        }
        }
      }
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * 发一张图片（独立气泡）。
   *
   * 和 sendSticker 一样走完整发送管道：限频 → 去重 → 发送 → 留档。
   * 这三步一个都不能省：
   *   · 限频：图比文字更容易刷屏，必须和文字共享同一套配额
   *   · 去重：模型可能对同一个 URL 连发两次（实测过），按 URL 指纹挡掉
   *   · 留档：不留档的话，下一次运行不知道自己发过图，可能重复发
   *
   * @param {object} img { url } 或 { dataUrl }（二选一）
   * @param {object} options { note, replyToMessageId, atUserId }
   */
  sendImage(chatKey, img, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    const url = String(img?.url ?? '').trim();
    const dataUrl = String(img?.dataUrl ?? '').trim();
    // ── 本地文件路径优先（修过一个真实故障）──────────────────────────────
    // 原来只会传 `url` 或 `dataUrl`。而 `dataUrl` 是 base64 内联进 HTTP body 的：
    // 一张 1.9MB 的图 → base64 后 2.5MB 要 POST 给协议端，协议端再解码、再上传腾讯，
    // 15 秒超时窗口经常走不完 → 表现为「图画出来了但发不出去」。
    //
    // 图本来就已经落盘了（生成/下载后都有本地路径），所以传路径让**协议端自己读磁盘**：
    // body 从 2.5MB 降到约 100 字节，等于把传输量去掉三个数量级。
    // 前端不因此变小：协议端读的是同一个文件系统的同一个文件。
    //
    // ⚠️ 前提是协议端与本进程同机（本项目默认 127.0.0.1）。不同机时协议端读不到该
    // 路径 —— 所以下面保留 dataUrl 作回退，file 失败后自动改用 base64 再试一次。
    const file = String(img?.file ?? '').trim();
    if (!url && !dataUrl && !file) return Promise.reject(new Error('图片地址为空'));

    const ref = file ? toFileUri(file) : (url || dataUrl);
    // 去重键优先用 URL；dataUrl 太长不适合当键，用长度 + 前 64 字符做指纹
    const dedupeKey = url || file || `data:${dataUrl.length}:${dataUrl.slice(0, 64)}`;
    return chain(async () => {
      if (this.#isDuplicate(chatKey, `__img__${dedupeKey}`)) {
        throw new Error('这张图刚刚发过，已跳过（避免重复刷屏）');
      }
      this.#checkRate(chatKey);
      await sleep(randInt(500, 1300));   // 发图前真人式的短暂停顿

      let data;
      try {
        data = await this.onebot.sendImage(kind, id, ref, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null
        });
      } catch (error) {
        // file:// 失败 → 回退 base64（协议端不同机、路径不可读、权限不足等）。
        // 只在**有 dataUrl 备份**且**确实是 local 路径**时才回退，避免无意义重试。
        if (!file || !dataUrl) throw error;
        this.log?.(`本地路径发送失败（${error?.message ?? error}），回退 base64 重试一次`);
        data = await this.onebot.sendImage(kind, id, dataUrl, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null
        });
      }
      this.#markSent(chatKey, `__img__${dedupeKey}`);   // 发图同样：成功后才记账
      const ts = Date.now();
      const note = options.note ? `:${String(options.note).slice(0, 40)}` : '';
      this.store.appendSelf(chatKey, { text: `[图片${note}]`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[图片${note}]`, messageId: data?.message_id ?? null, kind: 'image' });
      return { message_id: data?.message_id ?? null };
    });
  }

  /**
   * 发送一批媒体段（视频 / 一次多图）—— 走完整发送管道：串行 → 限频 → 去重 → 留档。
   *
   * 为什么需要它：`sendImage` 一次只能发一张（一图一气泡），而"抖音图文帖一次 9 张"
   * 或"转发一段视频"没法用单图 API 表达。media-download 这类插件下载完拿到的是
   * 本地路径数组，必须能一次性成段发出去。
   *
   * ⚠️ 插件**不得**绕过本方法直接调 `onebot.sendSegments` —— 那样会跳过限频与留档，
   * 表现为"媒体把文字配额吃光后突然发不出话"和"下一次运行忘了自己发过，重复发"。
   * 所以 provider 拿到的依赖里应该带 `sender`，用 ctx 传进来的这个对象发送。
   *
   * @param {Array} segments OneBot 段数组，如 [{type:'video',data:{file:'/x.mp4'}}]
   * @param {object} options { label, dedupeKey, replyToMessageId, atUserId }
   */
  sendMedia(chatKey, segments, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') return Promise.reject(new Error(`非法会话 key：${chatKey}`));
    const segs = (Array.isArray(segments) ? segments : []).filter((s) => s && s.type);
    if (!segs.length) return Promise.reject(new Error('媒体段为空'));
    const label = String(options.label || '[媒体]');
    // 去重键优先用本地文件路径（同一份文件重复发说明是重试/重复触发）
    const dedupeKey = String(options.dedupeKey
      || segs.map((s) => s?.data?.file).filter(Boolean).join('|')
      || label);
    const chain = this.#chain(chatKey);
    return chain(async () => {
      if (this.#isDuplicate(chatKey, `__media__${dedupeKey}`)) {
        throw new Error('这份媒体刚刚发过，已跳过（避免重复刷屏）');
      }
      this.#checkRate(chatKey);
      await sleep(randInt(800, 1800));   // 视频/多图体积大，停顿比文字长一点
      const data = await this.onebot.sendSegments(kind, id, segs);
      this.#markSent(chatKey, `__media__${dedupeKey}`);   // 成功后才记账
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: label, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: label, messageId: data?.message_id ?? null, kind: 'media' });
      return { message_id: data?.message_id ?? null };
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */  poke(chatKey, targetUserId) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 拍一拍同样占发送配额 —— 曾经不调 #checkRate，模型连发 poke
      // 可以绕过 maxPerMinute/maxPerHour 刷屏
      this.#checkRate(chatKey);
      await sleep(randInt(300, 900));
      const data = await this.onebot.sendPoke(kind, id, targetUserId);
      const ts = Date.now();
      const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
      this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍${target}`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      return data;
    });
  }
}
