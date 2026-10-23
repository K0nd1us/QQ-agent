import { OneBotTransport } from './onebot.js';
import { QQBotClient } from './qqbot.js';

export const CONNECTION_DEFAULTS = {
  enabled: false,
  type: 'onebot',
  onebot: {
    mode: 'forward', apiTransport: 'ws', wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000', reversePath: '/onebot/v11/ws',
    accessToken: '', httpAccessToken: ''
  },
  qqbot: { appId: '', appSecret: '', sandbox: false, intents: (1 << 25) | (1 << 30) }
};

export function connectionConfig(config) {
  const legacy = config.snowluma || {};
  const explicit = config.connection;
  const source = explicit || {
    enabled: Boolean(legacy.accessToken || legacy.httpAccessToken), type: 'onebot',
    onebot: { ...legacy, mode: 'forward', apiTransport: 'http' }
  };
  const result = {
    ...CONNECTION_DEFAULTS, ...source,
    onebot: { ...CONNECTION_DEFAULTS.onebot, ...source.onebot },
    qqbot: { ...CONNECTION_DEFAULTS.qqbot, ...source.qqbot }
  };
  validateConnection(result);
  return result;
}

export function validateConnection(config) {
  if (typeof config.enabled !== 'boolean') throw new Error('connection.enabled must be boolean');
  if (!['onebot', 'qqbot'].includes(config.type)) throw new Error('Unsupported connection type');
  const ob = config.onebot;
  if (!['forward', 'reverse'].includes(ob.mode)) throw new Error('Unsupported OneBot mode');
  if (!['ws', 'http'].includes(ob.apiTransport)) throw new Error('Unsupported OneBot API transport');
  for (const [value, protocols] of [[ob.wsUrl, ['ws:', 'wss:']], [ob.httpUrl, ['http:', 'https:']]]) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid OneBot URL'); }
    if (!protocols.includes(url.protocol) || url.username || url.password) throw new Error('Invalid OneBot URL');
  }
  if (!/^\/[A-Za-z0-9/_-]+$/.test(ob.reversePath) || ob.reversePath.startsWith('/api/')) throw new Error('Invalid reverse WebSocket path');
  if (config.enabled && config.type === 'onebot' && ob.mode === 'reverse' && !ob.accessToken) throw new Error('Reverse WebSocket requires an access token');
  const qq = config.qqbot;
  if (!Number.isSafeInteger(qq.intents) || qq.intents < 1 || qq.intents > 0xffffffff) throw new Error('Invalid QQBot intents');
  if (config.enabled && config.type === 'qqbot' && (!qq.appId || !qq.appSecret)) throw new Error('QQBot requires AppID and AppSecret');
}

// Consumers retain one reference while the module replaces the underlying transport.
export class BotConnection {
  constructor({ config, server, onEvent }) {
    this.server = server;
    this.onEvent = onEvent;
    this.listeners = new Set();
    this.configure(config);
  }
  configure(config) {
    validateConnection(config);
    this.unsubscribe?.();
    this.client?.close();
    this.config = structuredClone(config);
    const source = config[config.type];
    const keys = config.type === 'qqbot'
      ? ['appId', 'appSecret', 'sandbox', 'intents']
      : ['mode', 'apiTransport', 'wsUrl', 'httpUrl', 'reversePath', 'accessToken', 'httpAccessToken'];
    const options = Object.fromEntries(keys.map(key => [key, source[key]]));
    this.client = config.type === 'qqbot'
      ? new QQBotClient({ ...options, onEvent: this.onEvent })
      : new OneBotTransport({ ...options, server: this.server, onEvent: this.onEvent });
    this.unsubscribe = this.client.onStatus(status => {
      for (const fn of this.listeners) { try { fn({ ...status, type: this.type }); } catch { /* observer isolation */ } }
    });
  }
  onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async connect() { if (this.config.enabled) await this.client.connect(); }
  async reconnect() { this.configure(this.config); await this.connect(); }
  close() { this.client.close(); }
  get connected() { return this.client.connected; }
  get everConnected() { return this.client.everConnected; }
  get lastConnectError() { return this.client.lastConnectError; }
  get selfInfo() { return this.client.selfInfo; }
  set selfInfo(value) { this.client.selfInfo = value; }
  get selfId() { return this.client.selfId; }
  get selfNickname() { return this.client.selfNickname; }
  get type() { return this.config.type; }
  get httpUrl() { return this.client.httpUrl; }
  set httpUrl(value) { this.client.httpUrl = value; }
  get wsUrl() { return this.client.wsUrl; }
  set wsUrl(value) { this.client.wsUrl = value; }
  get accessToken() { return this.client.accessToken; }
  set accessToken(value) { this.client.accessToken = value; }
  get httpToken() { return this.client.httpToken; }
  set httpToken(value) { this.client.httpToken = value; }
  invoke(method, args) {
    if (!this.config.enabled) return Promise.reject(new Error('协议接入未启用'));
    return this.client[method](...args);
  }
  call(...args) { return this.invoke('call', args); }
  sendSegments(...args) { return this.invoke('sendSegments', args); }
  sendText(...args) { return this.invoke('sendText', args); }
  sendSticker(...args) { return this.invoke('sendSticker', args); }
  sendImage(...args) { return this.invoke('sendImage', args); }
  sendPoke(...args) { return this.invoke('sendPoke', args); }
  getMsg(...args) { return this.invoke('getMsg', args); }
  getGroupInfo(...args) { return this.invoke('getGroupInfo', args); }
  getGroupMemberInfo(...args) { return this.invoke('getGroupMemberInfo', args); }
}
