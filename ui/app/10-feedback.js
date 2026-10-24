// 〔屏蔽名单 / 意见收集 / 更新检查 / 金句上传〕——M9 拆分第 11 段
'use strict';

// ── 阿里云验证码 2.0（意见收集 / 金句上传共用闸门）──
// 服务端（receiver.py）对所有免登录写入端点强制验签：上传请求必须携带
// 验证通过后拿到的 captchaVerifyParam（一次性，90 秒内送达服务端）。
// SDK 按官方要求动态加载（CSP 已放行 o.alicdn.com 与 aliyuncs 验签域）。
// 就绪信号是 getInstance 回调——脚本 onload 只代表下载完，init 内部还要
// 异步初始化，提前 show() 会静默无操作；onError 兜底初始化失败。
// prefix 与 SceneId 为公开值（浏览器初始化必需），AK 只在服务器侧。
window.AliyunCaptchaConfig = { region: 'cn', prefix: '163stu' };
const CAPTCHA_SCENE_ID = '632wvduj';
let _captchaInstance = null, _captchaReady = false, _captchaLoading = false;
let _captchaOnPass = null;
const _captchaPending = [];

function _captchaDispatch(captchaVerifyParam) {
  const handler = _captchaOnPass; _captchaOnPass = null;
  if (handler) handler(captchaVerifyParam);
}

function _captchaFailAll(msg) {
  _captchaLoading = false;
  const q = _captchaPending.splice(0);
  q.forEach((cb) => cb(new Error(msg)));
}

// Service Worker：把渲染层对 aliyuncs/alicdn 的请求改写到 kondius.cn 实时反代。
// 仅在本机 Chromium 网络栈被压制的机器上才实际起作用；正常机器上 SW 静默无副作用。
// SW 文件由本地 server 提供（ui/captcha-sw.js，同源，secure context 成立）。
async function _ensureCaptchaSW() {
  if (!('serviceWorker' in navigator)) { window.__qqaSWStatus = 'SW不支持'; return; }
  try {
    await navigator.serviceWorker.register('/captcha-sw.js');
    await navigator.serviceWorker.ready;   // 激活后再加载 SDK，保证拦截已生效
    window.__qqaSWStatus = 'SW已激活';
  } catch (e) {
    window.__qqaSWStatus = `SW注册失败:${String(e && e.message || e).slice(0, 60)}`;
    console.warn('[captcha] SW 注册失败（将按原路径直连）', e);
  }
}

function _captchaStart() {
  _captchaLoading = true;
  _installCaptchaReqHook();
  // 时序关键：先等 SW 激活（aliyuncs 改写通道就绪），再 appendChild 加载 SDK ——
  // SDK onload 后立刻 initAliyunCaptcha 发 XHR，SW 必须已生效。
  _ensureCaptchaSW()
    .catch(() => {})
    .then(() => {
      const s = document.createElement('script');
      // SDK 主脚本走 kondius.cn 同域反代（nginx 实时透传 o.alicdn.com，不缓存）：
      // 部分用户机器上 Chromium 访问 *.alicdn.com 失败但 kondius.cn 可达（2026-09-26 实测）。
      // SDK 内部的接口请求全在 aliyuncs.com 域（已解析源码确认，无 alicdn 后续资源），
      // 由 captcha-sw.js 改写走 kondius.cn；CSP 的 connect-src 已放行两族域名。
      s.src = 'https://kondius.cn/qq-agent/captcha-sdk/AliyunCaptcha.js';
      s.onload = () => {
        try {
          window.initAliyunCaptcha({
            SceneId: CAPTCHA_SCENE_ID,
            mode: 'popup',
            element: '#captcha-element',
            button: '#captcha-trigger',   // 常驻隐藏元素，实际由 show() 弹出
            zIndex: 2147483000,           // 压过控制台所有模态框
            success(captchaVerifyParam) { _captchaDispatch(captchaVerifyParam); },
            fail(r) { console.error('[captcha] fail', r); },
            getInstance(i) {
              _captchaInstance = i; _captchaReady = true; _captchaLoading = false;
              const q = _captchaPending.splice(0);
              q.forEach((cb) => { _captchaOnPass = cb; _captchaInstance.show(); });
            },
        onError(info) {
          console.error('[captcha] init error', info);
          // 把 SDK 实际发出的请求清单（hook 记录）+ SW 状态 + session 拦截器状态亮出来
          (async () => {
            const reqs = (window.__qqaReqLog || []).slice(-6).join(' ｜ ');
            const sw = window.__qqaSWStatus || '未注册';
            let interceptor = '(未知)';
            try {
              interceptor = await window.qqAgentShell?.captchaInterceptorStatus?.() || '(未知)';
            } catch { /* 忽略 */ }
            console.error('[captcha] reqLog:', reqs, '| SW:', sw, '|', interceptor);
            _captchaFailAll(`人机验证初始化失败（${(info && (info.msg || info.code)) || '未知错误'}）。${interceptor}；SW=${sw}。实际请求：${reqs || '(无记录)'}`);
          })();
        },
            slideStyle: { width: 320, height: 40 },
            language: 'cn',
          });
        } catch (e) {
          console.error('[captcha] init threw', e);
          _captchaFailAll('人机验证组件异常，请重试');
        }
      };
      s.onerror = () => {
    // onerror 拿不到失败原因。组合四路信号定位：
    // ① securitypolicyviolation 事件（CSP 拦截的铁证）；
    // ② 渲染层多域名连通性探测；
    // ③ 主进程 Node 层探测（独立于 Chromium 网络栈，preload 暴露）——
    //    Node 通 + Chromium 挂 = 本机软件按进程压制 Chromium 网络；
    // ④ navigator.onLine。
    (async () => {
      const probe = await _captchaProbeNet();
      let nodeProbe = '';
      try {
        nodeProbe = await window.qqAgentShell?.captchaNetProbe?.() || '';
      } catch { nodeProbe = '(主进程探测不可用)'; }
      const cspHit = _cspViolations.filter((v) => v.includes('alicdn') || v.includes('aliyuncs')).slice(-2).join('；');
      let detail;
      if (cspHit) {
        detail = `被页面安全策略拦截（${cspHit}）——页面不是最新版，请完全退出程序（托盘也要退）再启动`;
      } else {
        detail = `渲染层 ${probe} ｜ ${nodeProbe}`;
      }
        console.error('[captcha] script load failed.', detail);
        _captchaFailAll(`验证码组件加载失败。${detail}`);
      })();
    };
    document.head.appendChild(s);
    })
    .catch((e) => {
      console.error('[captcha] start boot failed', e);
      _captchaFailAll('人机验证启动失败，请重试');
    });
}

// CSP 违规监听：任何资源被 CSP 拦下时页面会收到这个事件 ——
// 它是区分「CSP 拦截」和「真网络故障」的唯一可靠信号（fetch 上两者都表现为
// TypeError: Failed to fetch，无法直接区分）。
const _cspViolations = [];
try {
  window.addEventListener('securitypolicyviolation', (e) => {
    _cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURL}`);
    console.error('[captcha] CSP violation:', e.violatedDirective, 'blocked', e.blockedURL);
  });
} catch { /* 极老内核忽略 */ }

// SDK 请求记录 + 页面层改写：hook fetch/XHR。
// 把 SDK 对 aliyuncs/alicdn 的请求在 open() 时改写为 kondius.cn 反代 URL ——
// 页面层到 kondius.cn 实测可达（SW 上下文、webRequest redirect 在本机均异常，
// 页面层是唯一验证可靠的路由），请求体原样保留、无 redirect 丢 body 问题。
// 同时记录每个外网请求的原始 URL 与结果，onError 时亮出来定位问题。
const _RE_ALI = /^(https:\/\/([a-zA-Z0-9.-]+\.(?:aliyuncs|alicdn)\.com))(\/.*)?$/;
function _rewriteAliUrl(u) {
  const m = _RE_ALI.exec(String(u || ''));
  if (!m) return String(u || '');
  // 终极路由：改写到**本地同源转发接口**（/api/captcha-forward）——
  // 同源 = 零 CORS/零预检，实际转发由主进程 Node 层（网络栈独立且实测可达）完成。
  // kondius.cn 反代链路在部分机器上被 CORS 凭据/预检问题反复卡住，此路彻底绕开。
  return `/api/captcha-forward?u=${encodeURIComponent(m[0])}`;
}
let _captchaReqHookInstalled = false;
function _installCaptchaReqHook() {
  if (_captchaReqHookInstalled) return;
  _captchaReqHookInstalled = true;
  window.__qqaReqLog = [];
  const push = (kind, url, note) => {
    try {
      const u = String(url || '');
      if (/^https?:/.test(u) && !/127\.0\.0\.1|localhost/.test(u)) {
        window.__qqaReqLog.push(`${kind} ${u.slice(0, 110)} -> ${note || ''}`.trim());
        if (window.__qqaReqLog.length > 40) window.__qqaReqLog.shift();
      }
    } catch { /* 忽略 */ }
  };
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = typeof input === 'string' ? input : (input && input.url) || '';
    const rewritten = _rewriteAliUrl(url);
    if (rewritten !== url) {
      push('fetch改写', url);
      if (typeof input === 'string') input = rewritten;
      url = rewritten;
    }
    return origFetch.apply(this, [input, init]).then(
      (r) => { push('fetch', url, `HTTP${r.status}`); return r; },
      (e) => { push('fetch', url, `ERR:${(e && e.message) || e}`); throw e; });
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const rewritten = _rewriteAliUrl(url);
      if (rewritten !== url) { push('xhr改写', url); url = rewritten; }
      this.__qqaUrl = url;
      // 改写后的请求走 kondius.cn 反代：验证码是匿名验证，不需要 cookie；
      // 强制不带凭据可避开"带凭据时 CORS 通配符失效"的预检死路（双保险，
      // 服务端 nginx 已同步改为动态回显 Origin）。
      if (rewritten !== url) this.withCredentials = false;
    } catch { /* 忽略 */ }
    return origOpen.apply(this, [method, url, ...[].slice.call(arguments, 2)]);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    xhr.addEventListener('load', () => {
      // 走反代时 599 = 转发层失败（body 内含真实错误），一并记录
      let extra = '';
      try {
        if (xhr.status === 599) extra = ' ' + String(xhr.responseText || '').slice(0, 160);
      } catch { /* 跨域不可读时忽略 */ }
      push('xhr', xhr.__qqaUrl, `HTTP${xhr.status}${extra}`);
    });
    xhr.addEventListener('error', () => push('xhr', xhr.__qqaUrl, 'ERR:网络错误'));
    xhr.addEventListener('timeout', () => push('xhr', xhr.__qqaUrl, 'ERR:超时'));
    return origSend.apply(this, arguments);
  };

  // ── 动态资源改写（script/img/iframe 的 src）──
  // SDK 初始化成功后会动态注入滑块组件的 JS（"动态JS加载失败"即此步），
  // script 标签不走 XHR/fetch，必须 hook 创建/插入过程改写 src。
  const srcDescScript = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  const srcDescImg = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  const wrapSrc = (el, desc, kind) => {
    let raw = '';
    try {
      Object.defineProperty(el, 'src', {
        configurable: true,
        get() { return raw || desc.get.call(el); },
        set(v) {
          raw = String(v);
          const rewritten = _rewriteAliUrl(raw);
          if (rewritten !== raw) push(kind + '改写', raw);
          desc.set.call(el, rewritten);   // 底层 src 设为改写后的地址（请求改走转发）
        },
      });
    } catch { /* 包装失败退回直连 */ }
  };
  const origCreate = document.createElement.bind(document);
  document.createElement = function (tag, opts) {
    const el = origCreate(tag, opts);
    try {
      const t = String(tag || '').toLowerCase();
      if (t === 'script') wrapSrc(el, srcDescScript, 'script');
      else if (t === 'img') wrapSrc(el, srcDescImg, 'img');
    } catch { /* 忽略 */ }
    return el;
  };
  // 兜底：createElement 之外的插入路径（innerHTML 等）由 Observer 补改写。
  // 触发时机晚于 src 赋值（首个请求可能已失败），但改 src 会触发重新加载。
  try {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes || []) {
          try {
            if (node && node.nodeType === 1 && (node.tagName === 'SCRIPT' || node.tagName === 'IMG')) {
              const desc = node.tagName === 'SCRIPT' ? srcDescScript : srcDescImg;
              const cur = desc.get.call(node);
              const rewritten = _rewriteAliUrl(cur);
              if (rewritten !== cur) { push(node.tagName.toLowerCase() + '改写(Observer)', cur); desc.set.call(node, rewritten); }
            }
          } catch { /* 单节点失败不拖垮监听 */ }
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* 忽略 */ }
}

// 多目标连通性探测：mode:'no-cors' 下 resolve 即网络通（opaque 响应也算通），
// 用 kondius.cn（意见箱一直在用的域）和两个 alicdn 域做对照。
async function _captchaProbeNet() {
  const targets = [
    ['kondius.cn(SDK反代)', 'https://kondius.cn/qq-agent/captcha-sdk/AliyunCaptcha.js'],
    ['aliyuncs(验签域)', 'https://captcha.cn-shanghai.aliyuncs.com/'],
    ['kondius.cn(接口)', 'https://kondius.cn/api/community/health'],
  ];
  const out = [];
  for (const [name, url] of targets) {
    try {
      const r = await fetch(url, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      out.push(`${name}:通(${r.type})`);
    } catch (e) {
      out.push(`${name}:不通(${String(e?.message || e).replace(/^TypeError:\s*/, '')})`);
    }
  }
  return out.join(' ');
}

function showCaptcha(cb) {
  if (_captchaReady && _captchaInstance && _captchaInstance.show) {
    _captchaOnPass = cb;
    _captchaInstance.show();
    return;
  }
  _captchaPending.push(cb);
  if (!_captchaLoading) _captchaStart();
}

// ── 屏蔽名单 ──
function openBlocklistModal() {
  const cfg = state.config || {};
  const allowIds = (cfg.allow?.groups || []).map(String);
  if (!allowIds.length) {
    modelModalShell({
      head: '屏蔽名单',
      body: '<div class="empty-hint">白名单为空——先去「白名单」页签添加群聊，再来屏蔽群员。</div>'
    });
    return;
  }
  const pending = structuredClone(cfg.blocklist || {});
  // 全局屏蔽名单（所有群+私聊都生效）的工作副本
  let pendingGlobal = new Set((cfg.globalBlocklist || []).map(String));
  // 云端是全局名单的权威来源；打开弹窗时先刷新一次，失败继续显示本地缓存。
  api('/api/community/blocklist').then((d) => {
    if (d.ok && Array.isArray(d.ids)) { pendingGlobal = new Set(d.ids.map(String)); renderRight(); }
  }).catch(() => {});
  // 机器人自己的 QQ 号：从状态接口取（cfg.onebot?.selfId 这个字段根本不存在，
  // 曾经恒为空串 —— "过滤机器人自己"形同虚设，机器人自己出现在可屏蔽列表里）
  const selfId = String(state.status?.onebot?.self?.userId || cfg.onebot?.selfId || '');
  let activeGid = allowIds[0];
  let members = [];       // 当前群成员缓存（{userId, nickname, card}）
  let kw = '';

  const overlay = modelModalShell({
    head: '屏蔽名单',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left" id="bl-left"></div>
        <div class="model-modal-right" id="bl-right"></div>
      </div>
      <div class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        勾选 = 屏蔽：被屏蔽群员的消息不存档、不触发回复、不进提示词背景。<br>
        <b>全局屏蔽</b>（右键单击成员，或点名字旁的 ⊘）：此人在<b>所有群和私聊</b>里的消息都被丢弃 —— 用于骚扰者/广告号。
      </div>`,
    foot: `<span class="muted" id="bl-status" style="flex:1;text-align:left;font-size:12px"></span>
           <button class="btn" id="bl-cancel">取消</button>
           <button class="btn btn-primary" id="bl-save">保存设置</button>`
  });
  const left = overlay.querySelector('#bl-left');
  const right = overlay.querySelector('#bl-right');
  const statusEl = overlay.querySelector('#bl-status');

  const groupNames = new Map();   // 异步补群名
  function renderLeft() {
    left.innerHTML = allowIds.map((id) =>
      `<div class="mm-prov ${id === activeGid ? 'active' : ''}" data-gid="${esc(id)}">${esc(groupNames.get(id) || id)}<div class="muted" style="font-size:11px">${esc(id)}</div></div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activeGid = el.dataset.gid; renderLeft(); loadMembers(); });
    });
  }
  api('/api/onebot/groups').then((d) => {
    for (const g of (d.groups || [])) groupNames.set(String(g.id), g.name);
    renderLeft();
  }).catch(() => {});

  function isBlocked(uid) { return (pending[activeGid] || []).map(String).includes(String(uid)); }
  function isGlobalBlocked(uid) { return pendingGlobal.has(String(uid)); }

  function renderRight() {
    // 工具栏只建一次：曾经每次按键都整块重建 innerHTML（连搜索框一起销毁重建），
    // 输入一个字符就失焦 —— 搜索体验的根因就在这里。
    right.innerHTML = `
      <div class="ma-toolbar">
        <input type="text" id="bl-search" placeholder="搜索群员（昵称 / 群名片 / QQ 号）…" autocomplete="off" value="${esc(kw)}" />
      </div>
      <div id="bl-list"></div>`;
    right.querySelector('#bl-search').addEventListener('input', (e) => {
      kw = e.target.value.trim().toLowerCase();
      renderList();   // 只重绘名单，输入框保持原位原焦点
    });
    renderList();
  }

  function renderList() {
    const listBox = right.querySelector('#bl-list');
    if (!listBox) return;
    const filtered = kw
      ? members.filter((m) => `${m.card} ${m.nickname} ${m.userId}`.toLowerCase().includes(kw))
      : members;
    const rows = filtered.map((m) => {
      const label = m.card || m.nickname || m.userId;
      const gb = isGlobalBlocked(m.userId);
      return `<label class="bl-member ${gb ? 'bl-global' : ''}" data-uid="${esc(m.userId)}">
        <input type="checkbox" class="bl-chk" data-uid="${esc(m.userId)}" ${isBlocked(m.userId) ? 'checked' : ''} />
        <span class="bl-name">${esc(label)}</span>
        <span class="muted" style="font-size:11px">${esc(m.userId)}</span>
        <button type="button" class="bl-global-toggle ${gb ? 'on' : ''}" data-uid="${esc(m.userId)}" title="${gb ? '取消全局屏蔽' : '全局屏蔽（所有群+私聊）'}">${gb ? '⊘ 全局' : '⊘'}</button>
      </label>`;
    }).join('');
    listBox.innerHTML = rows || '<div class="empty-hint" style="padding:18px">没有匹配的群员</div>';
    listBox.querySelectorAll('.bl-chk').forEach((chkEl) => {
      chkEl.addEventListener('change', () => {
        const uid = chkEl.dataset.uid;
        const set = new Set((pending[activeGid] || []).map(String));
        if (chkEl.checked) set.add(uid); else set.delete(uid);
        if (set.size) pending[activeGid] = [...set]; else delete pending[activeGid];
        const n = (pending[activeGid] || []).length;
        statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
      });
    });
    // 全局屏蔽切换（点 ⊘ 按钮）
    listBox.querySelectorAll('.bl-global-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(btn.dataset.uid);
        if (pendingGlobal.has(uid)) pendingGlobal.delete(uid); else pendingGlobal.add(uid);
        statusEl.textContent = pendingGlobal.size ? `全局屏蔽 ${pendingGlobal.size} 人（所有群+私聊）` : '';
        renderList();
      });
    });
  }

  async function loadMembers() {
    right.innerHTML = '<div class="empty-hint" style="padding:18px">正在拉取群成员…</div>';
    try {
      const d = await api(`/api/groups/${activeGid}/members`);
      // 机器人自己列出来也没意义（自己的消息本来就不走这条管道）
      members = (d.members || []).filter((m) => String(m.userId) !== selfId);
      kw = '';
      renderRight();
      const n = (pending[activeGid] || []).length;
      statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
    } catch (e) {
      right.innerHTML = `<div class="empty-hint" style="padding:18px">拉取失败：${esc(e.message)}（SnowLuma 在线才能拿到群成员列表）</div>`;
    }
  }

  overlay.querySelector('#bl-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bl-save').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#bl-save');
    saveBtn.disabled = true;
    statusEl.textContent = '保存中…';
    try {
      // 群级屏蔽仍保存在本机；全局名单改走云端共享接口。
      const localData = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ blocklist: { __replace__: pending } })
      });
      state.config = localData.config;
      const cloud = await api('/api/community/blocklist', {
        method: 'POST',
        body: JSON.stringify({ ids: [...pendingGlobal], mode: 'replace' })
      });
      if (!cloud.ok) throw new Error(cloud.error || '云端名单更新失败');
      if (cloud.warning) alert(`注意：${cloud.warning}`);
      closeModelModal(overlay);
    } catch (e) {
      statusEl.textContent = `保存失败：${e.message}`;
      saveBtn.disabled = false;
    }
  });

  renderLeft();
  loadMembers();
}

// ── 意见收集 ──
const FB_DRAFT_KEY = 'qqa-feedback-draft';

/** 读草稿（昵称/正文/图片 dataURL 列表）。 */
function fbLoadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(FB_DRAFT_KEY) || '{}');
    return {
      nickname: String(d.nickname || ''),
      text: String(d.text || ''),
      images: Array.isArray(d.images) ? d.images.slice(0, 9) : []
    };
  } catch { return { nickname: '', text: '', images: [] }; }
}

/** 图片压缩：最大边 1200px、JPEG 0.75 —— 够看清，又不会把 localStorage 塞爆。 */
function fbCompressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const max = 1200;
      let { width: w, height: h } = img;
      if (w > max || h > max) {
        const r = Math.min(max / w, max / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('图片读取失败')); };
    img.src = URL.createObjectURL(file);
  });
}

function openFeedbackModal() {
  const draft = fbLoadDraft();
  const state2 = { images: draft.images.slice() };   // 弹窗内的图片列表（dataURL）

  const overlay = modelModalShell({
    head: '意见收集',
    body: `
      <div id="fb-form">
        <div class="hint" style="flex-shrink:0">
          昵称和意见会上传到作者的服务器（kondius.cn/qq-agent/comments 公开展示）。
          内容实时保存在本机，误点弹窗外面也不会丢。
        </div>
        <div class="field"><label>昵称</label>
          <input type="text" id="fb-nickname" maxlength="32" placeholder="怎么称呼你" value="${esc(draft.nickname)}" /></div>
        <div class="field"><label>意见 / 建议</label>
          <textarea id="fb-text" rows="6" maxlength="5000" placeholder="哪里好用、哪里难用、想要什么功能…">${esc(draft.text)}</textarea></div>
        <div class="field"><label>附图（最多 9 张，自动压缩）</label>
          <!-- 原生 <input type=file> 的"选择文件"按钮是系统样式，与 UI 割裂：
               隐藏本体，用统一的 .btn 风格 label 触发 -->
          <input type="file" id="fb-file" accept="image/*" multiple style="display:none" />
          <label for="fb-file" class="btn btn-small" id="fb-file-btn" style="cursor:pointer">＋ 添加图片（<span id="fb-img-count">${state2.images.length}</span>/9）</label>
          <div class="fb-imgs" id="fb-imgs"></div>
        </div>
        <div id="fb-hint" class="muted" style="font-size:12px"></div>
      </div>
      <div id="fb-confirm" style="display:none">
        <div class="hint">请确认上传内容：</div>
        <div id="fb-summary" style="white-space:pre-wrap;font-size:13px;max-height:300px;overflow-y:auto"></div>
        <div id="fb-confirm-hint" class="muted" style="font-size:12px;margin-top:8px"></div>
      </div>`,
    foot: `
      <button class="btn" id="fb-cancel">取消</button>
      <button class="btn btn-primary" id="fb-next">下一步</button>
      <button class="btn hidden" id="fb-back">返回修改</button>
      <button class="btn btn-primary hidden" id="fb-submit">确认上传</button>`
  });

  const $q = (sel) => overlay.querySelector(sel);
  const formEl = $q('#fb-form'), confirmEl = $q('#fb-confirm');
  const nextBtn = $q('#fb-next'), backBtn = $q('#fb-back'), submitBtn = $q('#fb-submit');

  // ── 草稿实时保存（300ms 防抖）──
  let saveTimer = null;
  const saveDraft = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(FB_DRAFT_KEY, JSON.stringify({
          nickname: $q('#fb-nickname').value,
          text: $q('#fb-text').value,
          images: state2.images
        }));
      } catch { /* 图片太多塞不下时至少保住文字 */ 
        try {
          localStorage.setItem(FB_DRAFT_KEY, JSON.stringify({
            nickname: $q('#fb-nickname').value, text: $q('#fb-text').value, images: []
          }));
        } catch { /* 放弃 */ }
      }
    }, 300);
  };
  $q('#fb-nickname').addEventListener('input', saveDraft);
  $q('#fb-text').addEventListener('input', saveDraft);

  // ── 图片九宫格 ──
  function renderImgs() {
    const cnt = $q('#fb-img-count');
    if (cnt) cnt.textContent = state2.images.length;
    $q('#fb-imgs').innerHTML = state2.images.map((d, i) => `
      <div class="fb-img"><img src="${d}" alt="附图${i + 1}" />
        <button class="fb-img-del" type="button" data-i="${i}" aria-label="移除这张图片" title="移除">×</button></div>`).join('');
    $q('#fb-imgs').querySelectorAll('.fb-img-del').forEach((el) => {
      el.addEventListener('click', () => {
        state2.images.splice(Number(el.dataset.i), 1);
        renderImgs();
        saveDraft();
      });
    });
  }
  renderImgs();

  $q('#fb-file').addEventListener('change', async (e) => {
    const hint = $q('#fb-hint');
    const files = [...(e.target.files || [])];
    e.target.value = '';
    for (const f of files) {
      if (state2.images.length >= 9) { hint.textContent = '最多 9 张，超出的已忽略'; break; }
      try {
        state2.images.push(await fbCompressImage(f));
      } catch (err) { hint.textContent = String(err.message || err); }
    }
    renderImgs();
    saveDraft();
  });

  // ── 步骤切换 ──
  $q('#fb-cancel').addEventListener('click', () => closeModelModal(overlay));
  nextBtn.addEventListener('click', () => {
    const nickname = $q('#fb-nickname').value.trim();
    const text = $q('#fb-text').value.trim();
    if (!nickname) { $q('#fb-hint').textContent = '先填个昵称'; return; }
    if (!text) { $q('#fb-hint').textContent = '意见还没写'; return; }
    saveDraft();
    $q('#fb-summary').textContent =
      `昵称：${nickname}\n\n${text}\n\n附图：${state2.images.length} 张`;
    // 步骤切换：表单淡出 / 确认页淡入，按钮组同步换形态
    uiHide(formEl, () => { formEl.style.display = 'none'; });
    uiShow(confirmEl, () => { confirmEl.style.display = ''; });
    uiHide(nextBtn, () => nextBtn.classList.add('hidden'));
    uiShow(backBtn, () => backBtn.classList.remove('hidden'));
    uiShow(submitBtn, () => submitBtn.classList.remove('hidden'));
  });
  backBtn.addEventListener('click', () => {
    uiShow(formEl, () => { formEl.style.display = ''; });
    uiHide(confirmEl, () => { confirmEl.style.display = 'none'; });
    uiShow(nextBtn, () => nextBtn.classList.remove('hidden'));
    uiHide(backBtn, () => backBtn.classList.add('hidden'));
    uiHide(submitBtn, () => submitBtn.classList.add('hidden'));
  });

  // ── 上传：先过人机验证，通过才真正提交（服务端强制验签）──
  submitBtn.addEventListener('click', async () => {
    const hint = $q('#fb-confirm-hint');
    hint.textContent = '请完成人机验证…';
    submitBtn.disabled = true;
    showCaptcha((p) => {
      submitBtn.disabled = false;
      if (p instanceof Error) { hint.textContent = p.message; return; }
      doUploadFeedback(p);
    });
  });

  async function doUploadFeedback(captchaVerifyParam) {
    const hint = $q('#fb-confirm-hint');
    hint.textContent = '上传中…';
    submitBtn.disabled = true;
    try {
      const res = await fetch(`${COMMUNITY_API}/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nickname: $q('#fb-nickname').value.trim(),
          text: $q('#fb-text').value.trim(),
          images: state2.images,
          captchaVerifyParam
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      localStorage.removeItem(FB_DRAFT_KEY);   // 上传成功才清草稿
      closeModelModal(overlay);
      showUploadToast('意见已上传，感谢反馈！', 'https://kondius.cn/qq-agent/comments');
    } catch (err) {
      hint.textContent = `上传失败：${err.message}（内容已保存在本机，可稍后再试）`;
      submitBtn.disabled = false;
    }
  }
}

// ── 打开网站 ──
// Electron 里 window.open 会被 main.js 的 setWindowOpenHandler 转给系统默认浏览器；
// 开发模式（纯浏览器）则正常开新标签页。
function openSite() {
  window.open('https://kondius.cn/qq-agent', '_blank', 'noopener');
}

// ── 自动检查更新 ──
// 节奏：启动时一次 + 之后每小时一次（version.json 作者手动改，这个频率足够）。
// 有更新 → 弹浮窗引导下载；用户手动关掉浮窗 → 本次启动内不再弹（重启恢复）。
// 但只要检测到新版，设置侧栏「桌面端」右侧就一直挂红点，直到版本追平。
let updateAvailable = false;
let updateToastDismissed = false;   // 本次启动内用户关过更新浮窗

function renderUpdateDot() {
  // 侧栏菜单每次重渲染都会重建（菜单 HTML 里已按 updateAvailable 画了点）；
  // 这里兜底处理"侧栏已渲染完、检测结果刚到"的情况。
  const item = document.querySelector('.settings-menu-item[data-section="desktop"]');
  if (!item) return;
  let dot = item.querySelector('.update-dot');
  if (updateAvailable && !dot) {
    dot = document.createElement('span');
    dot.className = 'update-dot';
    item.appendChild(dot);
  } else if (!updateAvailable && dot) {
    dot.remove();
  }
  // 桌面端页签的版本文案同步：有新版时"检查线上是否有新版本"→"发现新版本"
  const st = document.getElementById('update-status-text');
  if (st) {
    st.innerHTML = updateAvailable ? '<b style="color:var(--orange)">；发现新版本</b>' : '；检查线上是否有新版本';
  }
}

async function runUpdateCheck({ manual = false } = {}) {
  try {
    const data = await api('/api/update-check');
    if (!data?.ok) return data;   // 网络/服务器错误原样返回，手动检查要显示原因
    updateLatest = data;
    updateAvailable = !!data.hasUpdate;
    renderUpdateDot();
    // 自动检查弹浮窗；本次启动内被用户关过就不再弹（手动点「检查更新」除外）
    if (updateAvailable && (!updateToastDismissed || manual)) {
      showUploadToast(
        `发现新版本 v${data.latest}（当前 v${data.current}）`,
        data.url,
        { onClose: () => { updateToastDismissed = true; } }
      );
    }
    return data;
  } catch { return null; }
}
let updateLatest = null;

// ── 金句上传 ──
state.quoteMode = false;
state.quoteSelected = new Set();   // 当前存档会话里勾选的消息 id（m.id）

/** 进入/退出勾选模式时切换顶栏按钮形态。 */
function syncQuoteButtons() {
  const qb = $('#quote-btn'), qc = $('#quote-confirm-btn');
  if (!qb || !qc) return;
  if (state.quoteMode) {
    qb.textContent = '取消';
    uiShow(qc, () => qc.classList.remove('hidden'));
  } else {
    qb.textContent = '金句上传';
    uiHide(qc, () => qc.classList.add('hidden'));
  }
}

function enterQuoteMode() {
  state.quoteMode = true;
  state.quoteSelected = new Set();
  syncQuoteButtons();
  switchTab('chats');
  if (state.currentChatKey) renderChatMessages();   // 重建出勾选框
}

function exitQuoteMode() {
  if (!state.quoteMode) return;
  state.quoteMode = false;
  state.quoteSelected = new Set();
  syncQuoteButtons();
  if (state.tab === 'chats' && state.currentChatKey) updateChatMessagesBody(true);
}

/** 勾选模式下的确认：二次确认框 + 昵称。 */
function openQuoteConfirmModal() {
  const all = state.chatMessages || [];
  const picked = all.filter((m) => state.quoteSelected.has(m.id))
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));   // 按时间正序，读起来才是对话
  if (!picked.length) { showNoticeModal('金句上传', '还没有勾选任何消息。先在存档列表里勾几段对话吧。'); return; }
  const botCount = picked.filter((m) => m.self).length;
  if (!botCount) {
    showNoticeModal('金句上传', '勾选的消息里必须包含至少一条机器人发送的消息 —— 金句墙收的是机器人的发言。');
    return;
  }

  const key = state.currentChatKey || '';
  const chatName = formatChatTitle(key, chatNameOf(key));
  const lastNickname = localStorage.getItem('qqa-quote-nickname') || '';

  const overlay = modelModalShell({
    head: '确认上传金句',
    body: `
      <div class="hint">将上传 ${picked.length} 条消息（含机器人 ${botCount} 条），
        来自「${esc(chatName)}」，公开展示在 kondius.cn/qq-agent/holyshits。</div>
      <div class="field"><label>昵称（收录人）</label>
        <input type="text" id="q-nickname" maxlength="32" placeholder="怎么称呼你" value="${esc(lastNickname)}" /></div>
      <div style="max-height:320px;overflow-y:auto;border:none;border-radius:10px;padding:10px;font-size:12.5px;box-shadow:var(--press-sm)">
        ${picked.map((m) => `<div style="margin-bottom:8px">
          <span class="muted">${esc(m.self ? '🤖 ' : '')}${esc(m.senderName || '?')}：</span>${esc(String(m.text || '').slice(0, 200))}
        </div>`).join('')}
      </div>
      <div id="q-hint" class="muted" style="font-size:12px"></div>`,
    foot: `<button class="btn" id="q-cancel">取消</button>
           <button class="btn btn-primary" id="q-submit">确认上传</button>`
  });

  overlay.querySelector('#q-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#q-submit').addEventListener('click', async () => {
    const nickname = overlay.querySelector('#q-nickname').value.trim();
    const hint = overlay.querySelector('#q-hint');
    if (!nickname) { hint.textContent = '先填个昵称'; return; }
    overlay.querySelector('#q-submit').disabled = true;
    hint.textContent = '请完成人机验证…';
    showCaptcha((p) => {
      overlay.querySelector('#q-submit').disabled = false;
      if (p instanceof Error) { hint.textContent = p.message; return; }
      doUploadQuote(nickname, picked, p, overlay, hint);
    });
  });
}

async function doUploadQuote(nickname, picked, captchaVerifyParam, overlay, hint) {
  overlay.querySelector('#q-submit').disabled = true;
  try {
    // ── 先取图：QQ 图床 URL 会过期（老消息全网 400），
    //    让本地后端走 OneBot get_image 从 NapCat 缓存里把原图读出来转 dataURL，
    //      随消息一起上传 —— 服务器不再依赖 URL 时效。
    const mediaItems = [];
    const mediaOwners = [];   // 记录每个 item 属于哪条消息，方便回填
    for (const m of picked) {
      for (const x of (Array.isArray(m.media) ? m.media : [])) {
        if (x && (x.url || x.file)) {
          mediaItems.push({ file: x.file || '', url: x.url || '' });
          mediaOwners.push(m);
        }
      }
    }
    const dataUrls = new Map();   // message -> [dataUrl,...]
    if (mediaItems.length) {
      hint.textContent = `正在从本地缓存取图（${mediaItems.length} 张）…`;
      try {
        const r = await api('/api/media-data', {
          method: 'POST', body: JSON.stringify({ items: mediaItems })
        });
        (r.results || []).forEach((res, i) => {
          if (res?.dataUrl) {
            const m = mediaOwners[i];
            if (!dataUrls.has(m)) dataUrls.set(m, []);
            dataUrls.get(m).push(res.dataUrl);
          }
        });
        hint.textContent = `取到 ${[...dataUrls.values()].flat().length}/${mediaItems.length} 张图，上传中…`;
      } catch { hint.textContent = '取图失败（按无图上传），上传中…'; }
    } else {
      hint.textContent = '上传中…';
    }
    const res = await fetch(`${COMMUNITY_API}/holyshits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nickname,
        // 不传 chatKey / chatName：金句墙只展示时间和收录人，群信息不出本机
        captchaVerifyParam,
        messages: picked.map((m) => {
          const dus = dataUrls.get(m) || [];
          let di = 0;
          return {
            ts: m.ts, senderName: m.senderName, text: m.text,
            self: !!m.self,
            media: (Array.isArray(m.media) ? m.media : [])
              .filter((x) => x && (x.url || x.file))
              .map((x) => ({
                kind: 'image',
                url: x.url || '',
                file: x.file || '',
                // 取到就带上（服务器直接落盘）；取不到服务器再尝试 URL 下载
                ...(dus[di] ? { dataUrl: dus[di++] } : {})
              }))
          };
        })
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    localStorage.setItem('qqa-quote-nickname', nickname);
    closeModelModal(overlay);
    exitQuoteMode();
    showUploadToast('金句已收录！', 'https://kondius.cn/qq-agent/holyshits');
  } catch (err) {
    hint.textContent = `上传失败：${err.message}`;
    overlay.querySelector('#q-submit').disabled = false;
  }
}

// 顶栏按钮绑定
$('#feedback-btn')?.addEventListener('click', () => openFeedbackModal());
$('#open-site-btn')?.addEventListener('click', () => openSite());
$('#skill-market-btn')?.addEventListener('click', () => window.open('https://www.kondius.cn/qq-agent/skill-market/', '_blank', 'noopener'));
$('#plugin-market-btn')?.addEventListener('click', () => window.open('https://www.kondius.cn/qq-agent/plugin-market/', '_blank', 'noopener'));
$('#persona-plaza-btn')?.addEventListener('click', () => window.open('https://www.kondius.cn/qq-agent/persona-plaza/', '_blank', 'noopener'));
$('#quote-btn')?.addEventListener('click', () => {
  if (state.quoteMode) exitQuoteMode(); else enterQuoteMode();
});
$('#quote-confirm-btn')?.addEventListener('click', () => openQuoteConfirmModal());

// 会话列表「清空」：清空全部已结束的会话记录（保留运行中/等待中的）
$('#session-clear-btn')?.addEventListener('click', async () => {
  const total = (state.sessions || []).length;
  const running = (state.sessions || []).filter((s) => s.status === 'running' || s.status === 'waiting').length;
  if (!(await uiConfirm(`确定清空全部已结束的会话记录？\n\n共 ${total} 条，其中 ${running} 条运行中/等待中会保留。\n此操作不可恢复（不影响用量统计的历史数据）。`))) return;
  try {
    const r = await api('/api/sessions/clear-finished', { method: 'POST' });
    state.currentSessionId = null;
    $('#session-detail').innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
    await loadSessions({ quiet: true });
    renderSessionList();
  } catch (e) {
    alert(`清空失败：${e.message}`);
  }
});

// 会话列表「群发」：选若干群/私聊（或全选），发一条同样的消息。
// 走已存在的 /api/chats/:kind_:id/test-send 逐个发送（它会把消息记进存档，
// 与手动测试消息同一口径）；逐个发、逐个报结果，失败不中断后续目标。
$('#session-broadcast-btn')?.addEventListener('click', async () => {
  let groups = [], friends = [];
  try {
    const [g, f] = await Promise.all([api('/api/onebot/groups'), api('/api/onebot/friends')]);
    groups = g.groups || [];
    friends = f.friends || [];
  } catch (e) {
    alert(`拉取群/好友列表失败：${e.message}（OneBot 未连接？）`);
    return;
  }
  if (!groups.length && !friends.length) { alert('没拉到任何群和好友列表'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.dataset.animationShell = '1';
  const item = (kind, id, name) => `
    <label class="pick-item">
      <input type="checkbox" value="${kind}:${esc(String(id))}" />
      <span>${esc(name)}</span>
      <span class="muted">${esc(String(id))}</span>
    </label>`;
  overlay.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-head">群发消息（勾选目标后发送）</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button class="btn btn-small" id="bc-all-groups">全选群（${groups.length}）</button>
        <button class="btn btn-small" id="bc-all-friends">全选私聊（${friends.length}）</button>
        <button class="btn btn-small" id="bc-none">全不选</button>
      </div>
      <div class="modal-list">
        ${groups.length ? `<div class="muted" style="padding:4px 8px">群聊</div>` : ''}
        ${groups.map((g2) => item('group', g2.id, g2.name)).join('')}
        ${friends.length ? `<div class="muted" style="padding:4px 8px;margin-top:6px">私聊（好友）</div>` : ''}
        ${friends.map((f2) => item('private', f2.id, f2.name)).join('')}
      </div>
      <div class="field" style="margin-top:10px"><label>消息内容</label>
        <textarea id="bc-text" rows="3" placeholder="要发送的内容（所有勾选目标收到同一条）" style="width:100%"></textarea></div>
      <div id="bc-hint" class="muted" style="font-size:12px;margin-top:4px"></div>
      <div class="modal-foot">
        <button class="btn" id="bc-cancel">取消</button>
        <button class="btn btn-primary" id="bc-send">发送</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => closeAnimatedOverlay(overlay);
  overlay.querySelector('#bc-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const boxes = () => [...overlay.querySelectorAll('input[type=checkbox]')];
  const setChecked = (pred, on) => boxes().forEach((b) => { if (pred(b.value)) b.checked = on; });
  overlay.querySelector('#bc-all-groups').addEventListener('click', () => setChecked((v) => v.startsWith('group:'), true));
  overlay.querySelector('#bc-all-friends').addEventListener('click', () => setChecked((v) => v.startsWith('private:'), true));
  overlay.querySelector('#bc-none').addEventListener('click', () => setChecked(() => true, false));
  overlay.querySelector('#bc-send').addEventListener('click', async () => {
    const picked = boxes().filter((b) => b.checked).map((b) => b.value);
    const text = overlay.querySelector('#bc-text').value.trim();
    const hint = overlay.querySelector('#bc-hint');
    if (!picked.length) { hint.textContent = '先勾选至少一个目标'; return; }
    if (!text) { hint.textContent = '消息内容不能为空'; return; }
    const sendBtn = overlay.querySelector('#bc-send');
    sendBtn.disabled = true;
    const results = [];
    for (const key of picked) {
      const [kind, id] = key.split(':');
      try {
        await api(`/api/chats/${kind}_${id}/test-send`, { method: 'POST', body: JSON.stringify({ text }) });
        results.push(`✅ ${key}`);
      } catch (e) {
        results.push(`❌ ${key}：${e.message}`);
      }
      hint.textContent = `发送中… ${results.length}/${picked.length}`;
    }
    hint.textContent = `完成：${results.filter((r) => r.startsWith('✅')).length} 成功 / ${results.filter((r) => r.startsWith('❌')).length} 失败`;
    sendBtn.textContent = '已发送';
    sendBtn.disabled = false;
    setTimeout(close, 1600);
  });
});
