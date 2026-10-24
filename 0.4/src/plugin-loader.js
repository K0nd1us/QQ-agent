// Skill / 插件加载器：扫描 plugins/ 与 skills/ 两个目录。
//
// 两个目录的区别是**语义分类**，不是格式新旧（两种清单文件功能完全等价，
// 走同一条 normalizeManifest —— 只有"什么时候会被执行"这件事不同）：
//
//   plugins/   确定性型（kind = 'plugin'）
//              提供**能力**（providers）或**钩子**（hooks）。核心代码按能力名取用，
//              满足条件就一定被执行，不经过 LLM，模型想忽略也忽略不掉。
//              例：账号池、图片兼容、思考适配、禁言状态、抽帧、语音转文字、回复安全网。
//
//   skills/    LLM 型（kind = 'skill'）
//              注册**工具**（registerTool）+ 提示词片段。工具进模型的 function 列表，
//              用不用、什么时候用由模型自己判断。
//              例：计算器、文本工具、天气查询、随机图、表情标注。
//
//   ⚠️ 只有工具会进模型的 tools 列表。所以"想接入 LLM"只有一条路：registerTool。
//      只写 providers 的模块放进 skills/ 对模型是完全隐形的 —— 加载器会就这种情况
//      给出明确警告（见 lintKindPlacement），否则它会静默失效得毫无线索。
//
// 安全机制（沿用并加强）：
//   1. 权限声明：只有声明了 web_fetch 权限才拿得到 fetch
//   2. 错误隔离：单个 Skill 加载/注册失败只影响它自己
//   3. 资源回收：卸载/热重载时按 skillId 批量注销工具 + 清能力 + 调 dispose
//   4. 生命周期真实性：禁用一定调 deactivate，避免"开关关了但监听器还在"

import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerTool, unregisterTool, unregisterToolsBySkill, getTool, listTools } from './tool-registry.js';
import { skillManager } from './skills/manager.js';
import { normalizeManifest, isManifestUsable, SKILL_API_VERSION, kindOfDir } from './skills/manifest.js';
import { skillErrorText } from './skills/errors.js';
import { getConfig } from './config.js';

// ⚠️ 必须以**模块自身位置**为锚点，不能用 process.cwd()。
// 打包/安装版里 App 文件在 <install>/resources/app/，而快捷方式的"起始位置"
// 通常是 <install>/ —— 用 cwd 会解析到不存在的目录，导致 skills/ 与 plugins/
// **静默加载 0 个**（既不报错也不打日志，排查成本极高）。
// 项目内其它模块（app.js 的 UI_DIR、config.js 的 ROOT）都是同一约定。
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.resolve(APP_ROOT, 'skills');
const PLUGINS_DIR = path.resolve(APP_ROOT, 'plugins');

/**
 * 旧插件清单的 prompt 是 `{ when, examples[], instruction }` 形态，
 * 而新架构只认 `prompt.sections`。这里做一次适配 ——
 * 否则旧 `plugins/` 的提示词会**静默失效**（README 承诺"完全兼容"）。
 */
function adaptLegacyPrompt(raw, manifest) {
  if (manifest.prompt?.sections?.length) return manifest;
  const p = raw?.prompt;
  if (!p || typeof p !== 'object') return manifest;
  const lines = [];
  if (p.when) lines.push(`何时使用：${String(p.when).trim()}`);
  if (Array.isArray(p.examples) && p.examples.length) {
    const ex = p.examples.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (ex.length) lines.push(`示例：${ex.join(' / ')}`);
  }
  if (p.instruction) lines.push(String(p.instruction).trim());
  if (!lines.length) return manifest;
  manifest.prompt = {
    sections: [{ id: 'legacy', title: manifest.name || manifest.id, content: lines.join('\n'), priority: 50 }]
  };
  return manifest;
}

/**
 * 构造暴露给 Skill 的安全 API。
 * 与旧插件 API 的差别：多了 config / hook 注册 / 能力查询，但仍然只给白名单能力。
 */
/**
 * Skill 的持久化存储：data/<skillId>.json。
 *
 * 加这个是因为「插件的每日上限/去重记录」全靠 api.storage，而 createSkillApi
 * 里一度把它删掉了 —— 于是 bili-browse 的 shareLog/likeLog/commentLog/forwardLog
 * 全部退化成内存里的默认值，每次热重载归零，每日上限形同虚设。
 * 接口保持 get(key, def) / set(key, value) / remove(key)，别改成函数式。
 */
function makeSkillStorage(skillId) {
  const file = path.join(APP_ROOT, 'data', `${skillId}.json`);
  const readAll = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
  };
  const writeAll = (obj) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
      return true;
    } catch { return false; }
  };
  return {
    get: (key, def = null) => {
      const all = readAll();
      return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : def;
    },
    set: (key, value) => {
      const all = readAll();
      all[key] = value;
      return writeAll(all);
    },
    remove: (key) => {
      const all = readAll();
      delete all[key];
      return writeAll(all);
    },
    all: () => readAll(),
    file
  };
}

function createSkillApi(skillId, permissions = [], sink = null) {
  const has = (name) => permissions.includes(name);
  return {
    // 注册工具（自动加 skillId 前缀 + 绑定来源，便于开关联动与批量清理）
    registerTool: (def) => {
      if (!def?.id) throw new Error('工具必须提供 id');
      // ⚠️ 工具 id 会成为发给模型的 OpenAI function name，只允许 [a-zA-Z0-9_-]：
      // 用 ":" 或 "." 拼接会被严格端点（DeepSeek/OpenAI）以 400 invalid function name
      // 拒掉整个请求。这里统一 sanitize + 双下划线分隔。
      const sanitize = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
      // 总长不能超 64（OpenAI 上限）：skillId 截到 24、工具名截到 38，加 '__' 正好 64 以内
      const sid = sanitize(skillId).slice(0, 24);
      const tid = sanitize(def.id).slice(0, 38);
      const prefixedId = tid.startsWith(`${sid}__`) ? tid : `${sid}__${tid}`;
      // sanitize + 截断后撞名防护：同名工具若来自不同 Skill，后加载者会静默覆盖
      // 先加载者 —— 至少留个告警，别让"谁的工具生效"变成未解之谜
      const existing = getTool(prefixedId);
      if (existing && existing.skillId && existing.skillId !== skillId) {
        console.warn(`[skill] ⚠️ 工具 id 冲突：${prefixedId} 已由 ${existing.skillId} 注册，${skillId} 的同名工具会覆盖它`);
      }
      registerTool({ ...def, id: prefixedId, skillId, _plugin: skillId });
      return prefixedId;
    },
    // 读取本 Skill 的配置（默认值已由 manifest.settings 合并）
    config: () => skillManager.settingsOf(skillId),
    /**
     * 查询宿主自带的工具（例：meme-taste 想直接调核心的 collect_sticker 收藏表情）。
     *
     * 之前的 api 上只有 registerTool，没有"拿别人工具"的入口 —— 于是
     * meme-taste 只能靠 api.tools 快照，而那个字段根本不存在，表现为
     * "收藏表情永远报『核心的收藏表情没挂上』"。这里给一个**实时**查询口，
     * 不依赖加载顺序，也不会拿到过期快照。
     */
    getTool: (id) => {
      try { return getTool(String(id || '')) || null; } catch { return null; }
    },
    /** 全部已注册工具（含插件/skill 注册的），实时取，别在 setup 里缓存成快照用 */
    get tools() {
      try { return listTools(); } catch { return []; }
    },
    // 查询其它 Skill 是否生效（用于"我依赖的知识库没开就别硬跑"这类判断）
    isSkillActive: (id, ctx = {}) => skillManager.isActive(id, ctx).active,
    /**
     * 软依赖调用：问"谁提供这个能力"，有就调、没有就静默返回 undefined。
     *
     * 与 manifest.requires 的区别（这个区分很重要）：
     *   requires          **硬依赖** —— 缺了就把本 Skill 判定为不可用，UI 显示"依赖未就绪"
     *   api.capability()  **软依赖** —— 有能力就增强，没有就降级，本 Skill 照常工作
     * 例：发言标签想在有"主人识别"模块时自动加〔主人〕标记，
     *     但没装那个模块时绝不该因此变成不可用 —— 那就该用软依赖。
     *
     * 只取第一个生效的提供者（约定：同类能力只应有一个提供者）。
     */
    capability: (name, args = {}) => {
      for (const p of skillManager.getCapabilityProviders(name, {})) {
        try { return p.fn(args); } catch { return undefined; }
      }
      return undefined;
    },
    hasCapability: (name) => skillManager.hasCapability(name),
    // 日志。
    // ⚠️ 必须先 util.format(...args) 再加前缀：format 只把**第一个参数**当格式串，
    //    如果写成 console.log(前缀, ...args)，前缀占掉第一位，插件写的
    //    log('已加载（%s~%s）', a, b) 里的 %s 就永远不会被替换（打印字面 %s）。
    // ⚠️ sink 是宿主 logger：console 输出在 Electron 里进不了 data/logs/*.log，
    //    插件以前只能靠 console，于是"运行时到底跑没跑"完全查不到
    //    （bili-browse 两天零日志就是这么来的）。这里同时写宿主日志。
    log: (...args) => {
      const line = format(...args);
      console.log(`[skill:${skillId}]`, line);
      if (sink) { try { sink(`[${skillId}] ${line}`); } catch { /* 日志失败不影响主流程 */ } }
    },
    warn: (...args) => {
      const line = format(...args);
      console.warn(`[skill:${skillId}]`, line);
      if (sink) { try { sink(`[${skillId}] ⚠️ ${line}`); } catch { /* ignore */ } }
    },
    error: (...args) => {
      const line = format(...args);
      console.error(`[skill:${skillId}]`, line);
      if (sink) { try { sink(`[${skillId}] ❌ ${line}`); } catch { /* ignore */ } }
    },
    // 持久化存储（data/<skillId>.json）
    storage: makeSkillStorage(skillId),
    // 只有声明了 web_fetch 权限才拿得到 fetch
    fetch: has('web_fetch')
      ? globalThis.fetch
      : () => Promise.reject(new Error(`Skill ${skillId} 未声明 web_fetch 权限`)),
    // 整份运行时配置（只读用）：有的插件要按 QQ 号解析提供商端点（providers/dshProviderKeys），
    // 这属于全局配置而不是本插件切片，所以单独开一个只读入口。
    globalConfig: () => JSON.parse(JSON.stringify(getConfig())),
    utils: {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      safeJsonParse: (text, fallback = null) => {
        try { return JSON.parse(text); } catch { return fallback; }
      }
    }
  };
}

/** 读取目录里的清单：优先 skill.json，其次 plugin.json（兼容旧插件）。 */
function readManifest(dir) {
  const skillPath = path.join(dir, 'skill.json');
  const pluginPath = path.join(dir, 'plugin.json');
  let file = null;
  let source = 'skill';
  if (fs.existsSync(skillPath)) file = skillPath;
  else if (fs.existsSync(pluginPath)) { file = pluginPath; source = 'plugin'; }
  if (!file) return { error: '缺少 skill.json / plugin.json', source };
  try {
    let text = fs.readFileSync(file, 'utf8');
    // 去掉 UTF-8 BOM。Windows 上的编辑器（记事本、部分 VS Code 配置、
    // PowerShell 的 Out-File -Encoding utf8）默认会写 BOM，
    // 而 JSON.parse 遇到 \uFEFF 会直接抛 "Unexpected token" ——
    // 表现为"清单明明是对的却加载失败"，而且报错信息完全不提 BOM，极难排查。
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const raw = JSON.parse(text);
    return { raw, source, file };
  } catch (error) {
    return { error: `清单解析失败：${error.message}`, source };
  }
}

/**
 * 校验条目是否放在了语义正确的目录里。
 *
 * 只警告，不阻断加载 —— 放错目录不会报错也不会崩，但后果很隐蔽：
 *   · 只有 providers 的模块放进 skills/ → 模型根本看不到它，功能永远不被触发
 *   · 只有工具的模块放进 plugins/      → 能用，但语义混乱，统计与文档都对不上
 * 所以这里把"默默失效"变成"启动就看得见"。
 *
 * 目录语义定义见 skills/manifest.js 的 DIR_KIND。
 */
function lintKindPlacement(kind, { manifest, toolIds, providers, hooks, resolveRoute }, log) {
  if (!kind) return;
  const hasTools = (toolIds || []).length > 0;
  const provides = Object.keys(providers || {}).length > 0 || Object.keys(hooks || {}).length > 0
    || typeof resolveRoute === 'function';   // 按人切 API 这类扩展点也算"有人会调用"

  if (kind === 'skill' && !hasTools) {
    log(`[skill] ⚠️ ${manifest.id} 在 skills/（LLM 型）却没有注册任何工具：`
      + '模型看不到它，功能不会被触发。'
      + '要么 registerTool，要么把它移到 plugins/（确定性型）。');
  }
  if (kind === 'plugin' && !provides) {
    log(`[skill] ⚠️ ${manifest.id} 在 plugins/（确定性型）却没有提供能力或钩子：`
      + '没有任何代码会去调用它。'
      + '要么 export providers / hooks，要么把它移到 skills/（LLM 型，注册工具）。');
  }
}

/**
 * 加载单个 Skill 目录。
 *
 * 失败语义（两条都要成立，缺一不可）：
 *   ① 返回 loaded: false —— 会让 pruneMissing 把它当"存活"处理（不触发磁盘对齐卸载）；
 *   ② **带 loadError 注册进注册表** —— 让 UI/`/api/skills` 能看到"加载失败 + 原因"。
 * 此前失败条目直接 return 不注册，用户放一个写错的插件在界面上的表现是
 * "它不存在"，只有启动日志里有一行 ❌，非常难排查。
 *
 * 重载失败时的旧实例保留：如果旧版本已在运行，**先跑新 setup，成功才退役旧实例**。
 * 历史实现是"先卸旧再装新"，新 setup 一抛错旧实例也已经被放倒 —— 表现为
 * "改错一个字母，正在正常工作的插件直接消失，直到修好为止"。现在失败时
 * 旧实例原样继续跑（stale-but-working 优于 down），error 文案会写明"沿用旧版本"。
 *
 * @returns {Promise<{dir, loaded, id?, error?, skill?}>}
 */
async function loadSkillDir(dir, { log = console.log, kind = null } = {}) {
  const dirName = path.basename(dir);
  const found = readManifest(dir);
  const hadPrevious = found.error ? null : skillManager.isLoaded(
    // manifest 还没解析出来时用目录名当 id 兜底（normalizeManifest 的 fallbackId 同源）
    (found.raw?.id ? String(found.raw.id) : dirName)
  );

  // ── 失败也要注册（带 loadError）────────────────────────────────────────
  // 注册后 /api/skills 与技能页就能显示"加载失败 + 原因"，而不是条目凭空消失。
  // 注册的 manifest 用最小骨架（只有 id/dir），能力/工具/钩子一概没有 —— 失败的
  // Skill 不该有任何副作用，只是"可见"。
  const failRegister = (id, error) => {
    const existing = skillManager.registry.get(id);
    // 旧实例还活着且这次只是新版本坏了：保留旧实例（stale-but-working），
    // 只把失败文案挂到旧实例上，UI 显示"上次重载失败，正在沿用旧版本"。
    if (existing && !existing.loadError) {
      skillManager.errors.set(id, `${error}（已沿用旧版本继续运行）`);
      return { dir, loaded: false, id, error: `${error}（保留旧版本）` };
    }
    skillManager.register({
      manifest: { id, name: id, version: '0.0.0', apiVersion: SKILL_API_VERSION, requires: [], capabilities: [], settings: {}, configSchema: {}, prompt: null },
      source: found.source, dir,
      relDir: path.relative(APP_ROOT, dir).replace(/\\/g, '/'),
      kind,
      api: null, toolIds: [],
      available: null, availableReason: '', activate: null, deactivate: null,
      dispose: () => { unregisterToolsBySkill(id); },
      hooks: {}, providers: {}, promptSections: null,
      loadError: error
    });
    skillManager.errors.set(id, error);
    return { dir, loaded: false, id, error };
  };

  if (found.error) {
    const id = dirName;
    // 旧实例在跑（清单这次坏了但上次加载成功）：沿用旧实例，别把它放倒
    if (hadPrevious) {
      skillManager.errors.set(id, `${found.error}（已沿用旧版本继续运行）`);
      return { dir, loaded: false, id, error: `${found.error}（保留旧版本）` };
    }
    const r = failRegister(id, found.error);
    log(`[skill] ❌ ${id}：${found.error}`);
    return r;
  }

  const { manifest, problems } = normalizeManifest(found.raw, { fallbackId: dirName });
  for (const p of problems) log(`[skill] ⚠️ ${dirName}：${p}`);
  if (!isManifestUsable(manifest, problems)) {
    const error = `清单不可用：${problems.join('；')}`;
    if (hadPrevious) {
      skillManager.errors.set(manifest.id, `${error}（已沿用旧版本继续运行）`);
      return { dir, loaded: false, id: manifest.id, error: `${error}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, error);
    log(`[skill] ❌ ${manifest.id}：${error}`);
    return r;
  }
  // 旧 plugin.json 的 prompt 形态 → 新 prompt.sections，避免旧插件提示词静默失效
  adaptLegacyPrompt(found.raw, manifest);

  // 入口：skill.json 用 entry，旧 plugin.json 也是 entry；默认 index.js
  const entryRel = String(found.raw.entry || 'index.js');
  // ⚠️ entry 必须锁死在 Skill 自己的目录内。
  // id 已经在 manifest 里有正则校验，但 entry 才是权限更大的那个（它被直接 import 执行）。
  // 不校验的话 `"entry": "../../outside.js"` 可以执行 Skill 目录外的任意脚本，
  // 逃出"每个 Skill 自包含"的模型，也让 permissions 白名单形同虚设。
  const entryPath = path.resolve(dir, entryRel);
  const relToDir = path.relative(dir, entryPath);
  if (!relToDir || relToDir.startsWith('..') || path.isAbsolute(relToDir)) {
    // 路径穿越属于**安全拒绝**，不是普通失败：即使旧实例在跑也不沿用（entry
    // 已经越界，"旧版本"和这次磁盘上的东西未必是一回事），直接登记失败条目。
    const r = failRegister(manifest.id, `entry 必须是 Skill 目录内的相对路径：${entryRel}`);
    log(`[skill] ❌ ${manifest.id}：entry 越界已被拒绝`);
    return r;
  }
  // 符号链接也要挡住（realpath 之后重新判断是否仍在目录内）
  try {
    const realDir = fs.realpathSync(dir);
    const realEntry = fs.realpathSync(entryPath);
    const relReal = path.relative(realDir, realEntry);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      const r = failRegister(manifest.id, `entry 指向了 Skill 目录外（符号链接）：${entryRel}`);
      log(`[skill] ❌ ${manifest.id}：entry 经符号链接越界已被拒绝`);
      return r;
    }
  } catch { /* 文件不存在等情况交给下面统一报错 */ }
  if (!fs.existsSync(entryPath)) {
    const error = `入口文件不存在：${entryRel}`;
    if (hadPrevious) {
      skillManager.errors.set(manifest.id, `${error}（已沿用旧版本继续运行）`);
      return { dir, loaded: false, id: manifest.id, error: `${error}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, error);
    log(`[skill] ❌ ${manifest.id}：${error}`);
    return r;
  }

  let mod;
  try {
    const entryUrl = pathToFileURL(entryPath).href;
    // 加时间戳强制重新加载（热重载用）
    mod = await import(`${entryUrl}?t=${Date.now()}`);
  } catch (error) {
    const msg = `加载失败：${error.message}`;
    if (hadPrevious) {
      skillManager.errors.set(manifest.id, `${msg}（已沿用旧版本继续运行）`);
      return { dir, loaded: false, id: manifest.id, error: `${msg}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, msg);
    log(`[skill] ❌ ${manifest.id}：${msg}`);
    return r;
  }

  // register(api) 是旧插件入口；setup(api) 是新入口。两者都支持。
  const setupFn = typeof mod.setup === 'function' ? mod.setup
    : (typeof mod.register === 'function' ? mod.register : null);
  if (!setupFn && !mod.hooks && !mod.providers && !mod.activate) {
    const error = '入口需导出 setup(api)/register(api) 或 hooks/providers';
    if (hadPrevious) {
      skillManager.errors.set(manifest.id, `${error}（已沿用旧版本继续运行）`);
      return { dir, loaded: false, id: manifest.id, error: `${error}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, error);
    log(`[skill] ❌ ${manifest.id}：${error}`);
    return r;
  }

  const permissions = Array.isArray(found.raw.permissions) ? found.raw.permissions : [];
  const api = createSkillApi(manifest.id, permissions, log);

  // ── 新旧交替的顺序闸（2026-09 修订版）────────────────────────────────────
  // 目标有两个，且互相牵制：
  //   A. 新 setup 抛错 → 旧实例必须完好保留（stale-but-working 优于 down）；
  //   B. 新 setup 成功 → 新工具不能被旧实例的清理误删。
  //
  // 解法：把旧实例的退役拆成两段，夹住新 setup：
  //   第一段（setup 前）：只做"停副作用"——deactivate（停定时器/监听）。
  //     工具和能力**先不清**：万一 setup 抛错要走"保留旧实例"分支，清了就没了。
  //   第二段（setup 成功后）：清旧能力、从 registry 摘掉旧实例（不走
  //     unregister——它会 dispose + unregisterToolsBySkill(同 id)，把新工具
  //     一起删掉），最后 register 新实例。旧工具里"新版本没再注册"的孤儿 id
  //     由 loadPlugins 末尾的孤儿清扫兜底。
  //   · setup 抛错：deactivate 过了要补一个 activate 把旧实例救活，
  //     工具/能力/注册表全程未动，旧实例恢复原状继续跑。
  //   · setup 成功：新实例接管，无幽灵。
  const prevSkill = skillManager.registry.get(manifest.id);
  const prevWasLive = prevSkill && !prevSkill.loadError;
  if (prevWasLive) {
    try {
      if (typeof prevSkill.deactivate === 'function') prevSkill.deactivate({ reason: 'reload' });
    } catch (error) { log(`[skill] ⚠️ ${manifest.id} 旧实例 deactivate 失败：${error?.message ?? error}`); }
  }

  const toolIds = [];
  const collectingRegister = (def) => {
    const id = api.registerTool(def);
    toolIds.push(id);
    return id;
  };
  const apiWithCollect = { ...api, registerTool: collectingRegister };

  // 跑新 setup。此时旧实例只停了副作用（deactivate），工具/能力/注册表未动 ——
  // 抛错就走下面的"救活旧实例"分支。
  try {
    if (setupFn) await setupFn(apiWithCollect);
  } catch (error) {
    // 注册失败：把已注册的工具回滚，避免"半个 Skill"残留在工具列表里
    if (toolIds.length) unregisterToolsBySkill(manifest.id);
    const msg = `注册失败：${error.message}`;
    if (hadPrevious) {
      // 救活旧实例：deactivate 过了要补 activate（对话记忆这类 Skill 的
      // 后台定时器就靠它恢复）。工具/能力/注册表全程未动，恢复原状。
      try { if (typeof prevSkill.activate === 'function') prevSkill.activate({ reason: 'reload-failed' }); }
      catch (e2) { log(`[skill] ⚠️ ${manifest.id} 旧实例激活失败：${e2?.message ?? e2}`); }
      skillManager.errors.set(manifest.id, `${msg}（已沿用旧版本继续运行）`);
      log(`[skill] ❌ ${manifest.id}：${msg} —— 已保留旧版本继续运行`);
      return { dir, loaded: false, id: manifest.id, error: `${msg}（保留旧版本）` };
    }
    const r = failRegister(manifest.id, msg);
    log(`[skill] ❌ ${manifest.id}：${msg}`);
    return r;
  }

  // setup 成功：完成旧实例退役的第二段。
  // ⚠️ 不能走 skillManager.unregister —— 它会 dispose（内部 unregisterToolsBySkill
  // 同 id）把**新注册的工具**一起删掉。这里手动收尾：
  //   · 清旧能力（新 setup 注册的能力马上会在 register() 里重新登记）
  //   · 从 registry 摘掉旧实例，让下面 register() 看不到 prev、不会触发其内置
  //     的 dispose 路径。
  // 旧工具不在这里清：新 setup 用 registerTool 覆盖了同 id 定义，旧版本独有
  // （新版本没注册）的旧 id 由"loader 级孤儿清扫"兜底（见 loadPlugins 末尾）。
  if (prevSkill) {
    skillManager.capabilities.removeOwner(manifest.id);
    skillManager.registry.unregister(manifest.id);
    skillManager.errors.delete(manifest.id);
  }

  // 旧 plugin.json 的 tools[] 是**说明性元数据**（加载器不消费，工具靠入口 registerTool 注册）。
  // 声明了却没注册说明作者写漏了 —— 明确告警，别让它静默变成一个不存在的工具。
  const declaredTools = Array.isArray(found.raw.tools)
    ? found.raw.tools.map((t) => String(t?.id || t?.name || '')).filter(Boolean)
    : [];
  if (declaredTools.length) {
    const registeredShort = new Set(toolIds.map((id) => {
      const idx = id.indexOf('__');           // 新前缀是 skillId__toolId
      return idx >= 0 ? id.slice(idx + 2) : (id.includes(':') ? id.split(':').pop() : id);
    }));
    const missingTools = declaredTools.filter((d) => !registeredShort.has(d));
    if (missingTools.length) {
      log(`[skill] ⚠️ ${manifest.id}：清单 tools[] 声明了 ${missingTools.join(', ')}，`
        + '但入口没有 registerTool —— 清单里的 tools 只是元数据，不会被自动注册');
    }
  }

  const skill = {
    manifest,
    source: found.source,
    dir,
    // 仓库相对目录 + 目录语义类型，供状态视图/UI/审计使用
    relDir: path.relative(APP_ROOT, dir).replace(/\\/g, '/'),
    // 目录语义类型：'plugin'（确定性型）/ 'skill'（LLM 型）/ null（自定义根，不判定）
    kind,
    api: apiWithCollect,
    toolIds,
    // 生命周期与扩展点（可选）
    available: typeof mod.available === 'function' ? mod.available : null,
    availableReason: '',
    activate: typeof mod.activate === 'function' ? mod.activate : null,
    deactivate: typeof mod.deactivate === 'function' ? mod.deactivate : null,
    dispose: typeof mod.dispose === 'function' ? () => {
      try { mod.dispose(); } finally { unregisterToolsBySkill(manifest.id); }
    } : () => { unregisterToolsBySkill(manifest.id); },
    hooks: (mod.hooks && typeof mod.hooks === 'object') ? mod.hooks : {},
    providers: (mod.providers && typeof mod.providers === 'object') ? mod.providers : {},
    promptSections: typeof mod.promptSections === 'function' ? mod.promptSections : null,
    // 可选：按发送者决定这一轮用哪个 API（返回 { baseUrl, apiKey, model, provider } 或 null）
    resolveRoute: typeof mod.resolveRoute === 'function' ? mod.resolveRoute : null
  };
  skill.loadError = null;

  const r = skillManager.register(skill);
  if (!r.ok) {
    // 管理器拒绝（如 id 冲突校验失败）：已注册的工具必须回滚，否则留下无 Skill 的孤儿工具
    if (toolIds.length) unregisterToolsBySkill(manifest.id);
    const r2 = failRegister(manifest.id, r.error);
    return r2;
  }

  // 两型语义校验：把"放错目录导致功能静默失效"变成启动时的明确警告
  lintKindPlacement(kind, skill, log);

  log(`[skill] ✅ 加载成功：${manifest.name}（${manifest.id} v${manifest.version}，api v${manifest.apiVersion || SKILL_API_VERSION}）`);
  return { dir, loaded: true, id: manifest.id, skill };
}

/** 扫描一个目录下的所有 Skill。 */
async function loadSkillRoot(rootDir, { log = console.log, label = 'skill' } = {}) {
  if (!fs.existsSync(rootDir)) {
    // 不再静默：目录找不到必须打日志（历史上这里返回 missing 后被丢弃，
    // 表现为"安装版一个 Skill 都没有，且日志里毫无线索"）。
    log(`[${label}] ⚠️ 目录不存在，已跳过：${rootDir}`);
    return { loaded: [], failed: [], missing: true, rootDir };
  }
  const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(rootDir, e.name));
  if (!dirs.length) {
    log(`[${label}] ${path.basename(rootDir)}/ 为空：${rootDir}`);
    return { loaded: [], failed: [], empty: true, rootDir };
  }

  const results = [];
  const kind = kindOfDir(rootDir);
  for (const dir of dirs) {
    // 逐个串行加载：并行 import 时若两个 Skill 抢同一 id，顺序不确定
    results.push(await loadSkillDir(dir, { log, kind }));
  }
  const loaded = results.filter((r) => r.loaded);
  const failed = results.filter((r) => !r.loaded);
  log(`[${label}] ${path.basename(rootDir)}/（${rootDir}）：${loaded.length} 成功，${failed.length} 失败`);
  return { loaded, failed, rootDir };
}

/**
 * 加载全部 Skill（skills/ + plugins/）。
 * 幂等：重复调用会重新加载并覆盖同 id 的 Skill（热重载依赖这个语义）。
 */
export async function loadPlugins({ log = console.log, roots = null } = {}) {
  const skillsRoot = roots?.skills ? path.resolve(roots.skills) : SKILLS_DIR;
  const pluginsRoot = roots?.plugins ? path.resolve(roots.plugins) : PLUGINS_DIR;
  skillManager.setLog(log);
  const skillRes = await loadSkillRoot(skillsRoot, { log, label: 'skill' });
  const pluginRes = await loadSkillRoot(pluginsRoot, { log, label: 'plugin' });
  // 与磁盘对齐：把已经不存在于任何目录里的 Skill 卸掉（开发期删目录/改名的幽灵残留）。
  // 注意"存活集合"包含加载失败的 id —— 文件还在只是这次没加载成功，不触发卸载。
  // 加载失败的 Skill 现在分两种：
  //   · 有旧实例在跑 → 旧实例保留继续工作（loadSkillDir 的 stale-but-working 分支）；
  //   · 首次就失败   → 带 loadError 注册进表（UI 可见），不产生任何副作用。
  const aliveIds = [
    ...skillRes.loaded.map((r) => r.id), ...skillRes.failed.map((r) => r.id),
    ...pluginRes.loaded.map((r) => r.id), ...pluginRes.failed.map((r) => r.id)
  ].filter(Boolean);
  const pruned = skillManager.pruneMissing(aliveIds, {});
  if (pruned.length) log(`[skill] 已卸载磁盘上不存在的 Skill：${pruned.join(', ')}`);

  // 孤儿工具清扫：热重载覆盖注册后，旧版本独有（新版本没再注册）的工具
  // 不会有人清 —— unregisterToolsBySkill 会连新工具一起删（同 skillId 分不清
  // 彼此），所以只能在全部条目加载完之后，按"每个 Skill 声明的 toolIds"
  // 对账一遍。孤儿 = 注册表里有 skillId、但该 Skill 本轮没注册这个 id。
  const declaredToolIds = new Set();
  for (const s of skillManager.registry.list()) {
    for (const tid of s.toolIds || []) declaredToolIds.add(tid);
  }
  const orphanTools = listTools().filter((t) => t.skillId && !declaredToolIds.has(t.id));
  for (const t of orphanTools) unregisterTool(t.id);
  if (orphanTools.length) {
    log(`[skill] 已清理旧版本遗留的工具：${orphanTools.map((t) => t.id).join(', ')}`);
  }
  return {
    loaded: [...skillRes.loaded, ...pluginRes.loaded],
    failed: [...skillRes.failed, ...pluginRes.failed],
    pruned,
    dirs: { skills: skillsRoot, plugins: pluginsRoot }
  };
}

/**
 * 监听目录变化（热重载）。
 * 重载策略：只重载"变化的那个 Skill"不可靠（Node 的 fs.watch 只给文件名、不给语义），
 * 因此整体重新扫描；但**不会**清空工具注册表 —— 逐个 Skill 注册时会覆盖同 id，
 * 旧 Skill 若已删除则需要显式清理，所以先按现存目录对比出被删除的 id。
 */
export function watchPlugins({ log = console.log, onReload, roots: rootsOpt = null } = {}) {
  const skillsRoot = rootsOpt?.skills ? path.resolve(rootsOpt.skills) : SKILLS_DIR;
  const pluginsRoot = rootsOpt?.plugins ? path.resolve(rootsOpt.plugins) : PLUGINS_DIR;
  const roots = [skillsRoot, pluginsRoot].filter((d) => fs.existsSync(d));
  if (!roots.length) return null;

  let reloadTimer = null;
  let reloading = false;      // 重入保护：一次 reload 超 500ms 时，防抖计时器可能再触发第二次
  let pendingAgain = false;   // reload 期间又来了变化 → 结束后再补一轮
  const watchers = [];
  const runReload = async (filename) => {
    if (reloading) { pendingAgain = true; return; }
    reloading = true;
    try {
      log(`[skill] 检测到变化：${filename || ''}，重新扫描…`);
      const result = await loadPlugins({ log, roots: { skills: skillsRoot, plugins: pluginsRoot } });
      if (typeof onReload === 'function') onReload(result);
    } catch (error) {
      log(`[skill] 热重载失败：${error?.message ?? error}`);
    } finally {
      reloading = false;
      if (pendingAgain) { pendingAgain = false; scheduleReload('(补一轮)'); }
    }
  };
  const scheduleReload = (filename) => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { runReload(filename).catch(() => {}); }, 500);
  };

  for (const root of roots) {
    try {
      watchers.push(fs.watch(root, { recursive: true }, (_e, filename) => scheduleReload(filename)));
    } catch (error) {
      log(`[skill] 无法监听 ${root}：${error?.message ?? error}`);
    }
  }
  log(`[skill] 热重载已启用（监听 ${roots.map((r) => path.basename(r)).join(' + ')}）`);
  return { close: () => { for (const w of watchers) { try { w.close(); } catch { /* ignore */ } } } };
}

/** 卸载一个 Skill（含工具回收）。 */
export function unloadSkill(id, context = {}) {
  return skillManager.unregister(id, context);
}

// ── 内部工具：给测试/排障用 ──
export const SKILL_DIRS = { skills: SKILLS_DIR, plugins: PLUGINS_DIR };
export { skillErrorText };
