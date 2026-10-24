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
 *   2) 再尽力真删；真删失败会在结尾的 .trash 残留检查里**阻断发布**
 *      （原注释说"删不掉也无所谓"是错的：压缩项目目录时 .trash 仍在包内）
 */
let trashFailed = false;
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
      try { fs.rmSync(dest, { recursive: true, force: true }); }
      catch { trashFailed = true; }
    }
    actions.push(`${label}：移除 ${rel}（${n} 项）`);
  } catch (e) {
    actions.push(`${label}：移除 ${rel} 失败 - ${e.message}`);
    trashFailed = true;
  }
}

/**
 * 删除项目根目录的 community.key（社区管理密钥）。
 * 与 data/ 下的运行时文件不同，它在项目根 —— rmrf 的路径拼的是 DATA_DIR，
 * 所以单独处理。删除失败必须阻断发布（scanSecrets 也会再次兜底告警）。
 */
function rmrfRootKey() {
  const p = path.join(ROOT, 'community.key');
  if (!fs.existsSync(p)) { actions.push('community.key：不存在，跳过'); return; }
  if (!DRY) {
    try { fs.rmSync(p, { force: true }); actions.push('community.key：已删除（管理密钥不随包分发）'); }
    catch (e) { actions.push(`community.key：删除失败 - ${e.message}`); trashFailed = true; }
  } else {
    actions.push('community.key：将删除（管理密钥不随包分发）');
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

  // ── 使用痕迹：含 QQ 号/群号的字段（blocklist 屏蔽成员、globalBlocklist、
  //    commandMute.active 禁言中的群、groupSliderPos 分群档位的群号键）──
  if (cfg.blocklist && Object.keys(cfg.blocklist).length) {
    cleared.push('blocklist');
    if (!DRY) cfg.blocklist = {};
  }
  if (Array.isArray(cfg.globalBlocklist) && cfg.globalBlocklist.length) {
    cleared.push('globalBlocklist');
    if (!DRY) cfg.globalBlocklist = [];
  }
  if (cfg.commandMute?.active && Object.keys(cfg.commandMute.active).length) {
    cleared.push('commandMute.active');
    if (!DRY) cfg.commandMute.active = {};
  }
  if (cfg.store?.groupSliderPos && Object.keys(cfg.store.groupSliderPos).length) {
    cleared.push('store.groupSliderPos');
    if (!DRY) cfg.store.groupSliderPos = {};
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
  const SKIP_DIR = new Set(['node_modules', '.git', 'snowluma', 'backups', '.trash', 'dist', 'out']);
  // 测试文件里的假 key 是固定样例，不算泄露
  const SKIP_FILE = new Set([
    'test/selftest.mjs', 'test\\selftest.mjs',
    'test/_harness.mjs', 'test\\_harness.mjs',
    'test/coverage-http.mjs', 'test\\coverage-http.mjs',
    'test/coverage-offline.mjs', 'test\\coverage-offline.mjs',
    'test/coverage-e2e.mjs', 'test\\coverage-e2e.mjs',
    'test/coverage-ui.mjs', 'test\\coverage-ui.mjs',
    'test/skill-test.mjs', 'test\\skill-test.mjs'
  ]);
  const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.bat', '.yml', '.yaml']);
  // 无扩展名但按名字就是密钥文件的，直接命中（community.key 曾因此"既不删也不扫"地进了分发包）
  const SECRET_FILE_NAMES = new Set(['community.key']);
  const PATTERNS = [
    { name: 'OpenAI Key', re: /sk-[A-Za-z0-9]{20,}/g },
    { name: 'Anthropic Key', re: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
    { name: 'DeepSeek Key', re: /\bsk-[0-9a-f]{32}\b/gi },
    { name: '通用 API Key 赋值', re: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{16,}['"]/gi },
    // 令牌/密钥类赋值：SnowLuma 的 accessToken、搜索服务的 key、自定义字段等
    { name: '令牌赋值', re: /(?:access[_-]?token|http[_-]?token|bearer|token|secret|password|passwd|private[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"]/gi },
    // Authorization: Bearer xxx（日志/调试残留）
    { name: 'Bearer 头', re: /bearer\s+[A-Za-z0-9\-._~+/]{16,}/gi }
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
      // 密钥文件名（无扩展名也命中）：读出来当文本扫。
      // corrupt 备份按前缀命中 —— 它是坏配置的完整原文（含真实密钥）。
      const isSecretName = SECRET_FILE_NAMES.has(e.name)
        || e.name.endsWith('.key')
        || /^config\.json\.corrupt-/.test(e.name);
      if (!isSecretName && !TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const relPath = path.relative(ROOT, full).replace(/\\/g, '/');
      if (SKIP_FILE.has(relPath)) continue;
      // 密钥类文件直接按"发现可疑"上报（无论内容格式）
      if (isSecretName) {
        found.push(`${relPath} → 密钥文件（${e.name.endsWith('.key') ? '*.key' : e.name}）`);
        continue;
      }
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
  // ⚠️ 根目录的社区管理密钥：发布包绝不能带（拿着它就能覆盖云端共享屏蔽名单）。
  //    它无扩展名，历史上既不进 rmrf 清单、也不被扩展名扫描覆盖 —— 三重遗漏。
  rmrfRootKey();
  // ⚠️ 坏配置备份（config.json.corrupt-<ts>，config.js 的 loadConfig 产物）：
  //    内含用户**真实的 apiKey/令牌/白名单**（备份的是损坏前的完整旧配置）。
  //    扩展名是 .corrupt-xxx，曾既不进清理清单也不被扫描 —— 与 community.key
  //    同样的"三重穿透"。按前缀 glob 全部删除。
  for (const f of fs.readdirSync(DATA_DIR).filter((n) => /^config\.json\.corrupt-/.test(n))) {
    rmrf(f, '坏配置备份（含真实密钥）');
  }
  rmrf('messages', '聊天存档');
  rmrf('sessions', '会话留档');
  rmrf('memory', '记忆');
  // ── 2026-09-19 H1 修复：插件生态新增的 data 子目录曾全部绕过本清单 ──
  // conversation-memory 插件：分层记忆（小时块含聊天原文摘要与片段、语义卡、
  // 跨轮状态含机器人草稿与已发内容）。清单滞后即整包泄漏，故一并纳入。
  rmrf('memory-v2', '分层会话记忆（含聊天摘要与片段）');
  rmrf('semantic-cards', '语义卡记忆');
  rmrf('cross-turn', '跨轮状态（含机器人草稿）');
  rmrf('cross-chat', '跨群感知状态');
  // 市场账号凭据：长期 token（拿到即可冒充该账号发布）。
  // 注意它与 config 的脱敏链路完全独立 —— market.js 刻意不把凭据放 config，
  // 于是 config 的清洗管不到它，必须在这里删。
  rmrf('account.json', '市场账号凭据');
  // conversation-memory 的成本护栏与用量快照：含 chatKey（群号）与调用计数
  rmrf('cost-guard.json', '记忆成本护栏状态');
  rmrf('usage-daily.json', '按日用量快照（含 chatKey）');
  rmrf('session-index-cache.json', '会话索引缓存（含触发消息摘要）');
  // media-download 插件的下载缓存（B站/抖音视频文件本体）
  rmrf('media-cache', '媒体下载缓存');
  // video-reader 的转码缓存（群友发过的视频转 480p mp4 的副本）
  rmrf('video-cache', '视频转码缓存');
  // 遥测：匿名但属于使用痕迹（installId 关联本机）
  rmrf('telemetry.json', '遥测安装标识');
  rmrf('telemetry-totals.json', '遥测累计用量');
  rmrf('stickers.json', '表情库');
  // 收藏表情转存的图片本体（群聊里收集的表情/图片，使用痕迹）
  rmrf('sticker-images', '表情图片');
  // 云端共享屏蔽名单缓存：含被拉黑者的 QQ 号（第三方隐私）
  rmrf('cloud-global-blocklist.json', '云端屏蔽名单缓存');
  rmrf('usage-today.json', '今日用量');
  rmrf('feedbacks.json', '反馈记录');
  rmrf('price-feed-cache.json', '远程价格表缓存');
  // 应用日志：含聊天摘要与报错响应体（可能带上游回显的请求头），
  // 而且历史上它被 SKIP_DIR 跳过 → 既不删也不扫，是最容易漏掉的泄露面。
  rmrf('logs', '应用日志');
  // 提醒：含用户预定的提醒正文与群号
  rmrf('reminders.json', '定时提醒');

  // 中转目录在系统临时文件夹里（不在项目内），尽力清一次即可
  const trashRoot = path.join(os.tmpdir(), 'qq-agent-sanitize');
  if (!DRY && fs.existsSync(trashRoot)) {
    try { fs.rmSync(trashRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // SnowLuma 登录态 / 日志
  const slDir = path.join(ROOT, 'snowluma');
  // ⚠️ 真正带令牌的是 per-uin 的 onebot_<QQ号>.json：SnowLuma 给每个登录过的账号
  //    生成一份且**永久保留**。原实现只清模板 onebot_0.json，等于把带 token 的
  //    文件原样分发出去（拿到的人可以直接收发消息、读群）。
  let slConfigFiles = [];
  try {
    slConfigFiles = fs.readdirSync(path.join(slDir, 'config'))
      .filter((f) => /^onebot_\d+\.json$/.test(f))
      .map((f) => `config/${f}`);
  } catch { /* snowluma 目录不存在 */ }
  for (const rel of [...slConfigFiles, 'config/onebot_0.json', 'config/consent.json', 'config/notifications.json']) {
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

// ── data/ 清单外文件告警闸（2026-09-19 H1 根治）──────────────────────────
// 教训：conversation-memory 插件新增 memory-v2/、cross-turn/、account.json 等
// 六七个数据落点，全部绕过了上面的 rmrf 清单 —— 清单是"手工枚举"，任何插件
// 新增 data 子目录都不会自动进表。这道闸把"清单滞后"从静默泄漏变成显式告警：
// data/ 下凡是清单（清理 + 保留）没覆盖到的文件/目录，逐个列出来要求人工归类。
// 保留清单只放"确认不含使用痕迹"的文件；宁可多报不可漏报。
const DATA_KEEP = new Set([
  'config.json',            // resetConfig 已清洗（密钥/白名单/人设全部回出厂）
  'price-feed-cache.json',  // 公开价格表缓存，无个人数据
  'qq-agent.lock',          // 进程锁（PID 文本）
  '.trash'                  // rmrf 的中转目录（结尾有硬阻断检查）
]);
function listUncoveredDataEntries() {
  let entries;
  try { entries = fs.readdirSync(DATA_DIR, { withFileTypes: true }); } catch { return []; }
  const covered = new Set(DATA_KEEP);
  // rmrf 的目标名（actions 里记的都是相对 data/ 的名字；再扫一遍函数调用更稳——
  // 直接从源码取不可行，这里以"本次已注册的动作"为准）
  for (const a of actions) {
    const m = /移除 (\S+)（/.exec(a);
    if (m) covered.add(m[1]);
  }
  // 坏配置备份按前缀处理
  for (const e of entries) {
    if (/^config\.json\.corrupt-/.test(e.name)) covered.add(e.name);
  }
  const uncovered = [];
  for (const e of entries) {
    if (covered.has(e.name)) continue;
    const isDir = e.isDirectory();
    // 目录只看一层（子内容同属一个数据落点，整目录处理）
    uncovered.push(`${e.name}${isDir ? '/' : ''}`);
  }
  return uncovered;
}
if (!SCAN_ONLY) {
  const uncovered = listUncoveredDataEntries();
  if (uncovered.length) {
    log('⚠ data/ 下存在清单未覆盖的文件/目录（可能是新插件的数据落点）：');
    for (const u of uncovered) log('    -', u);
    log('');
    log('  这些不会被本脚本清理，压缩分享前请人工确认是否包含聊天内容/凭据/使用痕迹，');
    log('  需要清理的加进脚本顶部的 rmrf 清单，确认无害的加进 DATA_KEEP。');
    log('  （--scan 模式不执行本检查）');
    log('');
  } else {
    log('  ✓ data/ 清单覆盖检查通过（无未知数据文件）');
    log('');
  }
}

// ── 发布阻断检查：.trash 残留或 community.key 删除失败都不能发布 ──
// .trash 里是被改名但没删掉的聊天记录/记忆（杀软占用等场景）。
// 压缩项目目录时它仍在包里 —— 这里必须硬阻断，而不是提示"可以压缩分享了"。
if (!SCAN_ONLY && !DRY) {
  const trashDir = path.join(DATA_DIR, '.trash');
  let trashLeft = 0;
  try { trashLeft = fs.readdirSync(trashDir).length; } catch { /* 目录不存在 = 干净 */ }
  if (trashFailed || trashLeft > 0) {
    log(`⛔ 发布中止：${trashLeft > 0 ? `data/.trash 仍有 ${trashLeft} 项未删净` : '部分文件删除失败'}。`);
    log('   这些是聊天记录/记忆等敏感数据的残留，压缩项目目录时会一起带出去。');
    log('   请手动删除 data/.trash 后重新执行本脚本。');
    process.exit(1);
  }
}
log(DRY ? '演练结束。确认无误后去掉 --dry-run 再执行一次。' : '完成。现在可以压缩分享了（建议保留 node_modules，接收方无需 npm install）。');
