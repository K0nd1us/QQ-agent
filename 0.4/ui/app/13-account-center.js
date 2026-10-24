/* 多账号：在账号控制台顶部放一个「返回账号中心」入口。
 *
 * 单账号直接运行时 /api/account-context 返回 multiAccount:false，本脚本什么也不做，
 * 界面与旧版完全一致。只有由账号中心 worker 启动时才注入入口。
 */
(() => {
  'use strict';

  function inject(ctx) {
    const status = document.querySelector('.top-status');
    if (!status || document.getElementById('account-center-link')) return;
    const link = document.createElement('a');
    link.id = 'account-center-link';
    link.className = 'btn btn-small';
    link.href = ctx.hubUrl;
    link.textContent = '← 账号中心';
    link.title = ctx.accountName
      ? `当前账号：${ctx.accountName}（点击返回账号中心）`
      : '返回账号中心';
    link.style.textDecoration = 'none';
    link.style.display = 'inline-flex';
    link.style.alignItems = 'center';
    // 放在主题按钮之前：左侧是状态胶囊，右侧是控件，符合现有视觉层级。
    const themeBtn = document.getElementById('theme-btn');
    if (themeBtn && themeBtn.parentElement === status) status.insertBefore(link, themeBtn);
    else status.appendChild(link);

    if (ctx.accountName) {
      const chip = document.createElement('span');
      chip.id = 'account-name-chip';
      chip.className = 'muted';
      chip.style.marginRight = '4px';
      chip.textContent = `账号：${ctx.accountName}`;
      chip.title = `账号 ID：${ctx.accountId || '-'}`;
      const chips = document.querySelector('.top-chips');
      if (chips) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        chips.append(sep, chip);
      }
    }
  }

  async function boot() {
    try {
      const res = await fetch('/api/account-context', { headers: { 'x-console-token': 'qq-agent-console' } });
      if (!res.ok) return;
      const ctx = await res.json();
      if (ctx && ctx.multiAccount && ctx.hubUrl) inject(ctx);
    } catch {
      /* 老版本后端 / 页面刚启动时失败：静默，不影响控制台 */
    }
  }

  boot();
})();
