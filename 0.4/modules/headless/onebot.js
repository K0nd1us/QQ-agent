// Optional transport. Reuse the core's message helpers without replacing its desktop client.
import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { OneBotClient } from '../../src/onebot.js';

export class OneBotTransport extends OneBotClient {
  constructor(options = {}) {
    super({ ...options, httpToken: options.httpAccessToken || options.httpToken || options.accessToken });
    this.mode = options.mode || 'forward';
    this.apiTransport = options.apiTransport || 'ws';
    this.reversePath = options.reversePath || '/onebot/v11/ws';
    this.server = options.server;
    this.pending = new Map();
    this.generation = 0;
    this.stopped = true;
    this.failures = 0;
  }

  status(connected, error = '') {
    this.connected = connected;
    this.lastConnectError = error;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error }); } catch { /* observer isolation */ }
    }
  }

  async connect() {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    if (this.mode === 'reverse') this.listenReverse(generation);
    else this.open(generation);
  }

  async reconnect() {
    this.close();
    await this.connect();
  }

  listenReverse(generation) {
    if (!this.server) throw new Error('Reverse OneBot requires an HTTP server');
    if (!this.accessToken) throw new Error('Reverse OneBot requires an access token');
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.upgrade = (req, socket, head) => {
      const reject = code => socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return reject('400 Bad Request'); }
      if (url.pathname !== this.reversePath) return reject('404 Not Found');
      const bearer = String(req.headers.authorization || '').replace(/^Bearer /i, '');
      const actual = Buffer.from(bearer || url.searchParams.get('access_token') || '');
      const expected = Buffer.from(this.accessToken);
      if (String(req.headers['x-client-role'] || 'Universal').toLowerCase() !== 'universal'
          || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return reject('401 Unauthorized');
      }
      if (this.socket) return reject('409 Conflict');
      try {
        this.wss.handleUpgrade(req, socket, head, ws => this.bind(ws, generation, true));
      } catch { socket.destroy(); }
    };
    this.server.on('upgrade', this.upgrade);
  }

  open(generation) {
    if (this.stopped || generation !== this.generation) return;
    try {
      const ws = new WebSocket(this.wsUrl, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {},
        handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024
      });
      this.bind(ws, generation);
    } catch {
      this.status(false, 'OneBot WebSocket connection failed');
      this.retry(generation);
    }
  }

  retry(generation) {
    if (this.stopped || generation !== this.generation || this.mode === 'reverse') return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(30000, 3000 * 2 ** Math.min(4, this.failures++));
    this.retryTimer = setTimeout(() => this.open(generation), delay);
  }

  bind(ws, generation, alreadyOpen = false) {
    this.socket = ws;
    const current = () => !this.stopped && generation === this.generation && this.socket === ws;
    let alive = true;
    ws.on('pong', () => { alive = true; });
    this.pingTimer = setInterval(() => {
      if (!current() || ws.readyState !== WebSocket.OPEN) return;
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30000);
    const refreshSelf = async () => {
      try {
        const info = await this.call('get_login_info');
        if (!current()) return;
        this.selfInfo = info;
        this.status(true);
      } catch {
        if (current()) this.selfTimer = setTimeout(refreshSelf, 15000);
      }
    };
    const opened = () => {
      if (!current()) return;
      this.failures = 0;
      this.status(true);
      void refreshSelf();
    };
    ws.on('open', opened);
    ws.on('message', raw => {
      if (!current()) return;
      let packet;
      try { packet = JSON.parse(String(raw)); } catch { return; }
      if (!packet || typeof packet !== 'object') return;
      const pending = Object.hasOwn(packet, 'echo') && this.pending.get(String(packet.echo));
      if (pending) {
        this.pending.delete(String(packet.echo));
        clearTimeout(pending.timer);
        if (packet.retcode === 0 && packet.status === 'ok') pending.resolve(packet.data);
        else pending.reject(new Error(`OneBot ${pending.action} failed: retcode=${packet.retcode}`));
        return;
      }
      if (!packet.post_type) return;
      try { this.onEvent(packet); } catch { /* malformed event must not close the transport */ }
    });
    ws.on('error', () => { if (current()) this.status(false, 'OneBot WebSocket connection failed'); });
    ws.on('close', () => {
      if (!current()) return;
      clearInterval(this.pingTimer);
      clearTimeout(this.selfTimer);
      this.socket = null;
      this.selfInfo = null;
      this.rejectPending();
      this.status(false);
      this.retry(generation);
    });
    if (alreadyOpen) opened();
  }

  rejectPending() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('OneBot connection closed; send outcome may be unknown; do not resend automatically'));
    }
    this.pending.clear();
  }

  close() {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.retryTimer);
    clearTimeout(this.selfTimer);
    clearInterval(this.pingTimer);
    if (this.upgrade) this.server?.off('upgrade', this.upgrade);
    this.upgrade = null;
    this.wss?.close();
    this.wss = null;
    const ws = this.socket;
    this.socket = null;
    ws?.terminate();
    this.selfInfo = null;
    this.rejectPending();
    this.status(false);
  }

  async call(action, params = {}, timeoutMs) {
    const limit = timeoutMs ?? (/^(send_(group|private)|upload_|_send)/i.test(action) ? 90000 : 15000);
    if (this.mode === 'reverse' || this.apiTransport === 'ws') {
      if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('OneBot WebSocket is not connected');
      const echo = randomUUID();
      return new Promise((resolve, reject) => {
        const fail = error => {
          if (!this.pending.delete(echo)) return;
          clearTimeout(timer);
          reject(error);
        };
        const timer = setTimeout(() => fail(new Error(`OneBot ${action} timed out; outcome may be unknown`)), limit);
        this.pending.set(echo, { resolve, reject, timer, action });
        try {
          this.socket.send(JSON.stringify({ action, params, echo }), error => { if (error) fail(error); });
        } catch (error) { fail(error); }
      });
    }
    const response = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST', headers: {
        'content-type': 'application/json',
        ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
      },
      body: JSON.stringify(params), signal: AbortSignal.timeout(limit)
    });
    if (!response.ok) throw new Error(`OneBot ${action} HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== 'ok' || body.retcode !== 0) throw new Error(`OneBot ${action} failed: retcode=${body.retcode}`);
    return body.data;
  }
}
