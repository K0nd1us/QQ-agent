// 工具注册表：每个工具是一个可插拔的模块。
// 新增工具只需调用 registerTool()，无需改其他代码。
//
// 工具定义字段：
//   id: 唯一标识（如 'send_message'）
//   name: 显示名（如 '发送消息'）
//   description: 功能描述（给模型看的提示词）
//   category: 分类（messaging/sticker/query/memory/web/system）
//   icon: 图标（emoji）
//   defaultEnabled: 默认是否启用
//   requiresVision: 是否需要视觉模型（true 时模型不支持图片则自动禁用）
//   requiresSearch: 是否需要搜索服务（true 时搜索关闭则自动禁用）
//   parameters: OpenAI function 参数 schema
//   execute: 执行函数 (ctx, args) => { content, isError }
//
// ── Skill 化之后的职责划分 ────────────────────────────────────────────────
//   registry（本文件）：存定义 + 算可用性 + 提供查询
//   skills/manager.js ：提供"开关的唯一来源"和"能力依赖"
//   调用方（orchestrator/routes）：只问 getToolAvailability()，不再自己拼条件
//
// 为什么可用性判断必须集中在这里：以前 orchestrator 里散落着
// "全局开关 + 分类开关 + 单工具开关 + vision + search" 五层条件，
// 加了 Skill 开关后如果再散落一处，就会变成六层条件、两个地方各判一半，
// 必然出现"UI 说能用、运行时空工具列表"的割裂。现在只有这一处口径。

import { SKILL_ERROR, skillErrorText } from './skills/errors.js';
// 默认用全局 SkillManager 单例：见下面 getToolAvailability 里的说明。
// 无循环依赖 —— manager.js 只 import registry/capabilities/config/errors，不碰本文件。
import { skillManager as defaultSkillManager } from './skills/manager.js';

const registry = new Map();

/** 注册一个工具。重复注册同 id 会覆盖（后注册的生效）。 */
export function registerTool(def) {
  if (!def?.id) throw new Error('工具必须提供 id');
  if (!def?.name) throw new Error(`工具 ${def.id} 必须提供 name`);
  if (typeof def?.execute !== 'function') throw new Error(`工具 ${def.id} 必须提供 execute 函数`);
  // id 会成为发给模型的 OpenAI function name：字符集 [a-zA-Z0-9_-]、最长 64。
  // 违规 id 会触发严格端点 400，连带整个请求失败——入口直接拒绝，比事后调试便宜。
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(def.id))) {
    throw new Error(`工具 id 不符合 OpenAI 函数名规范 [a-zA-Z0-9_-]{1,64}：${def.id}`);
  }
  registry.set(def.id, Object.freeze({
    category: 'system',
    icon: '🔧',
    defaultEnabled: true,
    requiresVision: false,
    requiresSearch: false,
    // skillId：该工具属于哪个 Skill（内置工具为 null）。
    // 用途：Skill 被禁用时，它注册的工具自动不可用；卸载时按 skillId 批量清理。
    skillId: null,
    // requires：需要的能力名（如 'knowledge.search'）。
    // 与 skillId 的区别：skillId 是"谁注册的"，requires 是"运行时必须有什么能力"。
    requires: [],
    ...def
  }));
}

/** 注销单个工具。 */
export function unregisterTool(id) {
  return registry.delete(String(id));
}

/** 按 Skill 批量注销（Skill 卸载 / 热重载时用）。返回被删除的 id 列表。 */
export function unregisterToolsBySkill(skillId) {
  const ids = [];
  for (const [id, def] of registry) {
    if (def.skillId && def.skillId === skillId) {
      registry.delete(id);
      ids.push(id);
    }
  }
  return ids;
}

/** 获取所有已注册工具（按注册顺序）。 */
export function listTools() {
  return [...registry.values()];
}

/** 按 id 获取工具定义。 */
export function getTool(id) {
  return registry.get(id) ?? null;
}

/** 按分类获取工具列表。 */
export function listToolsByCategory(category) {
  return listTools().filter((t) => t.category === category);
}

/** 获取所有分类（去重）。 */
export function listCategories() {
  const cats = new Set(listTools().map((t) => t.category));
  return [...cats];
}

/** 清空注册表（测试用）。 */
export function clearRegistry() {
  registry.clear();
}

// ── 可用性：唯一口径 ───────────────────────────────────────────────────────

/**
 * 计算某个工具当前是否可用，并给出**机器可读的原因**。
 *
 * 判断顺序（上游不通过就不再看下游，保证 reason 指向真正的原因）：
 *   1. tools.enabled 全局开关
 *   2. 所属 Skill 是否生效（loaded + enabled + available）
 *   3. requires 声明的能力是否可用
 *   4. 分类开关
 *   5. 单工具 overrides
 *   6. requiresVision / requiresSearch 等运行期依赖
 *   7. Skill 提供的 tool.guard 附加否决（可选）
 *
 * @param {string} toolId
 * @param {object} context {
 *   skills,          SkillManager 实例（可选；没有则跳过 Skill 判断）
 *   toolsCfg,        config.tools
 *   visionEnabled,   boolean
 *   searchEnabled,   boolean
 *   runtimeContext,  传给 Skill available/guard 的上下文
 * }
 * @returns {{id: string, enabled: boolean, code: string|null, reason: string, skillId: string|null}}
 */
export function getToolAvailability(toolId, context = {}) {
  const def = registry.get(String(toolId));
  if (!def) {
    return { id: String(toolId), enabled: false, code: SKILL_ERROR.NOT_FOUND, reason: '工具未注册', skillId: null };
  }
  const {
    // skills 缺省时回落到全局单例，**而不是跳过技能检查**。
    //
    // 这是一个真实存在的坑：原来写成 skills = null，而下面的技能判定是
    // `if (def.skillId && skills)` —— 也就是说"调用方忘了传 skills"会让整段
    // 技能开关检查**静默失效**，所有属于技能的工具都被报成可用。
    // 少传一个参数就关掉一道安全检查，这种默认值方向是反的。
    // 现在默认取单例（生产行为的正确来源），需要注入的测试仍然可以显式传。
    skills = defaultSkillManager,
    toolsCfg = {},
    visionEnabled = true,
    searchEnabled = true,
    runtimeContext = {}
  } = context;

  const deny = (code, reason) => ({ id: def.id, enabled: false, code, reason, skillId: def.skillId ?? null });

  // 1) 全局开关
  if (toolsCfg.enabled === false) {
    return deny('tools-disabled', '工具总开关已关闭');
  }

  // 2) 所属 Skill 是否生效
  if (def.skillId && skills) {
    const st = skills.isActive(def.skillId, runtimeContext);
    if (!st.active) {
      return deny(st.code || SKILL_ERROR.DISABLED, `${skillLabel(skills, def.skillId)}：${st.reason}`);
    }
  }

  // 3) 声明的能力
  const requires = Array.isArray(def.requires) ? def.requires : [];
  if (requires.length && skills) {
    for (const cap of requires) {
      const ex = skills.explainCapability(cap, runtimeContext);
      if (!ex.available) {
        return deny(SKILL_ERROR.CAPABILITY_MISSING, `缺少能力 ${cap}：${ex.reason}`);
      }
    }
  }

  // 4) 分类开关
  if (toolsCfg.categories?.[def.category] === false) {
    return deny('category-disabled', `分类「${def.category}」已关闭`);
  }

  // 5) 单工具开关
  const override = toolsCfg.overrides?.[def.id];
  const enabled = override === undefined ? (def.defaultEnabled !== false) : override !== false;
  if (!enabled) {
    return deny('tool-disabled', '该工具已被单独关闭');
  }

  // 5.5) 跨会话发送：send_to 是社交敏感工具，受独立开关管辖（默认关）。
  // 在可用性层拦（而不是只靠描述提示）—— 关闭时模型连工具都看不见。
  if (def.id === 'send_to' && toolsCfg.crossChatSend !== true) {
    return deny('tool-disabled', '跨会话发送未开启（设置 → 工具与技能）');
  }

  // 6) 运行期依赖
  if (def.requiresVision && !visionEnabled) {
    return deny('no-vision', '当前模型不支持图片输入');
  }
  if (def.requiresSearch && !searchEnabled) {
    return deny('no-search', '联网搜索已关闭');
  }

  // 7) Skill 附加否决（tool.guard）
  if (skills) {
    for (const { fn, skillId } of skills.getToolGuards(runtimeContext)) {
      try {
        const r = fn({ toolId: def.id, tool: def, context: runtimeContext });
        if (r === false) return deny('skill-guard', `${skillLabel(skills, skillId)}：运行时否决`);
        if (r && typeof r === 'object' && r.ok === false) {
          return deny('skill-guard', String(r.reason || `${skillLabel(skills, skillId)}：运行时否决`));
        }
      } catch { /* guard 异常不阻断工具，只在别处记日志 */ }
    }
  }

  return { id: def.id, enabled: true, code: null, reason: '', skillId: def.skillId ?? null };
}

/** 列出当前可用的工具定义。 */
export function listAvailableTools(context = {}) {
  return listTools().filter((t) => getToolAvailability(t.id, context).enabled);
}

/** 批量可用性（UI 一次拿全，避免 N 次 IPC/HTTP）。 */
export function availabilityOf(context = {}) {
  return listTools().map((t) => getToolAvailability(t.id, context));
}

function skillLabel(skills, skillId) {
  const st = skills?.status?.(skillId);
  return st?.name || skillId;
}

/** 兼容旧调用：给一个只有 toolsCfg 的调用方算"传统可用性"（不含 Skill 层）。 */
export function isToolEnabledLegacy(def, toolsCfg = {}) {
  return getToolAvailability(def?.id, { toolsCfg }).enabled;
}

// ── 分类元数据（设置页展示用） ──
export const CATEGORY_META = {
  messaging: { name: '消息发送', icon: '💬', description: '发送文字、表情、戳一戳等' },
  sticker: { name: '表情管理', icon: '😀', description: '收藏、查看、备注表情包' },
  query: { name: '消息查询', icon: '🔍', description: '查看历史消息、成员列表等' },
  memory: { name: '记忆系统', icon: '🧠', description: '记录和查询对群友的长期印象' },
  web: { name: '联网搜索', icon: '🌐', description: '搜索网页、抓取内容' },
  knowledge: { name: '知识库', icon: '📚', description: '检索本地知识库并注入上下文' },
  media: { name: '媒体理解', icon: '🎞️', description: '视频抽帧、图片标注等' },
  system: { name: '系统反馈', icon: '⚙️', description: '向控制台反馈、结束会话等' }
};

/** skillErrorText 转出，便于 UI/调用方不额外 import errors.js。 */
export { skillErrorText };
