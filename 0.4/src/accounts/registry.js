// 账号注册表：多账号的唯一目录清单。
//
// 设计原则（与 0.4 原有"一个进程一个 data 目录"兼容）：
//   · 1 号账号（primary）继续使用原来的 data/ —— 零迁移、旧配置/记忆/存档原样保留；
//   · 新账号使用 data/accounts/<id>/ —— 与主账号完全平级、互不读写；
//   · 注册表只存"账号是谁、数据在哪、控制台端口是多少"，不存任何 Key/令牌；
//     真实配置仍留在各账号自己的 config.json 里（沿用原程序的全部读写路径）。
//
// 文件位置：<baseDataDir>/accounts.json。baseDataDir 就是安装目录下的 data/
// （QQ_AGENT_PROFILE=2 时是 data-2/），与旧版 PROFILE 多实例约定一致。
import fs from 'node:fs';
import path from 'node:path';

export const REGISTRY_VERSION = 1;
export const ACCOUNT_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
export const PRIMARY_ID = 'main';

/** 允许的账号目录：相对 base 的 posix 路径，只接受 accounts/<id> 这一种形态。 */
function normalizeRelativeDir(value, id) {
  const raw = String(value ?? '').replace(/\\/g, '/').trim();
  if (!raw || raw === '.' || raw === './') return '.';
  if (raw.startsWith('/') || raw.includes(':') || raw.split('/').some((p) => p === '..' || p === '')) {
    throw new Error(`账号 ${id} 的数据目录非法：${raw}`);
  }
  if (!/^accounts\/[a-z0-9][a-z0-9_-]{1,31}$/.test(raw)) {
    throw new Error(`账号 ${id} 的数据目录必须位于 accounts/ 下：${raw}`);
  }
  return raw;
}

export function sanitizeAccountName(value, fallback = '') {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const clipped = text.slice(0, 24);
  return clipped || fallback;
}

export function normalizeBaseDataDir(dir) {
  const resolved = path.resolve(String(dir || ''));
  if (!resolved || resolved === path.parse(resolved).root) {
    throw new Error(`数据目录非法：${dir}`);
  }
  return resolved;
}

export function registryPath(baseDataDir) {
  return path.join(normalizeBaseDataDir(baseDataDir), 'accounts.json');
}

export function accountDataDir(baseDataDir, account) {
  const base = normalizeBaseDataDir(baseDataDir);
  const rel = normalizeRelativeDir(account?.dir, account?.id || '?');
  const resolved = path.resolve(base, rel);
  const check = path.relative(base, resolved);
  if (check.startsWith('..') || path.isAbsolute(check)) {
    throw new Error(`账号 ${account?.id || '?'} 的数据目录越界：${resolved}`);
  }
  return resolved;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再 rename，避免断电/杀进程留下半个 JSON。 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function defaultRegistry(baseDataDir, defaultPort) {
  return {
    version: REGISTRY_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accounts: [{
      id: PRIMARY_ID,
      name: '1 号账号',
      dir: '.',
      port: Number(defaultPort) || 3210,
      enabled: true,
      primary: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      uin: ''
    }]
  };
}

/**
 * 读注册表；不存在或字段缺失时补齐并落盘。
 * 返回 { registry, warnings, changed }。
 *
 * 注意：这里**不会**自动改端口。端口冲突由 supervisor 在启动时诊断，
 * 静默改端口会让用户配置的"控制台地址"莫名其妙地变掉。
 */
export function loadRegistry(baseDataDir, { defaultPort = 3210 } = {}) {
  const base = normalizeBaseDataDir(baseDataDir);
  const file = registryPath(base);
  const warnings = [];
  let changed = false;
  let raw = readJson(file);

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (fs.existsSync(file)) {
      // 损坏文件先留证据，再重建；不直接删除用户磁盘上的东西。
      const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { fs.copyFileSync(file, backup); } catch { /* 备份失败不阻塞 */ }
      warnings.push(`accounts.json 无法解析，已备份到 ${path.basename(backup)} 并重建`);
    }
    raw = defaultRegistry(base, defaultPort);
    changed = true;
  }

  if (raw.version !== REGISTRY_VERSION) {
    warnings.push(`accounts.json 版本为 ${raw.version ?? '未知'}，按 v${REGISTRY_VERSION} 重写`);
    changed = true;
  }

  const accounts = [];
  const seen = new Set();
  const list = Array.isArray(raw.accounts) ? raw.accounts : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '');
    if (!ACCOUNT_ID_RE.test(id)) {
      warnings.push(`忽略 id 非法的账号：${id || '(空)'}`);
      changed = true;
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`忽略重复账号：${id}`);
      changed = true;
      continue;
    }
    let dir;
    try {
      dir = id === PRIMARY_ID ? '.' : normalizeRelativeDir(item.dir, id);
    } catch (error) {
      warnings.push(error.message);
      changed = true;
      continue;
    }
    const port = Number(item.port);
    const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
    if (!safePort) {
      warnings.push(`账号 ${id} 的端口无效，启动时将回退到配置里的端口`);
      changed = true;
    }
    const account = {
      id,
      name: sanitizeAccountName(item.name, id === PRIMARY_ID ? '1 号账号' : `账号 ${id.slice(-4)}`),
      dir,
      port: safePort || (id === PRIMARY_ID ? Number(defaultPort) || 3210 : 0),
      enabled: item.enabled !== false,
      primary: id === PRIMARY_ID,
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Date.now(),
      uin: String(item.uin || '').replace(/[^0-9]/g, '').slice(0, 20),
      templateFrom: String(item.templateFrom || '')
    };
    // 归一化后与原始字段不同 → 需要落盘
    if (item.name !== account.name || item.dir !== account.dir || item.enabled !== account.enabled
      || Number(item.port) !== account.port || String(item.uin || '') !== account.uin) {
      changed = true;
    }
    seen.add(id);
    accounts.push(account);
  }

  // 1 号账号必须存在：老用户升级后第一次打开就是这条分支。
  if (!seen.has(PRIMARY_ID)) {
    accounts.unshift(defaultRegistry(base, defaultPort).accounts[0]);
    changed = true;
    warnings.push('注册表缺少 1 号账号，已按原 data/ 目录补回');
  }

  // 1 号必须排在最前，界面排序稳定。
  accounts.sort((a, b) => (a.primary === b.primary ? 0 : a.primary ? -1 : 1) || a.createdAt - b.createdAt);

  const registry = {
    version: REGISTRY_VERSION,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    accounts
  };

  if (changed) saveRegistry(base, registry);
  return { registry, warnings, changed };
}

export function saveRegistry(baseDataDir, registry) {
  const base = normalizeBaseDataDir(baseDataDir);
  const payload = {
    version: REGISTRY_VERSION,
    createdAt: Number(registry?.createdAt) || Date.now(),
    updatedAt: Date.now(),
    accounts: (registry?.accounts || []).map((a) => ({ ...a }))
  };
  writeJsonAtomic(registryPath(base), payload);
  registry.updatedAt = payload.updatedAt;
  return payload;
}

export function findAccount(registry, id) {
  return (registry?.accounts || []).find((a) => a.id === String(id)) || null;
}

/** 给新账号分配一个没人用的控制台端口（不占用、只做静态避让）。 */
export function nextAccountPort(registry, { hubPort = 0, start = 3212 } = {}) {
  const used = new Set((registry?.accounts || []).map((a) => Number(a.port)).filter(Boolean));
  if (hubPort) used.add(Number(hubPort));
  let port = Math.max(3212, Number(start) || 3212);
  while (used.has(port) || port === 3000 || port === 3001 || port === 5099) port += 1;
  return port;
}

/** 读某账号的 config.json（不存在返回 null，不创建）。 */
export function readAccountConfig(baseDataDir, account) {
  const dir = accountDataDir(baseDataDir, account);
  return readJson(path.join(dir, 'config.json'));
}

export function writeAccountConfig(baseDataDir, account, config) {
  const dir = accountDataDir(baseDataDir, account);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'config.json'), config);
}
