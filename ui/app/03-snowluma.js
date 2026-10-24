// 〔SnowLuma 页签〕——M9 拆分第 4 段
'use strict';
// ── SnowLuma 独立页签 ──
/**
 * 只刷新日志区（不重建整个页面）。
 * SSE 每来一条新日志就调一次 —— 整页 innerHTML 重建会重绘、丢滚动、还拖帧。
 * 三个日志框各刷各的：QQ / SnowLuma / 应用。
 */
async function refreshSnowlumaLogs() {
  const box = $('#snowluma-page');
  if (!box) return;
  const slPre = box.querySelector('#sl-logs-view');
  const qqPre = box.querySelector('#qq-logs-view');
  const appPre = box.querySelector('#app-logs-view');
  if (!slPre && !qqPre && !appPre) return;   // 页面还没渲染过，等下次整页刷新
  try {
    const [logs, qqLogs, appLogsData] = await Promise.all([
      api('/api/snowluma/logs'),
      api('/api/qq-portable/logs').catch(() => ({ logs: [] })),
      api('/api/logs?limit=120').catch(() => ({ logs: [] }))
    ]);
    const fmt = (arr) => (arr || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    const setLog = (pre, text) => {
      if (!pre) return;
      // 先记贴底状态再换内容：往上翻历史时绝不把用户拽回底部
      const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
      pre.textContent = text;
      if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
    };
    setLog(slPre, fmt(logs.logs));
    setLog(qqPre, fmt(qqLogs.logs));
    if (appPre) {
      const appText = (appLogsData.logs || []).map((e) => {
        const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
        const lv = String(e.level || 'info').toUpperCase().padEnd(5);
        return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
      }).join('\n') || '暂无日志';
      setLog(appPre, appText);
    }
  } catch { /* 刷新失败静默，不影响主流程 */ }
}

// 整页重建节流：状态事件可能连着来（启动 QQ + SnowLuma + OneBot），
// 不节流会连续三四次 Promise.all + innerHTML 重绘。
let slFullReloadTimer = null;
function scheduleSnowlumaReload(opts = {}) {
  if (slFullReloadTimer) return;
  slFullReloadTimer = setTimeout(() => {
    slFullReloadTimer = null;
    loadSnowlumaPage({ quiet: true });
  }, 400);
}

async function loadSnowlumaPage({ quiet = false } = {}) {
  try {
    const [status, logs, qqLogs, appLogsData] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs'),
      api('/api/qq-portable/logs'),
      api('/api/logs?limit=120').catch(() => ({ logs: [], level: 'info' }))
    ]);
    const s = status;
    const isMacOS = s.platform === 'darwin' || /Mac/i.test(navigator.platform || '');
    const mac = s.macProtocol || {};
    const box = $('#snowluma-page');
    if (!box) return;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    // 便携 QQ 状态
    const qq = s.qqPortable || {};
    const qqReady = !!qq.ready;
    const qqRunning = !!qq.running;
    const qqPid = qq.pid ?? null;
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    const qqLogText = (qqLogs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    // 应用日志（logger 的内存环形缓冲）
    const appLogs = appLogsData.logs || [];
    const appLogLevel = appLogsData.level || 'info';
    const appLogText = appLogs.map((e) => {
      const t = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
      const lv = String(e.level || 'info').toUpperCase().padEnd(5);
      return `[${t}] [${lv}] [${e.module || '-'}] ${e.text}`;
    }).join('\n') || '暂无日志';

    // 整页重建前记住日志滚动位置：SSE/轮询触发的 quiet 重建会重置 DOM，
    // 不补偿的话用户往下翻日志会被弹回顶部（Kondius 实测：划两下就蹦上去）
    const oldPre = box.querySelector('#sl-logs-view');
    const prevScroll = oldPre
      ? { top: oldPre.scrollTop, atBottom: oldPre.scrollTop + oldPre.clientHeight >= oldPre.scrollHeight - 40 }
      : null;
    const oldAppPre = box.querySelector('#app-logs-view');
    const prevAppScroll = oldAppPre
      ? { top: oldAppPre.scrollTop, atBottom: oldAppPre.scrollTop + oldAppPre.clientHeight >= oldAppPre.scrollHeight - 40 }
      : null;

    box.innerHTML = `
      <div class="snowluma-page-card">
        <h2>${isMacOS ? '协议端（SnowLuma Docker）' : 'SnowLuma（OneBot 网关）'}</h2>

        <!-- 一键启动区域（核心入口） -->
        ${!onebotConnected ? `
        <div class="quick-start-section" style="background:var(--bg);border:none;border-radius:14px;padding:16px;margin-bottom:16px;box-shadow:var(--raise-sm)">
          <div style="font-size:15px;font-weight:600;margin-bottom:8px">🚀 快速启动</div>
          <div class="muted" style="font-size:13px;margin-bottom:12px;line-height:1.6">
            ${isMacOS
              ? (!qqReady
                  ? 'macOS 协议端未安装：需要 Docker Desktop + 官方 SnowLuma 镜像（首次约 1~2GB）'
                  : !running
                    ? '点击启动 SnowLuma 容器，然后在 noVNC 桌面用手机 QQ 扫码登录'
                    : 'SnowLuma 已运行，等待 OneBot 连接（登录成功后自动连上）…')
              : (!qqReady ? '便携 QQ 未安装，请先运行 <code>npm run setup</code>' :
                  !qqRunning ? '点击下面按钮，自动完成：启动 QQ → 启动 SnowLuma → 连接 OneBot' :
                  !running ? 'QQ 已运行，点击启动 SnowLuma 并连接' :
                  'SnowLuma 已运行，等待 OneBot 连接…')}
          </div>
          <button class="btn btn-primary" id="quick-start-btn" style="font-size:14px;padding:10px 20px" ${(!isMacOS && !qqReady) ? 'disabled' : ''}>
            ${isMacOS
              ? (!qqReady ? '安装 macOS 协议端（SnowLuma）' : !running ? '一键启动 SnowLuma' : '等待连接…')
              : (!qqReady ? '请先运行 npm run setup' :
                  !qqRunning ? '一键启动（QQ + SnowLuma）' :
                  !running ? '启动 SnowLuma' :
                  '等待连接…')}
          </button>
          <span id="quick-start-hint" class="muted" style="font-size:12px;margin-left:12px"></span>
        </div>` : ''}

        ${isMacOS ? `
        <div class="quick-start-section" style="background:var(--bg);border:none;border-radius:14px;padding:16px;margin-bottom:16px;box-shadow:var(--raise-sm)">
          <div style="font-size:15px;font-weight:600;margin-bottom:8px">扫码桌面（noVNC）</div>
          <div class="muted" style="font-size:13px;margin-bottom:10px;line-height:1.6">
            首次登录在浏览器里的 Linux QQ 窗口扫码；密码 <code>${esc(mac.vncPassword || 'qqagent')}</code>。
            登录成功后 OneBot 会在 3001 监听，控制台自动连接。
          </div>
          <button class="btn" id="mac-open-novnc-btn" ${running ? '' : 'disabled'}>打开扫码桌面</button>
          <button class="btn btn-small" id="mac-repair-vnc-btn" ${running ? '' : 'disabled'} title="页面一直卡在“连接中…”时点这里">连不上？修复</button>
          <span class="muted" style="font-size:12px;margin-left:10px">${esc(mac.novncUrl || 'http://127.0.0.1:6081/')}</span>
        </div>
        <div class="quick-start-section" style="background:var(--bg);border:none;border-radius:14px;padding:16px;margin-bottom:16px;box-shadow:var(--raise-sm)">
          <div style="font-size:15px;font-weight:600;margin-bottom:8px">🔑 SnowLuma WebUI（首次引导）</div>
          <div class="muted" style="font-size:13px;margin-bottom:10px;line-height:1.6">
            首次打开需要输入初始密码（只打印一次）：<code>${esc(mac.webuiPassword || '见下方日志 / 首次启动日志')}</code>；
            登录后先同意 EULA、设置新密码，再按引导扫码登录 QQ、确认 OneBot 连接。
          </div>
          <button class="btn" id="mac-open-webui-btn" ${running ? '' : 'disabled'}>打开 WebUI</button>
          <span class="muted" style="font-size:12px;margin-left:10px">${esc(webuiUrl || 'http://127.0.0.1:5099/')}</span>
        </div>` : ''}

        <!-- 便携 QQ 内核状态 -->
        <div class="snowluma-qq-section">
          <div class="snowluma-state-row">
            <span class="dot ${qqRunning ? 'dot-on' : 'dot-off'}"></span>
            <span>${isMacOS ? 'SnowLuma 容器' : 'QQ 内核'}：<strong>${qqRunning ? `运行中${qqPid ? `（pid ${qqPid}）` : ''}` : (qqReady ? '未启动' : '未安装')}</strong></span>
            ${!qqReady ? `<span class="muted" style="color:var(--orange)">${isMacOS ? '点击上方「安装 macOS 协议端」' : '请先运行 npm run setup'}</span>` : ''}
          </div>
          ${qqReady ? `
          <div class="snowluma-state-row muted" style="font-size:12px">
            <span>目录：${esc(qq.dir || '')}</span>
          </div>` : ''}
          <div class="snowluma-actions">
            <button class="btn btn-small" id="qq-start-btn" ${!qqReady || qqRunning ? 'disabled' : ''}>${qqRunning ? '已运行' : (isMacOS ? '启动 SnowLuma' : '单独启动 QQ')}</button>
            <button class="btn btn-small btn-danger" id="qq-stop-btn" ${!qqRunning ? 'disabled' : ''}>${isMacOS ? '关闭 SnowLuma' : '关闭 QQ'}</button>
            <span id="qq-hint" class="muted" style="font-size:12px"></span>
          </div>
          ${qqLogText !== '暂无日志' ? `
          <div class="sl-log-block">
            <div class="hint sl-log-head">${isMacOS ? '容器日志' : 'QQ 日志'}</div>
            <pre class="snowluma-logs-view" id="qq-logs-view" style="max-height:120px">${esc(qqLogText)}</pre>
          </div>` : ''}
        </div>

        <hr class="sl-sep">

        <!-- SnowLuma 状态 -->
        <div class="snowluma-qq-section">
          <div class="snowluma-state-row">
            <span class="dot ${running ? 'dot-on' : 'dot-off'}"></span>
            <span>${isMacOS ? 'SnowLuma 容器' : 'SnowLuma'}：<strong>${running ? '运行中' : '未运行'}</strong></span>
            ${pid ? `<span class="muted">pid ${pid}</span>` : ''}
            <span class="muted">${isMacOS ? (running ? 'Docker 容器（随应用启停）' : '') : (embedded ? '内置模式（随 QQ Agent 退出）' : (running ? '独立模式' : ''))}</span>
          </div>
          <div class="snowluma-state-row">
            <span class="dot ${onebotConnected ? 'dot-on' : 'dot-off'}"></span>
            <span>OneBot：<strong>${onebotConnected ? `已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}` : '未连接'}</strong></span>
            <span class="muted">WS ${s.onebot?.error ? `：${s.onebot.error}` : ''}</span>
          </div>
          <div class="snowluma-state-row muted">
            <span>${isMacOS ? '运行目录' : '目录'}：${esc(dir || (isMacOS ? '（未安装）' : '（未找到项目内 snowluma/ 文件夹）'))}</span>
          </div>
          <div class="snowluma-state-row">
            <span>WebUI：</span>
            ${webuiUrl
              ? `<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">${esc(webuiUrl)}</button>`
              : '<span class="muted">等待 SnowLuma 启动后自动识别…</span>'}
            ${isMacOS && running ? `<button class="btn btn-small" id="sl-open-novnc-btn" title="打开 noVNC 里的 QQ 窗口扫码">扫码桌面</button>` : ''}
          </div>
          <div class="snowluma-actions">
            <button class="btn btn-primary" id="sl-start-btn" ${running ? 'disabled' : ''}>${running ? '已运行' : '启动 SnowLuma'}</button>
            <button class="btn btn-danger" id="sl-stop-btn" ${running ? '' : 'disabled'}>关闭 SnowLuma</button>
            <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
            <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
            <span id="sl-hint" class="muted" style="font-size:12px"></span>
          </div>
        </div>
        <div class="sl-log-block">
          <div class="hint sl-log-head">运行日志（仅保留最近 500 行）</div>
          <pre class="snowluma-logs-view" id="sl-logs-view">${esc(logText)}</pre>
        </div>

        <!-- 应用日志：logger.js 的内存环形缓冲 + data/logs/ 落盘文件。 -->
        <div class="sl-log-block sl-app-logs">
          <div class="hint sl-log-head">
            <span>应用日志（最近 ${appLogs.length} 条，同时落盘到 data/logs/）</span>
            <label class="sl-log-level">
              <span class="muted">落盘级别</span>
              <select id="app-log-level" title="低于该级别的日志不写入磁盘">
                ${['debug', 'info', 'warn', 'error'].map((v) =>
                  `<option value="${v}" ${appLogLevel === v ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </label>
            <button class="btn btn-small" id="app-logs-refresh-btn" title="重新拉取最近日志">刷新</button>
          </div>
          <pre class="snowluma-logs-view" id="app-logs-view">${esc(appLogText)}</pre>
        </div>
      </div>`;

    // 恢复日志滚动：贴底跟随新日志；否则回到原阅读位置；首次渲染贴底
    const newPre = box.querySelector('#sl-logs-view');
    if (newPre) newPre.scrollTop = prevScroll ? (prevScroll.atBottom ? newPre.scrollHeight : prevScroll.top) : newPre.scrollHeight;
    const newAppPre = box.querySelector('#app-logs-view');
    if (newAppPre) newAppPre.scrollTop = prevAppScroll ? (prevAppScroll.atBottom ? newAppPre.scrollHeight : prevAppScroll.top) : newAppPre.scrollHeight;

    // ── 应用日志：级别切换 + 手动刷新 ──
    if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
    const appLevelSel = $('#app-log-level');
    if (appLevelSel) {
      appLevelSel.addEventListener('change', async () => {
        try {
          const r = await api('/api/logs/level', { method: 'POST', body: JSON.stringify({ level: appLevelSel.value }) });
          if (r && r.level) appLevelSel.value = r.level;
          loadSnowlumaPage({ quiet: true });
        } catch (e) {
          alert(`设置日志级别失败：${e.message}`);
        }
      });
    }
    const appLogsRefreshBtn = $('#app-logs-refresh-btn');
    if (appLogsRefreshBtn) appLogsRefreshBtn.addEventListener('click', () => loadSnowlumaPage());

    // ── 一键启动按钮事件 ──
    const quickStartBtn = $('#quick-start-btn');
    if (quickStartBtn) quickStartBtn.addEventListener('click', async () => {
      const btn = $('#quick-start-btn');
      const hint = $('#quick-start-hint');
      btn.disabled = true;
      hint.textContent = '';

      try {
        // macOS：协议端未安装时，按钮变成「安装」——跑 setup 脚本（Docker + 镜像）
        if (isMacOS && !qqReady) {
          btn.textContent = '安装中（拉取 SnowLuma 镜像）…';
          hint.textContent = '首次约 1~2GB；Docker 未启动会自动拉起，进度见下方日志';
          const r = await api('/api/mac/install', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            hint.textContent = `安装失败：${r.error}`;
            btn.disabled = false;
            btn.textContent = '重试安装';
            return;
          }
          // 轮询安装状态（镜像下载可能很久，最多 30 分钟）
          for (let i = 0; i < 600; i++) {
            await new Promise((r2) => setTimeout(r2, 3000));
            const st = await api('/api/status');
            const mp = st.macProtocol || {};
            if (mp.ready) {
              hint.textContent = '✅ 安装完成，正在启动 SnowLuma…';
              break;
            }
            if (!mp.installing && i > 1) {
              hint.textContent = '安装进程已结束，但状态仍未就绪，请查看下方安装日志';
              btn.disabled = false;
              btn.textContent = '重新安装';
              return;
            }
            hint.textContent = `正在安装…（已等待 ${(i + 1) * 3}s）`;
          }
          const started = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
          if (!started.ok && !started.alreadyRunning) {
            hint.textContent = `SnowLuma 启动失败：${started.error}`;
            btn.disabled = false;
            btn.textContent = '重试启动';
            return;
          }
          btn.textContent = '等待 OneBot 连接…';
          hint.textContent = '请打开上方 noVNC 桌面扫码登录；登录后自动连上';
          setTimeout(() => loadSnowlumaPage({ quiet: true }), 2000);
          return;
        }

        // 步骤 1：启动便携 QQ（如果未运行）
        if (!qqRunning) {
          btn.textContent = isMacOS ? '启动 SnowLuma 容器中…' : '启动 QQ 中…';
          hint.textContent = isMacOS
            ? '容器首次启动约 30~60 秒；起来后打开 noVNC 扫码'
            : '请在弹出的 QQ 窗口扫码登录';
          const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            hint.textContent = `QQ 启动失败：${r.error}`;
            btn.disabled = false;
            btn.textContent = '一键启动（QQ + SnowLuma）';
            return;
          }
          // 等 3 秒让 QQ 完全启动
          await new Promise((r) => setTimeout(r, 3000));
        }

        // 步骤 2：启动 SnowLuma（如果未运行）
        if (!running) {
          btn.textContent = '启动 SnowLuma 中…';
          hint.textContent = isMacOS ? '正在启动 SnowLuma 容器…' : '正在启动协议端…';
          const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
          if (!r.ok && !r.alreadyRunning) {
            hint.textContent = `SnowLuma 启动失败：${r.error}`;
            btn.disabled = false;
            btn.textContent = '一键启动（QQ + SnowLuma）';
            return;
          }
        }

        // 步骤 3：等待 OneBot 连接
        btn.textContent = '等待 OneBot 连接…';
        hint.textContent = isMacOS
          ? '请打开 noVNC 桌面扫码登录；登录后 OneBot 自动连接'
          : '首次登录可能需要几秒到几十秒';

        // 轮询检查连接状态（最多 30 秒）
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const s = await api('/api/status');
          if (s.onebot?.connected) {
            hint.textContent = '✅ 已连接！机器人开始工作';
            btn.textContent = '已连接 ✓';
            setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
            return;
          }
        }
        hint.textContent = '连接超时，请检查日志或手动刷新';
        btn.disabled = false;
        btn.textContent = '重试';
      } catch (e) {
        hint.textContent = `启动失败：${e.message}`;
        btn.disabled = false;
        btn.textContent = '一键启动（QQ + SnowLuma）';
      }
    });

    // ── 便携 QQ 按钮事件 ──
    const qqStartBtn = $('#qq-start-btn');
    if (qqStartBtn) qqStartBtn.addEventListener('click', async () => {
      const btn = $('#qq-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#qq-hint').textContent = '';
      try {
        const r = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
        $('#qq-hint').textContent = r.alreadyRunning ? '便携 QQ 已在运行 ✓' : (r.ok ? '已启动，请在弹出的 QQ 窗口扫码登录' : `启动失败：${r.error}`);
      } catch (e) {
        $('#qq-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    const qqStopBtn = $('#qq-stop-btn');
    if (qqStopBtn) qqStopBtn.addEventListener('click', async () => {
      const btn = $('#qq-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#qq-hint').textContent = '';
      try {
        const r = await api('/api/qq-portable/stop', { method: 'POST', body: '{}' });
        $('#qq-hint').textContent = r.ok ? '已请求关闭便携 QQ' : `关闭失败：${r.error}`;
      } catch (e) {
        $('#qq-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });

    $('#sl-start-btn').addEventListener('click', async () => {
      const btn = $('#sl-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#sl-hint').textContent = '';
      try {
        const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。首次 QQ 登录需要几秒到几十秒。' : `启动失败：${r.error}`);
      } catch (e) {
        $('#sl-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    $('#sl-stop-btn').addEventListener('click', async () => {
      const btn = $('#sl-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#sl-hint').textContent = '';
      try {
        await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = '已请求关闭 SnowLuma。';
      } catch (e) {
        $('#sl-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });
    $('#sl-refresh-btn').addEventListener('click', () => loadSnowlumaPage());
    $('#sl-open-folder-btn').addEventListener('click', async () => {
      try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
      catch (e) { $('#sl-hint').textContent = `失败：${e.message}`; }
    });
    const webuiBtn = $('#sl-open-webui-btn');
    if (webuiBtn) webuiBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
        if (!r.ok) $('#sl-hint').textContent = r.error;
      } catch (e) {
        $('#sl-hint').textContent = `打开失败：${e.message}`;
      }
    });
    // macOS：noVNC 扫码桌面（Electron 会把它交给系统默认浏览器）
    for (const id of ['mac-open-novnc-btn', 'sl-open-novnc-btn']) {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', () => {
        const url = mac.novncUrl || 'http://127.0.0.1:6081/';
        try { window.open(url, '_blank'); }
        catch { location.href = url; }
      });
    }
    const repairBtn = document.getElementById('mac-repair-vnc-btn');
    if (repairBtn) repairBtn.addEventListener('click', async () => {
      repairBtn.disabled = true;
      repairBtn.textContent = '修复中…';
      try {
        const r = await api('/api/mac/repair-vnc', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = r.ok ? '扫码桌面已重启，请刷新 noVNC 页面' : `修复失败：${r.error || r.detail}`;
      } catch (e) {
        $('#sl-hint').textContent = `修复失败：${e.message}`;
      }
      setTimeout(() => { repairBtn.disabled = false; repairBtn.textContent = '连不上？修复'; }, 4000);
    });
    const macWebuiBtn = document.getElementById('mac-open-webui-btn');
    if (macWebuiBtn) macWebuiBtn.addEventListener('click', () => {
      const url = webuiUrl || 'http://127.0.0.1:5099/';
      try { window.open(url, '_blank'); }
      catch { location.href = url; }
    });
  } catch (e) {
    if (!quiet) console.error(e);
  }
}
