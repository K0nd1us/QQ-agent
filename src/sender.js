// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig, DEFAULT_CONFIG } from './config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;

export class SendQueue {
  constructor({ onebot, store, onSent = null, onBanned = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    this.onBanned = onBanned;     // 被禁言/风控时上报（供 UI 提示）
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
    this.bannedUntil = new Map(); // chatKey -> 解禁时间戳（熔断）
  }

  /**
   * 识别 QQ 侧“禁止发言”类错误（账号风控 / 群内禁言 / 群全员禁言）。
   * SnowLuma 的原文形如：
   *   send group message failed: Ban state forbit write req   （底层 packet code=-10203）
   * 注意：retcode=100 在 SnowLuma 里含义很宽（HTTP download failed: 400 等资源
   * 失败也会带），不能单独当禁言信号，否则表情包 URL 过期会被误熔断 30 分钟。
   */
  static isBannedError(error) {
    const s = String(error?.message ?? error ?? '');
    // 资源下载/参数类失败：明确不是禁言
    if (/download failed|HTTP download|资源下载|文件下载|无效.*url|invalid url/i.test(s)
      && !/ban state|forbit write|禁言|风控|被限制/i.test(s)) {
      return false;
    }
    // 明确的禁言/风控文案
    if (/ban state|forbit write|禁言|风控|被限制|发送失败.*限制|账号异常/i.test(s)) return true;
    // retcode=100 仅在同时出现 mute/ban/limit 类关键词时才当禁言
    return /\bretcode[=:]\s*100\b/i.test(s) && /\b(mute|ban|limit|forbid)\b|禁言|风控/i.test(s);
  }

  /** 该会话当前是否处于禁言熔断期。 */
  banInfo(chatKey) {
    const until = this.bannedUntil.get(chatKey);
    if (!until || until <= Date.now()) return null;
    return { until, remainMs: until - Date.now() };
  }

  /** 清掉过期/指定的熔断（用户手动重试时调用）。 */
  clearBan(chatKey) {
    this.bannedUntil.delete(chatKey);
  }

  /** 当前处于禁言熔断期的会话列表（供 /api/status 与控制台提示）。 */
  listBans() {
    const now = Date.now();
    const out = [];
    for (const [chatKey, until] of this.bannedUntil) {
      if (until <= now) continue;
      out.push({ chatKey, until, remainMs: until - now });
    }
    return out.sort((a, b) => b.until - a.until);
  }

  #checkBan(chatKey) {
    const info = this.banInfo(chatKey);
    if (!info) return;
    const min = Math.max(1, Math.round(info.remainMs / 60000));
    throw new Error(`本会话被 QQ 限制发言（禁言/风控），已暂停发送，约 ${min} 分钟后自动重试`);
  }

  /** 发送失败且判定为禁言时设置熔断。 */
  #handleSendResult(chatKey, error) {
    if (!error) return;
    if (!SendQueue.isBannedError(error)) return;
    const cooldownMs = Math.max(60_000, Number(getConfig().send?.banCooldownMs) || 30 * 60 * 1000);
    const until = Date.now() + cooldownMs;
    const first = !this.bannedUntil.has(chatKey);
    this.bannedUntil.set(chatKey, until);
    if (first) {
      this.onBanned?.({ chatKey, until, reason: String(error?.message ?? error) });
      console.warn(`[sender] ${chatKey} 被 QQ 限制发言，暂停发送到 ${new Date(until).toLocaleTimeString('zh-CN', { hour12: false })}`);
    }
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
      throw new Error(`发送频率超限（每小时最多 ${cfg.maxPerHour} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
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
        this.#checkBan(chatKey);
        this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap);
        try {
          const data = await this.onebot.sendText(kind, id, text, {
            replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
            atUserId: i === 0 ? options.atUserId : null
          });
          const ts = Date.now();
          this.store.appendSelf(chatKey, { text, ts, mid: data?.message_id ?? null });
          this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
          return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };
        } catch (error) {
          this.#handleSendResult(chatKey, error);
          throw error;
        }
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
      this.#checkBan(chatKey);
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      try {
        const data = await this.onebot.sendSticker(kind, id, sticker.url, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null
        });
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, ts, mid: data?.message_id ?? null });
        this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
        return { message_id: data?.message_id ?? null };
      } catch (error) {
        this.#handleSendResult(chatKey, error);
        throw error;
      }
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkBan(chatKey);
      await sleep(randInt(300, 900));
      try {
        const data = await this.onebot.sendPoke(kind, id, targetUserId);
        const ts = Date.now();
        const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
        this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍${target}`, ts, mid: data?.message_id ?? null });
        this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
        return data;
      } catch (error) {
        this.#handleSendResult(chatKey, error);
        throw error;
      }
    });
  }
}
