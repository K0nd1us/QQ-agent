/* 多账号：在 0.5 控制台顶栏放一个「返回账号中心」入口。
 * 单号直接运行时 /api/account-context 返回 multiAccount:false，本脚本不改变界面。 */
(() => {
  'use strict';

  function inject(ctx) {
    const controls = document.querySelector('.runtime-controls');
    if (!controls || document.getElementById('account-center-link')) return;
    const link = document.createElement('a');
    link.id = 'account-center-link';
    link.href = ctx.hubUrl;
    link.textContent = '← 账号中心';
    link.title = ctx.accountName ? `当前账号：${ctx.accountName}` : '返回账号中心';
    link.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:0 9px;height:26px;'
      + 'border:1px solid currentColor;border-radius:5px;color:inherit;text-decoration:none;'
      + 'font-size:11px;opacity:.82;white-space:nowrap';
    const pause = document.getElementById('pause-btn');
    if (pause && pause.parentElement === controls) controls.insertBefore(link, pause);
    else controls.appendChild(link);

    if (ctx.accountName) {
      const chip = document.createElement('span');
      chip.id = 'account-name-chip';
      chip.textContent = `账号：${ctx.accountName}`;
      chip.title = `账号 ID：${ctx.accountId || '-'}`;
      chip.style.cssText = 'font-size:11px;opacity:.7;white-space:nowrap';
      controls.insertBefore(chip, link);
    }
  }

  async function boot() {
    try {
      const res = await fetch('/api/account-context');
      if (!res.ok) return;
      const ctx = await res.json();
      if (ctx && ctx.multiAccount && ctx.hubUrl) inject(ctx);
    } catch {
      /* 旧后端 / 启动瞬间失败：静默 */
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
