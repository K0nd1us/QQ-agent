// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText } from './util.js';
import { skillManager } from './skills/manager.js';

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;
// 连上 WS 但 get_login_info 失败（SnowLuma 还在启动/账号还没挂好）时的补拉间隔。
const SELF_INFO_RETRY_MS = 15000;

/**
 * 正文 @ 规范化：把 `@昵称` 补成 `@昵称(QQ:xxx)`。
 * 走 `message.inline-at-normalize` 能力；没有提供者（Skill 未启用）时返回 null，
 * 调用方退回原文本 —— 保证"关掉 Skill 就不再有该效果"。
 */
function normalizeInlineAt(text, atUserId, atName) {
  try {
    const fn = skillManager.getCapabilityProviders('message.inline-at-normalize')[0]?.fn;
    if (!fn || !atName) return null;
    return fn({ text, members: [{ userId: atUserId, nickname: atName }], atUserId }) ?? null;
  } catch {
    return null;
  }
}

/**
 * 语音转文字：走 `media.transcribe` 能力（speech-to-text 插件提供）。
 *
 * 返回 null 的三种情况都退回 `[语音]` 占位，等于"没装这个插件"：
 *   · 没有提供者（插件未启用 / 没配 whisper 路径）
 *   · 调用方没给 onebot 客户端（拿不到语音文件）
 *   · 识别失败（插件内部已吞错并 log，这里再兜一层）
 * 这样保证关掉插件行为完全回退，且识别失败绝不打断消息入库。
 */
async function transcribeVoice(record, onebot) {
  try {
    const fn = skillManager.getCapabilityProviders('media.transcribe')[0]?.fn;
    if (!fn || !onebot) return null;
    const r = await fn({ record, onebot });
    const text = String(r?.text ?? '').trim();
    return r?.ok && text ? text : null;
  } catch {
    return null;
  }
}

// ── OneBot HTTP 调用的超时与错误可读性 ────────────────────────────────────
const CALL_TIMEOUT_MS = 15000;    // 查询类：够用
const SEND_TIMEOUT_MS = 90000;    // 发送类：协议端要接收 body + 解码 + 上传腾讯，15 秒远不够
// 只有**真的扛大 body** 的 action 才给宽容超时。
//
// 为什么不能简单写 `send_`：`send_poke`（拍一拍）、`friend_poke`、`group_poke`
// 都是轻量交互，给它们 90 秒意味着协议端一旦不响应，用户要干等一分半才看到报错，
// 观感上等同于"卡死"。而 `send_group_msg` / `send_private_msg` 可能携带
// image/video/record 段，那才是需要长窗口的。
// `send_(group|private)` 同时覆盖了 `send_group_msg` 与 `send_group_forward_msg`。
const SLOW_ACTION = /^(send_(group|private)|upload_|_send)/i;

/**
 * 把 fetch 的 `cause` 链挖成人话。
 * fetch 网络层失败时 message 恒为 "fetch failed"，真因（ECONNREFUSED /
 * TimeoutError / socket hang up / 代理拦截）全在 cause 里 —— 不挖出来，
 * 上层和用户都只看到一句"fetch failed"，完全无法排查。
 */
function describeCause(error, depth = 0) {
  if (!error) return '未知原因';
  if (depth > 3) return String(error?.message ?? error);
  const parts = [];
  const seen = new Set();
  let cur = error;
  while (cur && !seen.has(cur) && parts.length < 4) {
    seen.add(cur);
    const code = cur.code ? `[${cur.code}] ` : '';
    const msg = String(cur.message || cur.name || '').trim();
    const piece = `${code}${msg}`.trim();
    if (piece && !parts.includes(piece)) parts.push(piece);
    cur = cur.cause;
  }
  return parts.filter((p) => p && p !== 'fetch failed').join(' ← ')
    || parts.join(' ← ') || '未知原因';
}

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    this.#closedByUs = false;
    this.statusListeners = new Set();
  }

  #closedByUs;
  #failedAttempts = 0;   // 连续失败次数（指数退避用；连接成功即清零）
  #connectGeneration = 0;  // 连接循环代际号：新循环启动即作废旧循环（防并发僵尸循环）
  #reconnectTimer = null;  // 待执行的重连定时器（close/reconnect 时要清，防泄漏）
  #selfInfoTimer = null;   // get_login_info 延迟补拉定时器

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  async connect() {
    this.#closedByUs = false;
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    // ⚠️ 退避必须清零（2026-09-19）：reconnect 是"配置变了主动换连接"，不是失败。
    // 之前不清零时，主动换 token 后的第一次连接仍背着旧循环涨到 30 秒的退避，
    // 表现为"切了正确令牌也要等半分钟才试"，多账号轮换恢复被人为拖慢。
    this.#failedAttempts = 0;
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
  }

  #connectLoop() {
    // 单连接互斥：同一时刻只允许一个连接循环存活。
    // ── 为什么需要它（2026-09-19 401 风暴复盘）────────────────────────────
    // 旧实现里每个 socket 的 close handler 都 setTimeout 一轮新的 connectLoop，
    // 而 app.js 的令牌恢复逻辑（maybeRecoverOnebot）又会调 reconnect() 开另一轮。
    // 两轮循环并发后：一轮拿着正确令牌连上了（connected=true、UI 显示正常），
    // 另一轮还攥着被 401 拒过的旧令牌每 30 秒撞一次门 —— SnowLuma 日志里就是
    // 一片成对出现的 "rejected unauthorized WebSocket upgrade"，且**永远不停**，
    // 因为 401 的 error 事件在 everConnected=true 时不再广播状态，没人去杀它。
    // 互斥做法：循环入口记录"代际号"；新一轮开始时把旧代际作废，旧循环的
    // 定时器醒来后发现代际不匹配就自行退出，不再创建 socket。
    const generation = ++this.#connectGeneration;
    this.#scheduleConnect(generation, 0);
  }

  #scheduleConnect(generation, delayMs) {
    if (this.#closedByUs) return;
    if (generation !== this.#connectGeneration) return;   // 已有更新的循环接管
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.#reconnectTimer = null;
        this.#scheduleConnect(generation, 0);
      }, delayMs);
      this.#reconnectTimer = timer;
      return;
    }
    this.#openSocket(generation);
  }

  #openSocket(generation) {
    if (this.#closedByUs) return;
    if (generation !== this.#connectGeneration) return;
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}
      });
    } catch (error) {
      this.lastConnectError = String(error?.message ?? error);
      this.#setStatus(false);
      // 指数退避：连续构造失败时间隔翻倍，封顶 RECONNECT_MAX_MS ——
      // 曾经固定 RECONNECT_MIN_MS（3 秒一次重试风暴，RECONNECT_MAX_MS 形同虚设）
      this.#failedAttempts++;
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (this.#failedAttempts - 1));
      this.#scheduleConnect(generation, delay);
      return;
    }
    // 创建成功即接管"当前 socket"：更早的 socket（若有）全部作废。
    const stale = this.socket;
    this.socket = socket;
    if (stale && stale !== socket) {
      try { stale.removeAllListeners(); } catch { /* ignore */ }
      try { stale.close(); } catch { /* ignore */ }
    }
    // 每个 socket 的事件处理器都先验证"我还是不是当前 socket"，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.#failedAttempts = 0;   // 连上了，退避计数清零
      this.#setStatus(true);
      try {
        this.selfInfo = await this.call('get_login_info');
      } catch (error) {
        console.error('[onebot] 获取登录信息失败:', error?.message ?? error);
        // get_login_info 失败不代表连接不可用（可能是 SnowLuma 还在启动中）。
        // 挂一个延迟补拉：连着但 selfInfo 一直空 → /api/status 的 self 恒为 null，
        // UI 就"检测不到账号信息"（2026-09-19 排障记录）。
        this.#refreshSelfInfoLater();
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event !== 'object') return;
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      this.#setStatus(false);
      if (!this.#closedByUs) {
        // 指数退避：长断线时 3 秒一次的重试风暴既刷屏又占资源；
        // 连接成功过一次就重置计数。
        this.#failedAttempts++;
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** (this.#failedAttempts - 1));
        this.#scheduleConnect(generation, delay);
      }
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = String(error?.message ?? error);
      // ⚠️ 广播状态不能只看 everConnected（2026-09-19）：曾经"连上过一次就不再广播
      // 失败状态"，导致长连接断开后的持续 401 在 UI 上毫无感知（状态一直是"已连接"），
      // 令牌轮换的恢复钩子也收不到信号。现在每次 error 都广播，由监听方自行去重。
      this.#setStatus(false);
    });
  }

  /** 连接活着但 selfInfo 为空时，定期补拉 get_login_info（SnowLuma 慢启动场景）。 */
  #refreshSelfInfoLater() {
    if (this.#selfInfoTimer) return;
    const timer = setTimeout(async () => {
      this.#selfInfoTimer = null;
      if (!this.connected || this.selfInfo) return;
      try {
        this.selfInfo = await this.call('get_login_info');
        if (this.selfInfo) this.#setStatus(true);   // 触发一次状态广播，UI 拿到账号信息
      } catch { /* 还没就绪就等下一轮事件驱动；下一条消息到达时 open 流程不会再补 —— 靠这个定时器最多再试一次 */ }
    }, SELF_INFO_RETRY_MS);
    this.#selfInfoTimer = timer;
  }

  close() {
    this.#closedByUs = true;
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null; }
    if (this.#selfInfoTimer) { clearTimeout(this.#selfInfoTimer); this.#selfInfoTimer = null; }
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action, params = {}, timeoutMs = null) {
    // ── 超时按 action 分档（这里修过一个真实故障）──────────────────────────
    // 原来一律 15 秒。查询类够用，但**发送类不够**：图片/视频以 base64 或大 body
    // 发出去时，协议端要走完「接收 body → 解码 → 上传腾讯服务器 → 返回」，
    // 实测 1.9MB 的图稳定超时、1.5MB 有时能过 —— 表现就是"图画出来了但发不出去"。
    // 而超时抛的是 `fetch failed`（真因在 cause 里），用户完全看不懂。
    // 发送是不幂等但"重试代价低"的操作，宁可多等，也不要误判失败。
    const limit = timeoutMs ?? (SLOW_ACTION.test(action) ? SEND_TIMEOUT_MS : CALL_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${this.httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(limit)
      });
    } catch (error) {
      // fetch 只在网络层失败时抛，且 message 恒为 "fetch failed" —— 丢给上层
      // 只会得到一句没法排查的话。这里把 cause 链挖出来再抛。
      const cause = describeCause(error);
      const aborted = /timeout|abort/i.test(cause) || error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new Error(aborted
        ? `OneBot ${action} 超时（${Math.round(limit / 1000)} 秒未完成）：${cause}`
        : `OneBot ${action} 请求失败：${cause}`);
    }
    if (!res.ok) {
      const hint = res.status === 426
        ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口，请检查 snowluma.httpUrl 是否为 OneBot HTTP API 地址）'
        : '';
      throw new Error(`OneBot ${action} HTTP ${res.status}${hint}`);
    }
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'ok' && body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
    }
    return body.data;
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : '';
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /** 发送消息段。返回 OneBot 响应 data（含 message_id）。 */
  async sendSegments(kind, id, segments) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params);
  }

  /**
   * reply/at 前置段的公共构造（sendText / sendSticker / sendImage 三处共用）。
   *
   * 抽出来之前是三段逐行相同的复制粘贴 —— 任何一处单独改校验规则，
   * 另外两处就会悄悄漂移（历史教训：sendText 修过"消息 id 可为负数"，
   * 另外两处当时各带着同样的旧正则）。这里统一三个约定：
   *   · replyToMessageId：非零整数（消息 id 可为负数；空串=不引用）
   *   · atUserId：正整数 QQ 号，禁止 "all"（全体成员用 CQ 码自己拼，不经此路径）
   */
  static #replyAtSegments({ replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    return segments;
  }

  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = OneBotClient.#replyAtSegments({ replyToMessageId, atUserId });
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments);
  }

  async sendSticker(kind, id, imageUrl, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = OneBotClient.#replyAtSegments({ replyToMessageId, atUserId });
    segments.push({ type: 'image', data: { file: String(imageUrl) } });
    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发送一张图片（独立气泡）。
   *
   * fileRef 支持三种形态，交给 OneBot 自己解释：
   *   · base64://<b64>  —— 本地已下载好的图（send_image 走这条）
   *   · http(s)://...   —— 远端图片地址（已收藏的表情走这条）
   *   · 本地绝对路径     —— 不推荐（会把宿主路径暴露给协议端）
   *
   * 段结构与 sendSticker 完全一样（都是 image 段），区别只是语义：
   * 那个是"发表情"，这个是"发一张图"。所以复用同一套 reply/at 处理。
   */
  async sendImage(kind, id, fileRef, { replyToMessageId = null, atUserId = null } = {}) {
    const ref = String(fileRef ?? '').trim();
    if (!ref) throw new Error('图片内容为空');
    const segments = OneBotClient.#replyAtSegments({ replyToMessageId, atUserId });
    segments.push({ type: 'image', data: { file: ref } });
    return this.sendSegments(kind, id, segments);
  }

  async sendPoke(kind, id, targetUserId) {
    if (kind === 'private') {
      return this.call('friend_poke', { user_id: Number(id) }).catch(() =>
        this.call('send_poke', { user_id: Number(id) }));
    }
    return this.call('group_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }).catch(() =>
      this.call('send_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }));
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

export function forwardIdFromData(d) {
  const raw = d?.id ?? d?.res_id ?? d?.forward_id ?? d?.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveReply: async (mid) => { sender, text } | null —— 解析引用原文。
 * resolveAtName: async (qq) => string | null —— 把 @ 的 QQ 号解析成群名片。
 * onAt: ({ qq, text }) => void —— @ 段收集器（2026-09-26）：文本包含匹配无法
 *   区分"同名不同人"，档位判定必须拿 @ 段里的 QQ 号说话；text 是渲染进正文的
 *   原片段（可能带 speaker-identity 的 (QQ:xxx) 后缀），关键词判定据此剔除。
 * onebot: OneBot 客户端，仅语音转写需要（`media.transcribe` 取语音文件用）；
 *         不传则语音保持 `[语音]` 占位。
 */
export async function segmentsToText(segments, { resolveReply = null, resolveAtName = null, includeReply = true, onebot = null, onAt = null } = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
          try { onAt?.({ qq: 'all', text: '@全体成员' }); } catch { /* 收集器不阻断渲染 */ }
        } else {
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          const base = name ? `@${name}` : `@${d.qq}`;
          // 正文 @ 规范化走 `message.inline-at-normalize` 能力（speaker-identity Skill 提供）：
          // 把 @昵称 补成 @昵称(QQ:xxx)，让模型能区分"同名不同人"。
          // 这里天然同时握有 QQ 号与解析出的名字，是最合适的接入点。
          const rendered = normalizeInlineAt(base, String(d.qq), name) ?? base;
          out.push(rendered);
          try { onAt?.({ qq: String(d.qq), text: rendered }); } catch { /* 收集器不阻断渲染 */ }
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': {
        // 语音转文字走 `media.transcribe` 能力（speech-to-text 插件提供）。
        // 只在主消息路径转写（onebot 由调用方传入）：转发链里逐条跑 whisper
        // 会把 ingest 串行阻塞住，代价不划算，那里保持占位符。
        const spoken = onebot ? await transcribeVoice(d, onebot) : null;
        out.push(spoken ? `[语音转文字] ${spoken}` : '[语音]');
        break;
      }
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              // 引用者名字带 QQ 号（与发言人标签同口径）：有 id 才拼，解析不到就不编造
              const senderLabel = info.senderId
                ? `${info.sender}(QQ:${info.senderId})`
                : info.sender;
              const parts = [];
              if (senderLabel) parts.push(senderLabel);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch { /* 解析失败降级 */ }
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      case 'forward': {
        // 不带 res_id：那个 id 会过期（payload is empty），打出来只会误导模型拿它当参数。
        // 模型要看内容用 read_forward 工具 + 消息前的 #数字。
        out.push('[合并转发聊天记录]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return sanitizeUserText(out.join('').trim());
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'video') {
      // 视频段：提取文件定位信息（供 read_video 工具读取）
      media.push({ kind: 'video', file: String(d.file ?? ''), url: String(d.url ?? ''), path: String(d.path ?? '') });
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: String(d.id ?? '') });
    }
  }
  return media;
}

/**
 * 展开合并转发节点为可读文本（纯函数，便于测试）。
 *
 * 背景：OneBot 事件里的 forward 段只有一个 res_id 占位符，
 * 需要 get_forward_msg 拿回节点数组（本函数处理的就是这个数组）。
 * 实测 NapCat：{ message_id } 可用；res_id 会过期（payload is empty），别依赖。
 *
 * 规则：
 *   - 每个节点一行「昵称: 内容」，内容复用 segmentsToText（@/图片/表情等占位一致）
 *   - 嵌套转发不再展开（深度 1 封顶，套娃截断）
 *   - 封顶：maxNodes 条 / maxChars 字符，超出注明"还有 N 条未展开"
 *   - 节点里的图片段同时提取到 media（url 新鲜，可用于取图/金句）
 *
 * @param {Array} nodes get_forward_msg 返回的 messages 数组
 * @returns {{ text: string, media: Array } | null} 无可用节点返回 null
 */
export async function expandForwardNodes(nodes, { maxNodes = 30, maxChars = 3000 } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const lines = [];
  const media = [];
  let truncated = 0;

  for (let i = 0; i < nodes.length; i++) {
    if (lines.length >= maxNodes) { truncated = nodes.length - i; break; }
    const n = nodes[i] || {};
    // 发言人带 QQ 号（与主历史同口径）：转发记录里的人也要能被稳定识别
    const rawName = String(n.sender?.card || n.sender?.nickname || n.user_id || '?');
    const nid = String(n.sender?.user_id ?? n.user_id ?? '').trim();
    const name = nid && nid !== rawName ? `${rawName}(QQ:${nid})` : rawName;
    const nm = n.message ?? n.content;
    let body = '';
    if (typeof nm === 'string') {
      // 字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 段保留纯文本
      body = nm.replace(/\[CQ:[^\]]*\]/g, '').trim();
    } else if (Array.isArray(nm)) {
      // 嵌套 forward 段清空 data → segmentsToText 输出 [转发消息] 占位（深度 1 封顶）
      const segs = nm.map((s) => (s?.type === 'forward' ? { type: 'forward', data: {} } : s));
      body = await segmentsToText(segs, {});
      media.push(...extractMediaFromSegments(segs));
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!body) continue;
    lines.push(`${name}: ${body}`);
    if (lines.join('\n').length > maxChars) { truncated = nodes.length - i - 1; break; }
  }

  const head = `[合并转发 共${nodes.length}条]`;
  if (!lines.length) return { text: head, media };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media };
}
