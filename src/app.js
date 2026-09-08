// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR } from './config.js';
import { customSearch } from './web-search.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes } from './onebot.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { StickerManager } from './sticker-manager.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices, isPeakHour, priceAt, resolveModelPrice, modelLabel, splitModelLabel, UNKNOWN_VENDOR } from './model-prices.js';
import { initPriceFeed, refreshPriceFeed, priceFeedStatus } from './price-feed.js';
import { startTelemetryLoop } from './telemetry.js';
import { importFromDsh, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider } from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { createEventBus, todayKey } from './util.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

// ── 版本更新检查 ─────────────────────────────────────────────────────
// 线上版本信息只有一份：kondius.cn/qq-agent/version.json（发版时手动改）。
// 由后端代取而不是前端直连：绕过 CORS，且失败信息能统一回给 UI。
const UPDATE_INFO_URL = 'https://kondius.cn/qq-agent/version.json';

function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch { return '0.0.0'; }
}

/** x.y.z 三段数字比较；返回 1 / 0 / -1。非数字段按 0 处理，够用。 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set();

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    if (fs.existsSync(bundled)) return bundled;
    // 安装版：asar 里的文件不可执行，electron-builder 会把 snowluma/ 解包到
    // resources/app.asar.unpacked/snowluma（见 package.json asarUnpack）
    const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');
    if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;
    return '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaStopping = false;

  function pushSnowlumaLog(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
    emit('snowluma-log', line);
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭内置启动的 SnowLuma。返回是否执行了关闭动作。 */
  function stopSnowluma() {
    const proc = snowlumaProc;
    if (!proc) return false;
    try {
      proc.kill();
      pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
    } catch (error) {
      pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
      throw error;
    }
    return true;
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行（日志进内置控制台）；失败再回退到独立窗口 launcher.bat。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    const wsPort = snowlumaWsPort();
    if (await isPortOpen('127.0.0.1', wsPort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（端口 ${wsPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    const indexMjs = path.join(dir, 'index.mjs');
    const nodeExe = path.join(dir, 'node.exe');
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      try {
        // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
        // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
        const child = spawn(nodeExe, [indexMjs], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false
        });
        snowlumaProc = child;
        child.unref();
        pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
        child.stdout.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stdout');
          }
        });
        child.stderr.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          snowlumaProc = null;
          pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('snowluma-status', { running: false, embedded: false, pid: null });
        });
        child.on('error', (error) => {
          pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
        snowlumaProc = null;
      }
    }
    // 回退：launcher.bat 独立控制台窗口（老行为，日志无法内置）
    const launcher = path.join(dir, 'launcher.bat');
    if (!fs.existsSync(launcher)) return { ok: false, error: `目录里没有 index.mjs / node.exe，也没有 launcher.bat：${dir}` };
    const child = spawn('cmd.exe', ['/c', launcher], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false // 保留 SnowLuma 自己的控制台窗口
    });
    child.unref();
    pushSnowlumaLog('SnowLuma 已用独立控制台窗口启动（此模式下日志不进内置控制台）', 'stdout');
    return { ok: true, launched: true, embedded: false };
  }

  const emit = (type, payload) => {
    bus.emit(type, payload);
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  const stickers = new StickerManager(onebot);
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`)
  });
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit });

  // 远程价格表：启动即初始化（内部幂等；URL 为空则完全不动）
  initPriceFeed(cfg.api?.priceRemoteUrl || '');

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 给每个登录过的账号生成独立随机 token（config/onebot_<uin>.json），
  // 且**永久保留**——不表示"当前在线"。多账号场景下"取第一个文件"会拿错 token
  // （WS 401 无限重试）。策略改为：收集所有 per-uin 文件的 token 作为候选，
  // 401 时轮换下一个重连，连上后记住生效的那个（天然支持 SnowLuma 里切账号）。
  let lastSyncTokenSig = '';

  /** 从单个配置对象里提取 ws/http token（找不到网络段时返回 null）。 */
  function extractTokens(data) {
    const http = (data?.networks?.httpServers || []).find((s) => (s.port === 3000) || (s.name === 'http-default')) || (data?.networks?.httpServers || [])[0];
    const ws = (data?.networks?.wsServers || []).find((s) => (s.port === 3001) || (s.name === 'ws-default')) || (data?.networks?.wsServers || [])[0];
    return { wsToken: String(ws?.accessToken ?? ''), httpToken: String(http?.accessToken ?? '') };
  }

  /** 收集所有候选 token（含 onebot_0.json 的空令牌兜底），按"当前配置优先"排序。 */
  function readSnowlumaTokenCandidates() {
    const out = [];
    try {
      const dir = snowlumaDir();
      if (!dir) return out;
      const cfgDir = path.join(dir, 'config');
      let files = [];
      try {
        files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
      } catch { /* ignore */ }
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8'));
          out.push(extractTokens(data));
        } catch { /* 单个文件坏了跳过，不影响其他候选 */ }
      }
      // 空令牌兜底：SnowLuma 允许无 token 连接（onebot_0.json 模板就是空）
      out.push({ wsToken: '', httpToken: '' });
    } catch (error) {
      log('[onebot] 读取 SnowLuma OneBot 配置失败:', error?.message ?? error);
    }
    return out;
  }

  /** 候选游标：401 时递增轮换。连上后会钉住当前生效下标。 */
  let tokenCandidateIndex = 0;

  function applyTokens({ wsToken, httpToken }) {
    onebot.accessToken = wsToken;
    onebot.httpToken = httpToken || wsToken;
    const cur = getConfig();
    if (cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== (httpToken || wsToken)) {
      updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken || wsToken } });
      log(`[onebot] 应用 OneBot 访问令牌（WS ${wsToken ? '有' : '无'} / HTTP ${httpToken ? '有' : '无'}）`);
    }
  }

  /** 把候选列表同步进配置 + 挂到 onebot 实例（不立即连接）。返回是否有变化。 */
  function syncSnowlumaTokens() {
    try {
      const candidates = readSnowlumaTokenCandidates();
      if (!candidates.length) return false;
      const sig = candidates.map((c) => `${c.wsToken}|${c.httpToken}`).join(';');
      if (sig === lastSyncTokenSig) return false;
      // 游标重置：候选集变化了，从头开始试
      tokenCandidateIndex = 0;
      applyTokens(candidates[0]);
      onebot.tokenCandidates = candidates;   // 401 轮换用
      lastSyncTokenSig = sig;
      log(`[onebot] 已收集 ${candidates.length} 个 OneBot 令牌候选（SnowLuma 多账号场景 401 时自动轮换）`);
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时：轮换下一个候选 token 重连（3 秒重连循环已有，轮换成本为零）
  let tokenSyncRetryAt = 0;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    // ⚠️ 先重读磁盘：全新安装是"先启动后登录"，候选集是启动时的 [空令牌]；
    // 登录后 per-uin 文件才带着真令牌落盘。不回读就会拿空令牌 401 到天荒地老。
    const refreshed = syncSnowlumaTokens();
    const candidates = onebot.tokenCandidates || [];
    if (!candidates.length) return;
    if (refreshed) {
      // 候选集变了（sig 变化时内部已重置游标并应用候选[0]）→ 直接拿新集合的第一个试
      onebot.reconnect();
      return;
    }
    // 磁盘没变化：指向下一个候选（首次触发也从 0→1 开始换：刚被 401 拒的就是当前这个）
    tokenCandidateIndex = (tokenCandidateIndex + 1) % candidates.length;
    const c = candidates[tokenCandidateIndex];
    applyTokens(c);
    onebot.reconnect();
  }
  onebot.onStatus((status) => {
    if (status.connected) {
      // 连上了：钉住当前候选。下次 401（比如 SnowLuma 里切了账号）再从下一个开始轮
      const cands = onebot.tokenCandidates || [];
      if (cands.length > 1) log('[onebot] 连接成功，当前令牌候选已生效');
      return;
    }
    if (String(status.error || '').includes('401')) maybeRecoverOnebot();
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      return { sender: String(senderName), text: String(text).slice(0, 120) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    if (kind === 'group' && senderId && (cfgNow.blocklist?.[id] || []).map(String).includes(senderId)) return;
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    // 实测结论（2026-09-05，SnowLuma/NapCat）：get_forward_msg 只认 message_id；
    // res_id（转发卡片里那个 id）会过期，报 "payload is empty"。
    // 媒体里的 url 此时是新鲜的，一并收进 media（取图/金句都能用）。
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试。
    if (segments && (text.includes('[合并转发') || text.includes('[转发消息')) && event.message_id != null) {
      try {
        const r = await onebot.call('get_forward_msg', { message_id: Number(event.message_id) });
        const nodes = Array.isArray(r?.messages) ? r.messages : (Array.isArray(r?.data?.messages) ? r.data.messages : []);
        const ex = await expandForwardNodes(nodes);
        if (ex && ex.text) {
          text = ex.text;
          if (ex.media?.length) media.push(...ex.media);
        }
      } catch (e) {
        log(`[ingest] 展开合并转发失败（保留占位符）: ${e?.message ?? e}`);
      }
    }

    if (!text && !media.length) return;
    store.appendIncoming(`${kind}:${id}`, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media
    });
    emit('chat-update', `${kind}:${id}`);
    orchestrator.onIncoming(`${kind}:${id}`);
  }

  async function ingestPoke(event) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）
    if (isGroup && operatorId && (cfgNow.blocklist?.[id] || []).map(String).includes(operatorId)) return;
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"317183522 的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    let text;
    if (String(targetId) === String(selfId)) {
      text = `[拍一拍] 你拍了拍${isGroup ? '' : '你'}（来自 ${operatorName}）`;
    } else {
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
      text = operatorId === targetId ? `[拍一拍] ${operatorName} 拍了拍自己` : `[拍一拍] ${operatorName} 拍了拍 ${targetName}`;
    }
    store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: []
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password …
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|secret|password|privatekey|private_key)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线应当是「校验请求来源」，而不是砍掉本地功能。
   *
   * 放行条件（任一）：
   *   1. 配置了 server.token 且请求带上了它（远程/多用户场景）
   *   2. 请求来自本机控制台：Origin/Referer 指向本服务，或带 x-console-token 头
   */
  function keyEndpointAllowed(req) {
    const token = String(getConfig().server?.token ?? '');
    if (token) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.headers['x-console-token'] === token || url.searchParams.get('token') === token) return true;
    }
    // 带自定义头 → 不可能是简单跨站请求（需 CORS 预检通过才能发出），放行
    if (req.headers['x-console-token']) return true;

    const host = String(req.headers.host ?? '');
    const origin = String(req.headers.origin ?? '');
    const referer = String(req.headers.referer ?? '');
    const isLoopbackHost = /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host);
    if (!isLoopbackHost) return false;
    if (origin) return origin === `http://${host}`;
    if (referer) return referer.startsWith(`http://${host}/`);
    return true;   // 地址栏直连等无来源请求，无法进一步区分
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const cfgNow = getConfig();

      if (pathname === '/api/status' && method === 'GET') {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        // 成本估算：命中官方价走官方价，否则用手填单价
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          snowluma: {
            dir: snowlumaDir(),
            running: await isPortOpen('127.0.0.1', snowlumaWsPort()),
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null
        });
      }

      // ── 成本看板：按天 / 按会话 / 按模型统计 ──
      // range: 'today'=今天0点起 | '24h'=最近24小时 | '3'|'7'|'14'|'30'=最近N天
      if (pathname === '/api/usage/stats' && method === 'GET') {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 某个维度下的明细（点表格行时弹窗用）
      // dim: 'chat' | 'model' | 'day'  key: 对应值  by: 'day' | 'model' | 'chat'
      if (pathname === '/api/usage/breakdown' && method === 'GET') {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/model-prices' && method === 'GET') {
        const model = String(url.searchParams.get('model') || getConfig().api?.model || '');
        return json(res, 200, {
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(model),
          remote: priceFeedStatus()   // 远程价格表状态（设置页展示：来源/时间/条目数/错误）
        });
      }

      // 手动触发一次远程价格表拉取（设置页「立即拉取」按钮）
      if (pathname === '/api/model-prices/refresh' && method === 'POST') {
        const st = await refreshPriceFeed(getConfig().api?.priceRemoteUrl || '');
        return json(res, 200, {
          ok: st.ok,
          remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }

      // ── SnowLuma 进程管理 ──
      if (pathname === '/api/snowluma/launch' && method === 'POST') {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/logs' && method === 'GET') {
        return json(res, 200, { logs: snowlumaLogs.slice(-200) });
      }

      if (pathname === '/api/snowluma/stop' && method === 'POST') {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/open-folder' && method === 'POST') {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/snowluma/open-webui' && method === 'POST') {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }

      // ── 体检/引导相关 ──
      if (pathname === '/api/onebot/groups' && method === 'GET') {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/onebot/friends' && method === 'GET') {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/persona-templates' && method === 'GET') {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`,
          name: p.name,
          text: p.text,
          customRules: p.customRules || '',
          builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }

      // 用户自定义人设：新增 / 删除
      if (pathname === '/api/persona-templates' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        // customRules 允许为空
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }

      const personaDeleteMatch = /^\/api\/persona-templates\/(custom_\d+)$/.exec(pathname);
      if (personaDeleteMatch && method === 'DELETE') {
        const idx = Number(personaDeleteMatch[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }

      // ── 多提供商模型目录 ──
      if (pathname === '/api/providers' && method === 'GET') {
        const providers = currentProviders().map((p) => ({
          id: p.id,
          displayName: p.displayName,
          baseURL: p.baseURL,
          apiKey: '',              // 不把真实 Key 暴露给 UI；有 Key 用 hasKey 表示
          apiKeyFrom: p.apiKeyFrom || '',
          needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey,
          anthropicOrigin: p.anthropicOrigin === true,
          models: p.models,
          modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }

      // 显示目录提供商的真实 Key（本地 UI 点击“显示”用）
      // 明文密钥端点：仅放行本机控制台请求，挡住外部网页冒用（见 keyEndpointAllowed）。
      if (pathname === '/api/providers/key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }

      // 显示顶层 api.apiKey（手动模式、未选目录提供商时用）
      if (pathname === '/api/api-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }

      // 显示某个搜索服务的真实 Key（本地 UI 点击“显示”用）。
      // /api/config 里的搜索 Key 是脱敏的，所以“显示”必须走这里。
      if (pathname === '/api/search-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const field = String(url.searchParams.get('field') || '');
        // 自定义搜索服务的 Key 不走这里（它们存在 webSearch.providers 数组里，
        // 由 /api/search-providers 管理，且添加时是一次性输入，不提供明文回读）。
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        if (!allowed.includes(field)) {
          return json(res, 400, { error: `未知搜索服务：${field}` });
        }
        return json(res, 200, { apiKey: String(getConfig().webSearch?.[field]?.apiKey || '') });
      }

      // 用当前 api 配置拉取模型列表（前端“获取列表”）
      if (pathname === '/api/providers/fetch-models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          const apiKey = body.apiKey !== undefined ? String(body.apiKey ?? '') : String(cfgNow.api.apiKey || '');
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试单个提供商（测试连通性）
      if (pathname === '/api/providers/test-one' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 用 baseUrl + apiKey + model 发送一次最小 chat 测试请求。
      // apiKey 可省略：省略时由服务端自己解析真实 Key 使用（不外发给客户端），
      // 这样未配置 server.token 时"测试连通性"依然可用。
      if (pathname === '/api/providers/test-chat' && method === 'POST') {
        try {
          const body = await readBody(req);
          const submitted = String(body.apiKey ?? '').trim();
          // 掩码 / 空 → 说明客户端没有新 Key，用服务端已保存的
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const result = await testModelChat({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey,
            model: String(body.model ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新增提供商（同 baseURL 自动合并）
      if (pathname === '/api/providers' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 给已有提供商追加模型
      if (pathname === '/api/providers/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除某提供商下的一个模型
      if (pathname === '/api/providers/models' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/providers/set-key' && method === 'POST') {
        const body = await readBody(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }

      if (pathname === '/api/providers/test-all' && method === 'POST') {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }

      if (pathname === '/api/vision/results' && method === 'GET') {
        return json(res, 200, { results: { ...builtinVisionResults(currentProviders()), ...visionResults() }, scanning: visionScan.running });
      }

      if (pathname === '/api/vision/scan' && method === 'POST') {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await readBody(req).catch(() => ({}));
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({
          providers: currentProviders(),
          emit,
          onlyProviderIds,
          timeoutMs: 25000,
          limit: 3
        })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }

      // ── 自定义搜索提供商（可添加多个，交互沿用模型提供商那套）──
      if (pathname === '/api/search-providers' && method === 'GET') {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          baseUrl: p.baseUrl,
          model: p.model,
          count: p.count,
          timeoutMs: p.timeoutMs,
          hasApiKey: Boolean(String(p.apiKey || '').trim())   // 不返回明文
        }));
        return json(res, 200, { providers: list });
      }

      // 新增/更新：同 baseUrl + type 视为同一项，覆盖其配置
      if (pathname === '/api/search-providers' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // 掩码/空 = 保持原 Key 不变
            const submitted = String(body.apiKey ?? '').trim();
            if (submitted && submitted !== '******') existing.apiKey = submitted;
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type,
              baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, {
            ok: true,
            provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) }
          });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除一个自定义搜索提供商
      if (pathname === '/api/search-providers' && method === 'DELETE') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          // 若当前正选中被删的那项，回落 bing，避免搜索直接报错
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) {
            updateConfig({ webSearch: { provider: 'bing' } });
          }
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试某个自定义搜索提供商是否可用
      if (pathname === '/api/search-providers/test' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const body = await readBody(req).catch(() => ({}));
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, {
            ok: true,
            result: {
              ok: true,
              count: r.results.length,
              sample: r.results[0]?.title || '',
              latencyMs: Date.now() - startedAt
            }
          });
        } catch (error) {
          return json(res, 200, {
            ok: true,
            result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt }
          });
        }
      }

      if (pathname === '/api/test/api' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({
            messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
            tools: null,
            temperature: 0
          });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }

      if (pathname === '/api/config' && method === 'GET') {
        // 不把任何真实 Key 暴露给前端：递归清空所有密钥类字段，用 hasKey 表示"有密钥"。
        // 注意：不要用手工逐字段列举——之前漏了 5 个搜索 Key 和 2 个 SnowLuma 令牌，
        // 加新 provider 时还会继续漏。这里按字段名模式统一处理。
        return json(res, 200, sanitizeConfig(cfgNow));
      }

      if (pathname === '/api/config' && method === 'POST') {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        initPriceFeed(next.api?.priceRemoteUrl || '');   // 远程价格表 URL 可能改了（内部幂等）
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, config: next });
      }

      if (pathname === '/api/version' && method === 'GET') {
        // 纯本地读取，无网络依赖：设置页"当前版本"展示用
        return json(res, 200, { version: localVersion() });
      }

      if (pathname === '/api/update-check' && method === 'GET') {
        const current = localVersion();
        try {
          const r = await fetch(UPDATE_INFO_URL, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const info = await r.json();
          const latest = String(info.version || '');
          if (!latest) throw new Error('version.json 缺少 version 字段');
          return json(res, 200, {
            ok: true, current, latest,
            hasUpdate: compareSemver(latest, current) > 0,
            url: String(info.url || 'https://kondius.cn/qq-agent'),
            notes: String(info.notes || '')
          });
        } catch (error) {
          return json(res, 200, { ok: false, current, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/models' && method === 'GET') {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        // 上限 2^20（Kondius 钦定 1048576）：约等于不限，但拦得住真正的失控请求。
        // 前端靠分页（一次渲染 50 条）避免卡顿，后端不截断。
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }

      const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
      if (sessionMatch && method === 'GET') {
        const s = sessions.get(sessionMatch[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }

      if (pathname === '/api/chats' && method === 'GET') {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        // 附带群名，让 UI 能显示"群名（群号）"。
        // 群名要调 OneBot 拿，可能慢或失败 —— 用 allSettled 保证绝不影响主流程：
        // 拿不到的 chatName 为空，UI 自动退回只显示群号。
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))   // 3s 超时保护
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }

      // 记忆文件列表（记忆页签）：白名单里的每个群都显示，含无记忆的
      if (pathname === '/api/memory-files' && method === 'GET') {
        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey,
            impressionCount,
            memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });
        // 白名单里的群没有记忆也要显示
        const seen = new Set(files.map((f) => f.chatKey));
        // 补上白名单里还没有记忆的会话（缺字段也要有默认值，前端统一处理）
        for (const gid of (getConfig().allow?.groups || [])) {
          const key = `group:${String(gid)}`;
          if (!seen.has(key)) {
            files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
          }
        }
        for (const uid of (getConfig().allow?.private || [])) {
          const key = `private:${String(uid)}`;
          if (!seen.has(key)) {
            files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
          }
        }
        // 带上"正在整理"状态：切页签后前端靠它恢复提示，
        // 否则用户切走再切回，完全看不出整理是在跑还是已经中断。
        const busy = orchestrator.consolidating;
        for (const f of files) f.consolidating = busy.has(f.chatKey);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, 200, { files, consolidating: [...busy] });
      }

      const memoryFileMatch = /^\/api\/memory-files\/(group|private)_(\d+)$/.exec(pathname);
      if (memoryFileMatch && method === 'GET') {
        const chatKey = `${memoryFileMatch[1]}:${memoryFileMatch[2]}`;
        return json(res, 200, {
          ...memory.query(chatKey),
          members: memory.members(chatKey)
        });
      }

      // 手动编辑某个群友的印象（PUT 编辑：QQ号必填，备注可同步保存 / DELETE 删除成员文件）
      const memoryMemberMatch = /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/.exec(pathname);
      if (memoryMemberMatch && method === 'PUT') {
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        const body = await readBody(req).catch(() => ({}));
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: memoryMemberMatch[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (memoryMemberMatch && method === 'DELETE') {
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        memory.removeMember(chatKey, memoryMemberMatch[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }

      // 手动整理某个群的记忆：遍历聊天记录中出现的成员，逐人整理直到收敛
      if (pathname === '/api/memory-files/consolidate' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });

          // 可选：只整理指定的群友（QQ 号数组）。不传 = 整理全群。
          // 传了但记忆里还没有此人时，会从聊天记录里新建印象。
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          // 手动触发：跳过门槛/冷却检查，且对零印象的人启用"新建印象"模式
          const force = body.force !== false;

          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
            .then((result) => {
              emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) });
            })
            .catch((error) => {
              emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) });
            })
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
      if (chatMsgMatch && method === 'GET') {
        const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
        // 单群消息上限 2^20（Kondius 钦定）：约等于不限，存档一口气全给
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply,
          // media 必须带：金句上传要靠它把图片 URL 传给服务器转存
          // （曾经漏了这个字段，前端收到的 media 永远是 undefined → 图片全丢）
          media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }

      // ── 金句上传取图：把存档消息里的图片转成 dataURL ──
      // 背景：存档只存图片 URL，而 QQ 图床的 rkey 会过期（失效后全网 400 invalid url，
      // 服务器转存必败、原图也救不回）。NapCat/SnowLuma 收到图时有本地缓存，
      // 走 OneBot get_image 拿缓存文件读出来，彻底不依赖 URL 时效。
      // POST { items: [{ file, url }] } → { results: [{ dataUrl } | null, ...] }
      const mediaDataMatch = pathname === '/api/media-data';
      if (mediaDataMatch && method === 'POST') {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          const fileToDataUrl = (fp) => {
            const st = fs.statSync(fp);   // 不存在直接抛
            if (st.size > 15 * 1024 * 1024) return null;
            return `data:${mimeOf(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            // 路径 1：OneBot get_image → NapCat 本地缓存文件
            try {
              const ret = await onebot.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
              // 有的实现返回的是可下载的 url
              if (!dataUrl && ret?.url) {
                const r = await fetch(String(ret.url), { signal: AbortSignal.timeout(10000) });
                if (r.ok) {
                  const buf = Buffer.from(await r.arrayBuffer());
                  if (buf.length && buf.length <= 15 * 1024 * 1024) {
                    dataUrl = `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
                  }
                }
              }
            } catch { /* 缓存没有就走下一条 */ }
            // 路径 2：直接拉存档里的 URL（新消息 URL 还没过期时有效）
            if (!dataUrl && it?.url) {
              try {
                const r = await fetch(String(it.url), { signal: AbortSignal.timeout(10000) });
                if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) {
                  const buf = Buffer.from(await r.arrayBuffer());
                  if (buf.length && buf.length <= 15 * 1024 * 1024) {
                    dataUrl = `data:${r.headers.get('content-type')};base64,${buf.toString('base64')}`;
                  }
                }
              } catch { /* 过期就放弃，返回 null 让前端保留原 URL */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }

      // 群成员列表（OneBot get_group_member_list），用于备注与记忆页成员展示
      const groupMembersMatch = /^\/api\/groups\/(\d+)\/members$/.exec(pathname);
      if (groupMembersMatch && method === 'GET') {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(groupMembersMatch[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatWakeMatch = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
      if (chatWakeMatch && method === 'POST') {
        const chatKey = `${chatWakeMatch[1]}:${chatWakeMatch[2]}`;
        const ok = orchestrator.forceWake(chatKey);
        return json(res, 200, { ok });
      }

      // 手动发一条测试消息（不走模型，直接经 OneBot 发出，用于配置后验证链路）
      const chatTestSendMatch = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
      if (chatTestSendMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${chatTestSendMatch[1]}:${chatTestSendMatch[2]}`;
          const data = await onebot.sendText(chatTestSendMatch[1], chatTestSendMatch[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatReadMatch = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
      if (chatReadMatch && method === 'POST') {
        const chatKey = `${chatReadMatch[1]}:${chatReadMatch[2]}`;
        const drained = store.drainUnread(chatKey);
        return json(res, 200, { ok: true, marked: drained.length });
      }

      if (pathname === '/api/pause' && method === 'POST') {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) {
          // 恢复时自动补处理暂停期间积压的未读消息
          orchestrator.drainBacklogAfterResume();
        }
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }

      // 恢复运行，并把所有会话当前未读一次性标记为已读（用户明确选择丢弃积压）
      if (pathname === '/api/pause' && method === 'DELETE') {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    // 静态 UI
    if (req.method === 'GET') {
      // 路径穿越防护：
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".." —— "/....//" 删完仍还原出 ".."，
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      // 正确做法：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 匿名用量遥测：启动 90 秒后发第一次，之后每 6 小时一次；失败静默不影响使用
    startTelemetryLoop(log);

    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    if (getConfig().snowluma?.autoLaunch) {
      try {
        const wsPort = snowlumaWsPort();
        if (!(await isPortOpen('127.0.0.1', wsPort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', wsPort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    }
    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      // accessToken/httpToken 已由 applyTokens 直接挂到实例（候选[0]）
    }
    await onebot.connect();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
    await orchestrator.abortAll();
    onebot.close();
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程。
    // 注意：SnowLuma 退出时不一定能立刻把 config 落盘，但我们的 stop 不会再去读它，
    // 下次启动会读到完整文件。
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus };
}

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds。
 * 没有历史汇总文件也能算 —— 直接扫留档即可。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时
// 单次约 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。
// 会话文件是"结束写一次、之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原来是 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，
//      导致切过去时缓存经常刚好过期 → 每次都走 200ms 的冷启动（"黑一下"）。
//      用量统计不是实时数据，20 秒的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs;
  } catch {
    return '';
  }
}

function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      rows: usageRowsCache.rows.slice(),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 与 rows 在同一个循环里统计 —— 不额外多读一次文件。
  // 注意这些是"次数"不是"成本"：搜索通常是资源包或免费的，
  // 所以只列数量、绝不参与成本计算（用户明确要求）。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const started = Number(s.startedAt) || 0;
    if (!started) continue;

    // 这个会话是否落在时间窗口内（工具/搜索计数按会话归属，没有独立时间戳）
    if (started >= win.start && started <= win.end) {
      searchCount += Number(s.webSearchCount) || 0;
      for (const m of (s.messages || [])) {
        const name = m && m.toolCall && m.toolCall.name;
        if (name) toolCounts[String(name)] = (toolCounts[String(name)] || 0) + 1;
      }
    }

    // 逐次调用展开：每条 message.raw 有独立的 usage / created / model
    const calls = [];
    for (const m of (s.messages || [])) {
      const raw = m?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const ru = raw.usage || {};
      const rp = Number(ru.prompt_tokens) || 0;
      const rc = Number(ru.completion_tokens) || 0;
      if (!rp && !rc) continue;
      const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
      calls.push({
        promptTokens: rp,
        completionTokens: rc,
        cachedTokens: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
        at,
        model: String(raw.model || s.model || '') || '(未知)'
      });
    }

    if (calls.length) {
      for (const c of calls) {
        if (c.at < win.start || c.at > win.end) continue;
        rows.push({ ...c, vendor: String(s.vendor || ''), chatKey: String(s.chatKey || '(未知)'), sessionId: s.id, exact: true });
      }
    } else {
      const u = s.usage || {};
      const p = Number(u.promptTokens) || 0;
      const c = Number(u.completionTokens) || 0;
      if (!p && !c) continue;
      if (started < win.start || started > win.end) continue;
      rows.push({
        promptTokens: p,
        completionTokens: c,
        cachedTokens: Number(u.cachedTokens) || 0,
        at: started,
        model: String(s.model || '') || '(未知)',
        chatKey: String(s.chatKey || '(未知)'),
        vendor: String(s.vendor || ''),
        sessionId: s.id,
        exact: false
      });
    }
  }
  // 模型身份 = 渠道 + 模型 id。
  // 渠道取**会话自己记录的** vendor（创建会话时由当时的配置派生）。
  // 老会话没这个字段 → 标为「未知渠道」，绝不拿当前配置去倒推历史 ——
  // 用户很可能早就换过渠道了，猜出来的结果是错的。
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.slice();
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
  return { rows, win, searchCount, toolCounts };
}

/** 用配置解析价格（成本只与实际调用的模型有关，与当前选中模型无关）。 */
/**
 * 取某次调用的单价。
 *
 * 按「渠道：模型 id」优先查 —— 用户可以为某个渠道下的模型单独定价
 * （A6API 的 GLM-5.3-Flash 与 OpenRouter 的可能是两个价）。
 * 查不到再退回裸模型 id（通用价），最后才是全局兜底。
 *
 * ⚠️ 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor) {
  const cfg = getConfig();
  if (vendor) {
    const byVendor = resolveModelPrice(modelLabel(vendor, model), cfg);
    // 命中自定义价才算数；否则退回通用价（避免渠道名干扰官方表匹配）
    if (byVendor.source === 'custom') return byVendor;
  }
  return resolveModelPrice(model, cfg);
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows) {
  const cfg = getConfig();
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0, hasPeakModel = false;
  for (const r of rows) {
    const p = priceOf(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const c = (fresh / 1_000_000) * tier.in + (cached / 1_000_000) * tier.cached + (completion / 1_000_000) * tier.out;
    cost += c;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
  }
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel, runs: rows.length
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。 */
function buildUsageStats({ range = '7' } = {}) {
  const { rows, win, searchCount, toolCounts } = collectUsageRows({ range });
  const totals = costOfRows(rows);
  // 单日/24小时场景下"按天"没有意义（只有一行），由前端决定是否隐藏
  const days = win.mode === 'days' ? groupBy(rows, 'dayKey').map((x) => ({ day: x.key, ...x })) : [];
  // 按天分桶需要 dayKey 字段
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  const byDay = win.mode === 'days'
    ? groupBy(rows, 'dayKey').map((x) => ({ day: x.key, ...x })).sort((a, b) => a.day.localeCompare(b.day))
    : [];
  const chats = groupBy(rows, 'chatKey', 0);
  // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
  // 行数多时由前端滚动容器处理。
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return {
    range: String(range),
    rangeLabel: win.label,
    mode: win.mode,
    totals,
    // 次数类统计：只看数量，不参与成本计算
    searchCount: searchCount || 0,
    toolCounts: toolCounts || {},
    days: byDay,
    chats,
    models
  };
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的成本
 */
function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  const { rows, win } = collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  const sum = costOfRows(subset);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}
