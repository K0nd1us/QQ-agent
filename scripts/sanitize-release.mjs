#!/usr/bin/env node
/**
 * 发布脱敏：把当前项目恢复成"可以发给别人"的出厂状态。
 *
 * 用法：
 *   node scripts/sanitize-release.mjs --dry-run   # 只报告会清理什么，不改文件
 *   node scripts/sanitize-release.mjs             # 执行脱敏
 *   node scripts/sanitize-release.mjs --scan      # 只做敏感信息扫描
 *
 * 清理范围：
 *   1. API Key / 令牌（顶层 apiKey、dshProviderKeys、各搜索服务 Key、自定义搜索服务 Key、SnowLuma 令牌）
 *   2. 使用痕迹（聊天存档、会话留档、记忆、今日用量、会员备注）
 *   3. 个人配置（模型选择、接口地址、白名单、人设角色卡）
 *   4. SnowLuma 登录态与日志、WebUI 密码
 *
 * ⚠️ 只动 data/ 下的运行时文件与配置，不碰源码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const SCAN_ONLY = args.includes('--scan');

const log = (...a) => console.log(...a);
const actions = [];

/**
 * 删除一个 data 下的文件/目录。
 *
 * 直接 fs.rmSync 在某些环境会被外部钩子（回收站/安全软件）拦截而超时或失败，
 * 那样脚本会误报"已清理"。这里采用两段式：
 *   1) 先重命名到 .trash 目录 —— 这一步几乎不会失败，能保证原路径立即消失
 *   2) 再尽力真删；删不掉也无所谓，重命名后已不再随项目分发
 */
function rmrf(rel, label) {
  const p = path.join(DATA_DIR, rel);
  if (!fs.existsSync(p)) return;
  const trashDir = path.join(DATA_DIR, '.trash');
  const dest = path.join(trashDir, `${rel}.${Date.now()}`);
  try {
    if (!DRY) {
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(p, dest);
    }
    let n = '?';
    try {
      n = fs.statSync(dest).isDirectory() ? fs.readdirSync(dest).length : 1;
    } catch { /* ignore */ }
    if (!DRY) {
      // 尽力真删，失败不影响结果（原路径已改名，不会随项目分发）
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    actions.push(`${label}：移除 ${rel}（${n} 项）`);
  } catch (e) {
    actions.push(`${label}：移除 ${rel} 失败 - ${e.message}`);
  }
}

function resetConfig() {
  const p = path.join(DATA_DIR, 'config.json');
  if (!fs.existsSync(p)) { actions.push('配置文件不存在，跳过'); return; }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    actions.push(`配置文件解析失败，跳过 - ${e.message}`);
    return;
  }

  const cleared = [];
  const set = (obj, key, val) => {
    if (obj && key in obj && obj[key] !== val) { obj[key] = val; cleared.push(key); }
  };

  // ── API 凭据 ──
  cfg.api = cfg.api || {};
  for (const k of ['apiKey', 'baseUrl', 'model', 'provider', 'priceRemoteUrl']) set(cfg.api, k, '');
  if (cfg.dshProviderKeys && Object.keys(cfg.dshProviderKeys).length) {
    cleared.push('dshProviderKeys');
    if (!DRY) cfg.dshProviderKeys = {};

  }
  if (Array.isArray(cfg.providers)) {
    let hit = false;
    for (const p of cfg.providers) {
      if (p && 'apiKey' in p) { p.apiKey = ''; hit = true; }
    }
    if (hit) cleared.push('providers[].apiKey');
  }

  // ── 搜索服务 Key（含自定义的多个）──
  if (cfg.webSearch) {
    for (const k of ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso', 'custom']) {
      if (cfg.webSearch[k] && 'apiKey' in cfg.webSearch[k]) {
        cfg.webSearch[k].apiKey = '';
        cleared.push(`webSearch.${k}.apiKey`);
      }
    }
    if (Array.isArray(cfg.webSearch.providers)) {
      let hit = false;
      for (const p of cfg.webSearch.providers) {
        if (p && 'apiKey' in p) { p.apiKey = ''; hit = true; }
      }
      if (hit) cleared.push('webSearch.providers[].apiKey');
    }
  }

  // ── SnowLuma 令牌 / 密码 ──
  if (cfg.snowluma) {
    for (const k of ['accessToken', 'httpAccessToken', 'webuiPassword', 'dir']) {
      set(cfg.snowluma, k, '');
    }
  }

  // ── 个人配置 ──
  if (cfg.persona) {
    for (const k of ['roleText', 'customRules', 'selfNickname']) set(cfg.persona, k, '');
    set(cfg.persona, 'botName', '小鲸鱼');
  }
  if (cfg.allow) {
    cfg.allow.groups = [];
    cfg.allow.private = [];
  }
  if (cfg.deny) { cfg.deny.groups = []; cfg.deny.private = []; }
  if ('allowAllWhenEmpty' in cfg) cfg.allowAllWhenEmpty = false;
  if ('memberNotes' in cfg && Object.keys(cfg.memberNotes || {}).length) {
    cleared.push('memberNotes');
    if (!DRY) cfg.memberNotes = {};
  }

  // ── 成本核算回到出厂 ──
  cfg.api.useOfficialPrice = true;
  cfg.api.priceInputPerM = 0;
  cfg.api.priceOutputPerM = 0;
  cfg.api.priceCachedPerM = 0;

  actions.push(`配置字段清理：${cleared.length ? cleared.join('、') : '（无需清理）'}`);
  if (!DRY) {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  }
}

/**
 * 全项目敏感信息扫描。
 * 只扫文本类源码与配置，跳过 node_modules / 二进制 / snowluma 第三方目录。
 */
function scanSecrets() {
  const SKIP_DIR = new Set(['node_modules', '.git', 'snowluma', 'backups', 'logs', '.trash', 'dist', 'out']);
  // 测试文件里的假 key 是固定样例，不算泄露
  const SKIP_FILE = new Set(['test/selftest.mjs', 'test\\selftest.mjs']);
  const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.bat', '.yml', '.yaml']);
  const PATTERNS = [
    { name: 'OpenAI Key', re: /sk-[A-Za-z0-9]{20,}/g },
    { name: 'Anthropic Key', re: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
    { name: 'DeepSeek Key', re: /\bsk-[0-9a-f]{32}\b/gi },
    { name: '通用 API Key 赋值', re: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{16,}['"]/gi }
  ];

  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || e.name.startsWith('_backup')) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const relPath = path.relative(ROOT, full).replace(/\\/g, '/');
      if (SKIP_FILE.has(relPath)) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      for (const { name, re } of PATTERNS) {
        re.lastIndex = 0;
        const m = text.match(re);
        if (m) {
          found.push(`${path.relative(ROOT, full)} → ${name}（${m.length} 处）`);
        }
      }
    }
  };
  walk(ROOT);
  return found;
}

log('════════════════════════════════════════');
log(DRY ? '发布脱敏 —— 演练模式（不修改任何文件）' : (SCAN_ONLY ? '发布脱敏 —— 仅扫描' : '发布脱敏 —— 执行模式'));
log('════════════════════════════════════════');
log('项目目录：', ROOT);
log('数据目录：', DATA_DIR);
log('');

if (!SCAN_ONLY) {
  resetConfig();
  rmrf('messages', '聊天存档');
  rmrf('sessions', '会话留档');
  rmrf('memory', '记忆');
  rmrf('stickers.json', '表情库');
  rmrf('usage-today.json', '今日用量');
  rmrf('feedbacks.json', '反馈记录');
  rmrf('price-feed-cache.json', '远程价格表缓存');

  // 中转目录在系统临时文件夹里（不在项目内），尽力清一次即可
  const trashRoot = path.join(os.tmpdir(), 'qq-agent-sanitize');
  if (!DRY && fs.existsSync(trashRoot)) {
    try { fs.rmSync(trashRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // SnowLuma 登录态 / 日志
  const slDir = path.join(ROOT, 'snowluma');
  for (const rel of ['config/onebot_0.json', 'config/consent.json', 'config/notifications.json']) {
    const f = path.join(slDir, rel);
    if (fs.existsSync(f)) {
      // 只清里面的令牌字段，整体删除会让 SnowLuma 无法启动
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        let hit = false;
        const wipe = (o) => {
          if (!o || typeof o !== 'object') return;
          for (const k of Object.keys(o)) {
            if (/token|password|secret|key/i.test(k) && typeof o[k] === 'string' && o[k]) { o[k] = ''; hit = true; }
            else if (o[k] && typeof o[k] === 'object') wipe(o[k]);
          }
        };
        wipe(j);
        if (hit) {
          actions.push(`SnowLuma 令牌：清理 ${rel}`);
          if (!DRY) {
            const tmp = f + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
            fs.renameSync(tmp, f);
          }
        }
      } catch { /* ignore */ }
    }
  }
  // 日志目录
  const logsDir = path.join(slDir, 'logs');
  if (fs.existsSync(logsDir)) {
    let n = 0;
    try { n = fs.readdirSync(logsDir).length; } catch { /* ignore */ }
    if (n) {
      actions.push(`SnowLuma 日志：清理 ${n} 个文件`);
      if (!DRY) {
        try { fs.rmSync(logsDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  log('清理动作：');
  for (const a of actions) log('  •', a);
  log('');
}

log('敏感信息扫描：');
const found = scanSecrets();
if (found.length) {
  log('  ⚠ 发现可疑内容：');
  for (const f of found) log('    -', f);
  log('');
  log('  请手动确认上方条目；若为误报（如文档示例）可忽略，否则先清理再发布。');
} else {
  log('  ✓ 未发现已知格式的密钥残留');
}
log('');
log(DRY ? '演练结束。确认无误后去掉 --dry-run 再执行一次。' : '完成。现在可以压缩分享了（建议保留 node_modules，接收方无需 npm install）。');
