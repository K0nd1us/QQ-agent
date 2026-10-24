// 新账号的"设置模板"：复制 1 号账号的行为设置，但绝不复制凭据与聊天数据。
//
// 用户选择的口径：
//   · 旧 data/ 原样作为 1 号账号；
//   · 新账号复制设置模板（人设、聊天策略、工具、技能开关、界面偏好…），
//   · 但清空模型 Key、协议端令牌、白名单、屏蔽名单、记忆/存档/用量（后三者本来
//     就在各自 data 目录里，新目录天然为空）。
//
// 安全兜底：即使某个插件把 Key 写进了自己的 config.skills 命名空间，这里也会按
// 字段名统一擦除（apiKey / accessToken / cookie / secret / password / token …）。
import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY_RE = /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key|^token$)/i;

function scrubSecrets(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, key));
  if (!value || typeof value !== 'object') return value;

  // 模型目录的 Key 单独存放：整体清空，连"哪个供应商有 Key"都不继承。
  if (key === 'dshProviderKeys') return {};

  const out = {};
  for (const [childKey, child] of Object.entries(value)) {
    // 凭据字段统一置空串（不删除键）：各模块读到的形状不变，也不会因 undefined 走错分支。
    if (SECRET_KEY_RE.test(childKey) && (typeof child === 'string' || typeof child === 'number')) {
      out[childKey] = '';
      continue;
    }
    out[childKey] = scrubSecrets(child, childKey);
  }

  // providers[] 里不允许残留明文 Key / 派生的 hasKey 标记。
  if (key === 'providers' && Array.isArray(out)) {
    return out.map((provider) => {
      if (!provider || typeof provider !== 'object') return provider;
      const copy = { ...provider };
      delete copy.apiKey;
      delete copy.hasKey;
      return copy;
    });
  }
  return out;
}

function emptyConnection() {
  return {
    wsUrl: '',
    httpUrl: '',
    accessToken: '',
    httpAccessToken: ''
  };
}

/**
 * 从 1 号账号的 config 生成新账号 config。
 * @param {object} template 1 号账号的原始 config.json（可为空对象）
 * @param {{port:number}} options
 */
export function buildAccountConfig(template, { port }) {
  const source = template && typeof template === 'object' && !Array.isArray(template) ? template : {};
  const cfg = scrubSecrets(JSON.parse(JSON.stringify(source)));

  cfg.api = { ...(cfg.api && typeof cfg.api === 'object' ? cfg.api : {}) };
  cfg.api.apiKey = '';
  delete cfg.api.hasApiKey;
  delete cfg.api.hasKey;

  cfg.providers = Array.isArray(cfg.providers)
    ? cfg.providers.map((provider) => {
      if (!provider || typeof provider !== 'object') return provider;
      const copy = { ...provider };
      delete copy.apiKey;
      delete copy.hasKey;
      return copy;
    })
    : [];
  cfg.dshProviderKeys = {};
  cfg.providersSourceYaml = '';

  // 协议端必须逐号独立：地址和令牌都从空开始，避免新号误连 1 号。
  // 0.4 仓库版用 onebot.*；安装版还多一份 snowluma.*，两套都清。
  cfg.onebot = { ...(cfg.onebot && typeof cfg.onebot === 'object' ? cfg.onebot : {}), ...emptyConnection() };
  cfg.snowluma = {
    ...(cfg.snowluma && typeof cfg.snowluma === 'object' ? cfg.snowluma : {}),
    dir: '',
    autoLaunch: false,
    ...emptyConnection()
  };

  // 白名单 / 屏蔽名单 / 分群人设：都属于"这个号的聊天关系"，不能继承。
  cfg.allow = { groups: [], private: [] };
  cfg.deny = { groups: [], private: [] };
  cfg.allowAllWhenEmpty = false;
  cfg.blocklist = {};
  cfg.globalBlocklist = [];
  cfg.communityExemptions = [];
  cfg.personaByChat = {};

  // 指令禁言是临时状态，不继承。
  cfg.commandMute = { ...(cfg.commandMute && typeof cfg.commandMute === 'object' ? cfg.commandMute : {}) };
  cfg.commandMute.active = {};

  // 控制台：独立端口；管理令牌留空（只监听 127.0.0.1）；只有 1 号能开机自启。
  cfg.server = {
    ...(cfg.server && typeof cfg.server === 'object' ? cfg.server : {}),
    port: Number(port) || 3212,
    token: '',
    autoStart: false
  };

  return cfg;
}

/** 读 1 号账号的 config.json 作为模板；不存在就用空对象（由程序自己补默认值）。 */
export function readTemplateConfig(baseDataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDataDir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 新账号目录里除了 config.json，还放一张只读说明卡，方便用户/排障时认目录。 */
export function writeAccountReadme(dir, { id, name, port }) {
  const text = [
    `# QQ Agent 账号数据目录`,
    ``,
    `- 账号 ID：${id}`,
    `- 显示名：${name}`,
    `- 控制台端口：${port}`,
    ``,
    `这个目录由「账号中心」创建，属于**单个 QQ 号**。`,
    `记忆、存档、会话、用量、模型 Key、白名单、技能/插件开关都在这里，`,
    `与其它账号互不读写。需要备份时整个目录复制走即可。`,
    ``
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'ACCOUNT.md'), text, 'utf8');
}
