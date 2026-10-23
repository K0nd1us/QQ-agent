// QQ official gateway adapter. Wire schema is based on tencent-connect/botgo and bot-docs.
import WebSocket from 'ws';
import { OneBotClient } from '../../src/onebot.js';

const safeId = value => {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('QQBot 返回了无效的 ID');
  return id;
};
const remember = (map, key, value, limit = 1000) => {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
};

export class QQBotClient extends OneBotClient {
  constructor({ appId, appSecret, sandbox = false, intents, onEvent, fetchImpl = fetch, reconnectMs = 3000, apiBase, tokenUrl }) {
    super({ onEvent });
    this.appId = String(appId || '');
    this.appSecret = String(appSecret || '');
    this.intents = intents;
    // Endpoint injection is for local protocol fixtures only; not user-controlled config.
    this.apiBase = apiBase || (sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com');
    this.tokenUrl = tokenUrl || 'https://bots.qq.com/app/getAppAccessToken';
    this.fetchImpl = fetchImpl;
    this.reconnectMs = reconnectMs;
    this.generation = 0;
    this.stopped = true;
    this.anchors = new Map();
    this.messages = new Map();
    this.seen = new Map();
    this.groups = new Map();
    this.friends = new Map();
  }
  status(connected, error = '') {
    this.connected = connected;
    this.lastConnectError = error;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) { try { fn({ connected, everConnected: this.everConnected, error }); } catch {} }
  }
  async token() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    if (!this.tokenPromise) this.tokenPromise = (async () => {
      if (!this.appId || !this.appSecret) throw new Error('缺少 QQBot AppID / AppSecret');
      const response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
        signal: AbortSignal.timeout(15000)
      });
      const data = await response.json();
      if (!response.ok || !data.access_token) throw new Error(`QQBot 获取凭证失败：HTTP ${response.status}，code=${data.code || 'unknown'}`);
      this.accessToken = data.access_token;
      this.tokenExpiresAt = Date.now() + Math.max(1, Number(data.expires_in) - 60) * 1000;
      return this.accessToken;
    })().finally(() => { this.tokenPromise = null; });
    return this.tokenPromise;
  }
  async request(route, body, method = 'POST') {
    const token = await this.token();
    const response = await this.fetchImpl(`${this.apiBase}${route}`, {
      method, headers: { authorization: `QQBot ${token}`, 'X-Union-Appid': this.appId, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000)
    });
    const data = await response.json();
    if (!response.ok || data.code) {
      if (response.status === 401) this.tokenExpiresAt = 0;
      // Never retry message POSTs: the remote result may be unknown.
      throw new Error(`QQBot ${method} ${route} 失败：HTTP ${response.status}，code=${data.code || 'unknown'}`);
    }
    return data;
  }
  async connect() {
    this.stopped = false;
    const generation = ++this.generation;
    void this.open(generation);
  }
  async reconnect() { this.close(); await this.connect(); }
  async open(generation) {
    try {
      await this.token();
      const gateway = await this.request('/gateway/bot', undefined, 'GET');
      if (this.stopped || generation !== this.generation) return;
      const url = new URL(gateway.url);
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('QQBot 网关地址无效');
      const ws = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024 });
      this.socket = ws;
      this.acked = true;
      const current = () => !this.stopped && generation === this.generation && this.socket === ws;
      const send = (op, d) => { if (current() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d })); };
      const heartbeat = () => {
        if (!this.acked) { ws.terminate(); return; }
        this.acked = false;
        send(1, this.sequence ?? null);
      };
      // Hello + READY must arrive; a TCP connection alone is not ready.
      this.readyTimer = setTimeout(() => { if (current() && !this.connected) ws.terminate(); }, 20000);
      ws.on('message', async raw => {
        if (!current()) return;
        let packet;
        try { packet = JSON.parse(String(raw)); } catch { return; }
        if (packet.s !== undefined && packet.s !== null) this.sequence = packet.s;
        if (packet.op === 10) {
          clearInterval(this.heartbeatTimer);
          const interval = Number(packet.d?.heartbeat_interval);
          if (!(interval > 0)) { ws.terminate(); return; }
          this.heartbeatTimer = setInterval(heartbeat, interval);
          try {
            const accessToken = await this.token();
            if (!current()) return;
            if (this.sessionId) send(6, { token: accessToken, session_id: this.sessionId, seq: this.sequence });
            else send(2, { token: `QQBot ${accessToken}`, intents: this.intents, shard: [0, 1], properties: { '$os': process.platform, '$browser': 'qq-agent', '$device': 'qq-agent' } });
          } catch { ws.terminate(); }
        } else if (packet.op === 11) this.acked = true;
        else if (packet.op === 1) send(1, this.sequence ?? null);
        else if (packet.op === 7) ws.close();
        else if (packet.op === 9) {
          if (!packet.d) { this.sessionId = null; this.sequence = null; }
          ws.close();
        } else if (packet.op === 0) {
          if (packet.t === 'READY') {
            this.sessionId = packet.d.session_id;
            this.selfInfo = { user_id: packet.d.user?.id || this.appId, nickname: packet.d.user?.username || 'QQBot' };
            clearTimeout(this.readyTimer);
            this.failures = 0; this.status(true);
          } else if (packet.t === 'RESUMED') { clearTimeout(this.readyTimer); this.failures = 0; this.status(true); }
          else {
            try { this.dispatch(packet.t, packet.d); }
            catch { this.status(this.connected, 'QQBot 事件格式无效'); }
          }
        }
      });
      ws.on('error', () => { if (current()) this.status(false, 'QQBot WebSocket 连接失败，请检查网络、IP 白名单及通道权限'); });
      ws.on('close', code => {
        if (!current()) return;
        clearInterval(this.heartbeatTimer); clearTimeout(this.readyTimer);
        this.socket = null;
        if ([4006, 4007, 4009].includes(code)) { this.sessionId = null; this.sequence = null; }
        if (code === 4004) this.tokenExpiresAt = 0;
        this.status(false, `QQBot 网关已断开（${code}），等待重连`);
        this.retry(generation);
      });
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.status(false, error.message);
      this.retry(generation);
    }
  }
  retry(generation) {
    if (this.stopped || generation !== this.generation) return;
    clearTimeout(this.retryTimer);
    this.failures = (this.failures || 0) + 1;
    this.retryTimer = setTimeout(() => void this.open(generation), Math.min(30000, this.reconnectMs * 2 ** Math.min(4, this.failures - 1)));
  }
  close() {
    this.stopped = true; ++this.generation;
    clearTimeout(this.retryTimer); clearTimeout(this.readyTimer); clearInterval(this.heartbeatTimer);
    this.socket?.terminate(); this.socket = null;
    this.status(false);
  }
  dispatch(type, data) {
    const modes = { GROUP_AT_MESSAGE_CREATE: ['group', 'group', data.group_openid], C2C_MESSAGE_CREATE: ['private', 'user', data.author?.user_openid], AT_MESSAGE_CREATE: ['group', 'channel', data.channel_id], MESSAGE_CREATE: ['group', 'channel', data.channel_id], DIRECT_MESSAGE_CREATE: ['private', 'dm', data.guild_id] };
    const mode = modes[type];
    if (!mode) return;
    const [kind, scope, openid] = mode;
    const id = `qqbot_${scope}_${safeId(openid)}`;
    const mid = String(data.id || '');
    if (!mid || this.seen.has(mid)) return;
    remember(this.seen, mid, true, 3000);
    this.failures = 0;
    const userId = safeId(data.author?.member_openid || data.author?.user_openid || data.author?.id);
    const content = String(data.content || '').replace(new RegExp(`<@!?${this.selfId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'g'), '').trim();
    const segments = [];
    if (type.includes('AT_MESSAGE')) segments.push({ type: 'at', data: { qq: this.selfId } });
    segments.push({ type: 'text', data: { text: content } });
    for (const attachment of data.attachments || []) {
      if (/^image\//.test(attachment.content_type)) segments.push({ type: 'image', data: { url: String(attachment.url).startsWith('//') ? `https:${attachment.url}` : attachment.url } });
    }
    const event = { post_type: 'message', message_type: kind, self_id: this.selfId, user_id: kind === 'private' ? id : userId, group_id: kind === 'group' ? id : undefined, message_id: mid, time: Date.parse(data.timestamp) / 1000 || Date.now() / 1000, sender: { user_id: userId, nickname: data.author?.username || userId }, message: segments };
    // Group/C2C replies require an unexpired received msg_id; no active push fallback.
    remember(this.anchors, mid, { mid, id, kind, scope, openid: String(openid), receivedAt: Date.now(), seq: 0 });
    remember(this.messages, mid, event);
    remember(kind === 'group' ? this.groups : this.friends, id, id, 500);
    this.onEvent(event);
  }
  target(kind, id, replyToMessageId) {
    const match = /^qqbot_(group|user|channel|dm)_([A-Za-z0-9_-]+)$/.exec(String(id));
    if (!match || (kind === 'group') !== ['group', 'channel'].includes(match[1])) throw new Error('QQBot 会话 ID 无效，请使用连接页显示的完整 ID');
    let anchor;
    if (replyToMessageId) anchor = this.anchors.get(String(replyToMessageId));
    else anchor = [...this.anchors.values()].reverse().find(a => a.id === id && a.kind === kind);
    if (!anchor || anchor.id !== id || anchor.kind !== kind) throw new Error('QQBot 缺少本会话的回复上下文，请先向机器人发消息');
    const ttl = anchor.scope === 'user' ? 3600000 : 300000;
    if (Date.now() - anchor.receivedAt > ttl) throw new Error('QQBot 被动回复窗口已过期，请先向机器人发新消息');
    if (['group', 'user'].includes(anchor.scope) && anchor.seq >= 5) throw new Error('QQBot 此消息的回复次数已达 5 次');
    const path = anchor.scope === 'group' ? `/v2/groups/${anchor.openid}` : anchor.scope === 'user' ? `/v2/users/${anchor.openid}` : anchor.scope === 'channel' ? `/channels/${anchor.openid}` : `/dms/${anchor.openid}`;
    return { anchor, path };
  }
  async sendText(kind, id, text, options = {}) {
    if (options.atUserId) throw new Error('QQBot 此适配器不支持指定 @，请发送普通回复');
    const { anchor, path } = this.target(kind, id, options.replyToMessageId);
    const msg_seq = ++anchor.seq;
    const data = await this.request(`${path}/messages`, { content: String(text), msg_id: anchor.mid, ...(['group','user'].includes(anchor.scope) ? { msg_type: 0, msg_seq } : {}) });
    return { message_id: data.id };
  }
  async sendImage(kind, id, url, options = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error('QQBot 官方媒体接口需要公网 HTTP(S) 图片 URL，不支持本地文件或 base64');
    const { anchor, path } = this.target(kind, id, options.replyToMessageId);
    if (!['group', 'user'].includes(anchor.scope)) throw new Error('QQBot 频道图片发送尚不支持');
    if (options.atUserId) throw new Error('QQBot 此适配器不支持指定 @');
    const msg_seq = ++anchor.seq;
    const uploaded = await this.request(`${path}/files`, { file_type: 1, url, srv_send_msg: false });
    const data = await this.request(`${path}/messages`, { content: ' ', msg_type: 7, media: { file_info: uploaded.file_info }, msg_id: anchor.mid, msg_seq });
    return { message_id: data.id };
  }
  sendSticker(...args) { return this.sendImage(...args); }
  sendSegments(kind, id, segments) {
    if (segments.some(s => s.type !== 'text')) throw new Error('QQBot 不支持此消息段组合');
    return this.sendText(kind, id, segments.map(s => s.data.text).join(''));
  }
  async sendPoke() { throw new Error('官方 QQBot 不支持拍一拍'); }
  async getMsg(id) { return this.messages.get(String(id)) || null; }
  async getGroupInfo(id) { return { group_id: id, group_name: this.groups.get(id) || id }; }
  async getGroupMemberInfo(groupId, id) { return { user_id: id, nickname: id }; }
  async call(action, params = {}) {
    if (action === 'get_login_info') return this.selfInfo;
    if (action === 'get_group_list') return [...this.groups].map(([group_id, group_name]) => ({ group_id, group_name }));
    if (action === 'get_friend_list') return [...this.friends].map(([user_id, nickname]) => ({ user_id, nickname }));
    if (action === 'get_group_info') return this.getGroupInfo(params.group_id);
    if (action === 'get_group_member_info') return this.getGroupMemberInfo(params.group_id, params.user_id);
    if (action === 'get_msg') return this.getMsg(params.message_id);
    throw new Error(`官方 QQBot 不支持 OneBot 扩展操作：${action}`);
  }
}
