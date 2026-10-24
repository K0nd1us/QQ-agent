// Skill Manifest 规范化与校验。
//
// 加载单元统称 Skill，按**语义**分两型（见下面的 DIR_KIND）：
//   确定性型（plugins/）—— 核心通过**能力名**取用，满足条件必然执行，不经过 LLM
//   LLM 型（skills/）  —— 注册**工具**进模型的 function 列表，由模型决定何时调用
// 两型走同一条 normalizeManifest，字段与扩展点完全等价；"通过能力名依赖而不是
// 硬编码 Skill 名字"这一点对两型都成立 —— 替换实现不需要改核心代码。
//
// manifest 字段：
//   id                  唯一标识（目录名不一致时以 manifest 为准）
//   name                显示名
//   version             语义化版本
//   apiVersion          Skill API 版本（当前 1）
//   enabledByDefault    默认开关（用户没配置过时用这个）
//   category            model | message | knowledge | media | utility
//   description         一句话说明（UI 展示）
//   requires            依赖的能力名数组（如 ['web.fetch']）
//   capabilities        本 Skill 提供的能力名数组
//   configSchema        配置项声明（UI 据此渲染表单）
//   settings            该 Skill 的默认配置值
//   prompt              提示词片段声明（见 promptSections）
//   deprecated          标记为过期的 Skill（仍可加载，UI 提示）

export const SKILL_API_VERSION = 1;

/**
 * 两型的目录语义（本项目唯一约定）：
 *
 *   plugins/  确定性型（kind = 'plugin'）
 *             提供**能力**（providers）或**钩子**（hooks）。核心代码按能力名取用，
 *             满足条件就一定被执行 —— 不经过 LLM，模型想忽略也忽略不掉。
 *
 *   skills/   LLM 型（kind = 'skill'）
 *             注册**工具**（registerTool）+ 提示词片段。工具进模型的 function 列表，
 *             用不用、什么时候用由模型自己判断。
 *
 * ⚠️ 这只是**语义归类**，不是能力限制：两种清单文件（plugin.json / skill.json）
 * 走同一条 normalizeManifest，功能完全等价。
 */
export const DIR_KIND = { plugins: 'plugin', skills: 'skill' };
export const KIND_LABEL = { plugin: '确定性型', skill: 'LLM 型' };

/** 由目录路径推断类型；目录名不认识（测试用自定义根）时返回 null = 不判定。 */
export function kindOfDir(dirPath) {
  const base = String(dirPath ?? '').replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return DIR_KIND[String(base || '').toLowerCase()] || null;
}

const VALID_CATEGORIES = new Set(['model', 'message', 'knowledge', 'media', 'utility']);

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function cleanString(value, fallback = '') {
  const s = String(value ?? '').trim();
  return s || fallback;
}

/**
 * 规范化 manifest：补默认值、去重、筛掉非法项。
 * 不做"必须合法否则抛错"的强校验 —— 单个 Skill 写错 manifest 不应该拖垮整个启动，
 * 由调用方根据返回的 problems 决定是警告还是拒绝加载。
 */
export function normalizeManifest(raw, { fallbackId = '' } = {}) {
  const problems = [];
  if (!raw || typeof raw !== 'object') {
    return { manifest: null, problems: ['manifest 不是对象'] };
  }

  const id = cleanString(raw.id, fallbackId);
  if (!id) problems.push('缺少 id');
  if (id && !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    problems.push(`id 只能包含字母/数字/._-（当前：${id}）`);
  }

  const name = cleanString(raw.name, id || '未命名 Skill');
  const version = cleanString(raw.version, '0.0.0');
  const apiVersion = Number(raw.apiVersion) || SKILL_API_VERSION;
  if (apiVersion > SKILL_API_VERSION) {
    problems.push(`apiVersion ${apiVersion} 高于当前支持的 ${SKILL_API_VERSION}`);
  }

  const category = VALID_CATEGORIES.has(raw.category) ? raw.category : 'utility';
  if (raw.category && !VALID_CATEGORIES.has(raw.category)) {
    problems.push(`category 非法（${raw.category}），已回退为 utility`);
  }

  const capabilities = [...new Set(asArray(raw.capabilities))];
  const requires = [...new Set(asArray(raw.requires))];

  // 自依赖是配置错误，去掉它而不是让可用性检查永远失败
  const selfDep = requires.filter((r) => capabilities.includes(r));
  const requiresClean = requires.filter((r) => !capabilities.includes(r));

  return {
    manifest: {
      id,
      name,
      version,
      apiVersion,
      enabledByDefault: raw.enabledByDefault !== false,
      category,
      description: cleanString(raw.description, ''),
      author: cleanString(raw.author, ''),
      requires: requiresClean,
      capabilities,
      configSchema: (raw.configSchema && typeof raw.configSchema === 'object') ? raw.configSchema : {},
      settings: (raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) ? raw.settings : {},
      prompt: normalizePrompt(raw.prompt),
      deprecated: raw.deprecated === true
    },
    problems
  };
}

/** 提示词片段声明：一律带 priority，且强制低于核心安全规则（100）。 */
function normalizePrompt(prompt) {
  if (!prompt || typeof prompt !== 'object') return null;
  const sections = Array.isArray(prompt.sections) ? prompt.sections : [];
  const normalized = sections
    .map((s, i) => ({
      id: cleanString(s?.id, `section-${i}`),
      title: cleanString(s?.title, ''),
      content: String(s?.content ?? '').trim(),
      // Skill 不得覆盖核心安全规则：priority 上限 99
      priority: Math.min(99, Number(s?.priority) || 50)
    }))
    .filter((s) => s.content);
  if (!normalized.length && !prompt.instruction) return null;
  if (!normalized.length && prompt.instruction) {
    normalized.push({ id: 'main', title: '', content: String(prompt.instruction).trim(), priority: 50 });
  }
  return { sections: normalized };
}

/** 判断 manifest 是否可用（没有致命问题）。 */
export function isManifestUsable(manifest, problems) {
  if (!manifest) return false;
  return !problems.some((p) => p.startsWith('缺少 id') || p.includes('id 只能包含'));
}
