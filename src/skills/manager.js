// Skill 管理器：核心模块与 Skill 之间唯一的交互口。
//
// 设计要点（对应"开关不打架"的三条规则）：
//   1. 唯一开关来源：启用状态只读 config.skills[id].enabled；
//      模块不再自己维护 isXxxEnabled，一律问 SkillManager。
//   2. 能力优先于名字：核心模块按 capability 取提供者
//      （如 hasCapability('llm.request-params')），不 import 具体 Skill。
//   3. 三层状态可解释：loaded / enabled / available 分开表达，
//      任何一层不通过都能给出明确 reason，UI 直接展示原因而不是"工具关闭"。
//
// 生命周期：
//   register → (activate) → … → deactivate → dispose
//   禁用 Skill 一定调 deactivate（清监听器/定时器/注册的工具），
//   不能只在前端把 checkbox 取消 —— 否则会留下幽灵行为。

import { SkillRegistry } from './registry.js';
import { CapabilityRegistry } from './capabilities.js';
import { SKILL_ERROR, SkillError, skillErrorText } from './errors.js';
import { isSkillEnabledInConfig, getSkillConfig } from './config.js';

/** hook 默认超时：单个 Skill 卡死不能拖垮整轮对话。 */
const DEFAULT_HOOK_TIMEOUT_MS = 5000;

/**
 * 天生允许**多个提供者**的能力。
 *
 * 大多数能力是"单提供者"（比如 video.frames：抽帧只能有一份实现），
 * 两个技能抢同一个名字就是配置错误。
 * 但有几类语义上就是"一条流水线上的多个环节"，必须允许多个：
 *   · llm.retry-advisor —— 思考参数降级、图片格式降级……各管一类错误，
 *     llm.js 会挨个问过去，谁认领谁处理（返回 null 表示"不归我管"）
 *   · llm.request-params / llm.response / llm.usage —— 同理，是转换链
 *   · tool.guard —— 每个技能都可以加一道自己的守卫
 *   · media.download —— 按平台拆分实现：B站插件、抖音插件各提供一个，
 *     核心把消息里的链接挨个问过去，谁认领谁处理。新增平台 = 再加一个提供者，
 *     不需要改核心，所以这里必须允许多个。
 * 列出它们，是为了让"能力名冲突"检查既严格又不误报。
 */
export const MULTI_PROVIDER_CAPABILITIES = new Set([
  'llm.request-params',
  'llm.response',
  'llm.usage',
  'llm.retry-advisor',
  'tool.guard',
  'media.download'
]);

export class SkillManager {
  constructor({ log = () => {} } = {}) {
    this.registry = new SkillRegistry();
    this.capabilities = new CapabilityRegistry();
    this.log = log;
    this.hookTimeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
    this.errors = new Map();         // id -> 最近一次错误文案（UI 排障用）
  }

  setLog(fn) {
    if (typeof fn === 'function') this.log = fn;
  }

  // ── 注册 / 卸载 ──────────────────────────────────────────────────────────

  /**
   * 注册一个 Skill。
   * @param {object} skill 见文件头部的实例形状说明
   * @returns {{ok: boolean, id: string, error?: string}}
   */
  register(skill) {
    const id = skill?.manifest?.id;
    if (!id) return { ok: false, id: '', error: '缺少 manifest.id' };

    // 覆盖注册（热重载）时必须走完整生命周期：**先 deactivate 再 dispose**。
    // 历史上这里只调 dispose（只回收工具），不调 deactivate ——
    // 开发模式每次保存文件都会重载，Skill 在 activate 里建立的定时器/订阅
    // 就永久泄漏（累积幽灵行为：重复推送、重复发言、内存增长）。
    const prev = this.registry.get(id);
    if (prev) {
      this.#safeCall(prev, 'deactivate', { reason: 'reload' });
      if (typeof prev.dispose === 'function') {
        try { prev.dispose(); } catch (error) { this.#warn(id, 'dispose 失败', error); }
      }
    }
    // 覆盖注册时先清掉旧能力，避免旧实现的能力残留
    this.capabilities.removeOwner(id);

    const r = this.registry.register(skill);
    if (!r.ok) return { ok: false, id, error: r.error };

    // 注册能力提供者
    for (const [cap, fn] of Object.entries(skill.providers || {})) {
      if (typeof fn === 'function') this.capabilities.provide(cap, id, fn);
    }
    // manifest 里声明但没给实现的 capability 也登记占位（provider = null），
    // 让 hasCapability / explainCapability 能看到"这个 Skill 自称提供"，
    // 具体调用时再检查实现 —— 否则会出现"Skill 列表说提供、能力表查不到"的口径分裂。
    for (const cap of skill.manifest.capabilities || []) {
      if (!Object.prototype.hasOwnProperty.call(skill.providers || {}, cap)) {
        this.capabilities.provide(cap, id, null);
      }
    }
    return { ok: true, id, replaced: r.replaced };
  }

  /** 注销 Skill（热重载 / 卸载）。会先 deactivate 再 dispose。 */
  unregister(id, context = {}) {
    const skill = this.registry.get(id);
    if (!skill) return false;
    this.#safeCall(skill, 'deactivate', context);
    this.#safeCall(skill, 'dispose');
    this.capabilities.removeOwner(id);
    this.registry.unregister(id);
    this.errors.delete(id);
    return true;
  }

  /**
   * 让"注册表内容"与"磁盘上实际存在的 Skill"对齐：
   * 卸载掉已经不在磁盘上的（开发期删目录 / 改名），避免幽灵工具与能力残留。
   * @param {string[]} aliveIds 本次扫描到的全部 id
   * @returns {string[]} 被卸掉的 id
   */
  pruneMissing(aliveIds = [], context = {}) {
    const alive = new Set(aliveIds.map(String));
    const removed = [];
    for (const skill of this.registry.list()) {
      const id = skill?.manifest?.id;
      if (id && !alive.has(id)) {
        this.unregister(id, { ...context, reason: 'pruned' });
        removed.push(id);
      }
    }
    return removed;
  }

  // ── 状态查询 ────────────────────────────────────────────────────────────

  isLoaded(id) {
    const skill = this.registry.get(id);
    return Boolean(skill) && skill.loadError == null;
  }

  isEnabled(id) {
    const skill = this.registry.get(id);
    const dflt = skill?.manifest?.enabledByDefault !== false;
    return isSkillEnabledInConfig(id, dflt);
  }

  /**
   * 依赖是否满足。递归检查 requires（带 visited 防环）。
   * Skill 可以自定义 available(ctx) 返回 boolean 或 { ok, reason }。
   */
  isAvailable(id, context = {}, visited = new Set()) {
    const skill = this.registry.get(id);
    if (!skill) return { ok: false, code: SKILL_ERROR.NOT_FOUND, reason: skillErrorText(SKILL_ERROR.NOT_FOUND) };
    if (skill.loadError) {
      return { ok: false, code: SKILL_ERROR.NOT_LOADED, reason: skill.loadError };
    }
    if (visited.has(id)) return { ok: true, code: null, reason: '' };
    visited.add(id);

    // 依赖能力：必须存在**已启用且可用**的提供者
    for (const cap of skill.manifest.requires || []) {
      const providers = this.capabilities.providersOf(cap);
      if (!providers.length) {
        return {
          ok: false,
          code: SKILL_ERROR.CAPABILITY_MISSING,
          reason: `缺少能力：${cap}`,
          detail: { capability: cap }
        };
      }
      const usable = providers.some((p) => {
        if (p.ownerId === id) return false;   // 自己提供的不算（已从 requires 过滤，防御）
        return this.isActive(p.ownerId, context, visited).active;
      });
      if (!usable) {
        return {
          ok: false,
          code: SKILL_ERROR.CAPABILITY_MISSING,
          reason: `能力提供者不可用：${cap}`,
          detail: { capability: cap }
        };
      }
    }

    // Skill 自检（缺 Key、缺二进制、模型不支持…）
    if (typeof skill.available === 'function') {
      try {
        const r = skill.available(context);
        if (r === false) {
          return { ok: false, code: SKILL_ERROR.UNAVAILABLE, reason: skill.availableReason || '依赖不满足' };
        }
        if (r && typeof r === 'object' && r.ok === false) {
          return { ok: false, code: SKILL_ERROR.UNAVAILABLE, reason: String(r.reason || '依赖不满足'), detail: r.detail };
        }
      } catch (error) {
        return { ok: false, code: SKILL_ERROR.UNAVAILABLE, reason: `自检异常：${error?.message ?? error}` };
      }
    }
    return { ok: true, code: null, reason: '' };
  }

  /**
   * 最终是否实际生效：loaded && enabled && available && 依赖满足。
   * 这里是所有"这个功能能不能用"判断的唯一出口。
   */
  isActive(id, context = {}, visited = new Set()) {
    if (!this.isLoaded(id)) {
      const avail = this.isAvailable(id, context, visited);
      return { active: false, code: avail.code || SKILL_ERROR.NOT_LOADED, reason: avail.reason || skillErrorText(SKILL_ERROR.NOT_LOADED) };
    }
    if (!this.isEnabled(id)) {
      return { active: false, code: SKILL_ERROR.DISABLED, reason: skillErrorText(SKILL_ERROR.DISABLED) };
    }
    const avail = this.isAvailable(id, context, visited);
    if (!avail.ok) return { active: false, code: avail.code, reason: avail.reason, detail: avail.detail };
    return { active: true, code: null, reason: '' };
  }

  /** UI 用的完整状态列表。 */
  list(context = {}) {
    return this.registry.list().map((skill) => this.status(skill.manifest.id, context));
  }

  status(id, context = {}) {
    const skill = this.registry.get(id);
    if (!skill) {
      return {
        id: String(id), name: String(id), loaded: false, enabled: false, available: false, active: false,
        code: SKILL_ERROR.NOT_FOUND, reason: skillErrorText(SKILL_ERROR.NOT_FOUND)
      };
    }
    const m = skill.manifest;
    const enabled = this.isEnabled(id);
    const a = this.isActive(id, context);
    const missing = (m.requires || []).filter((cap) => !this.capabilities.has(cap));
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      apiVersion: m.apiVersion,
      category: m.category,
      description: m.description,
      deprecated: m.deprecated,
      source: skill.source || 'skill',
      // 目录语义类型 + 所在目录（仓库相对路径）：
      //   kind = 'plugin' 确定性型（能力/钩子，必然触发）
      //   kind = 'skill'  LLM 型（注册工具，模型决定）
      // 放这里而不是让调用方按清单**文件名**去猜目录 —— "文件名"与"目录语义"是两件事，
      // 混用会在改名/挪目录时静默判错（审计脚本原来就是这么脆的）。
      kind: skill.kind || null,
      dir: skill.relDir || '',
      hasSettings: Object.keys(m.settings || {}).length > 0 || Object.keys(m.configSchema || {}).length > 0,
      loaded: !skill.loadError,
      // loadError：本次加载失败的具体原因（清单/入口/setup 抛错）。
      // UI 据此渲染"加载失败"徽章与红色原因行 —— 失败条目现在也会注册进表，
      // 不再表现为"条目凭空消失"。
      loadError: skill.loadError || '',
      enabled,
      available: a.active || (a.code !== SKILL_ERROR.UNAVAILABLE && a.code !== SKILL_ERROR.CAPABILITY_MISSING && a.code !== SKILL_ERROR.NOT_FOUND),
      active: a.active,
      code: a.code,
      reason: a.reason,
      lastError: this.errors.get(id) || '',
      capabilities: [...(m.capabilities || [])],
      // implementedCapabilities：代码里**实际实现**的能力（providers 的键）。
      // 与声明的 capabilities 对比能发现两类静默故障：
      //   · 声明了但没实现 → 调用方拿到空数组，功能悄悄失效
      //   · 实现了但没声明 → 用户看不出它提供什么，也可能被别人重复实现
      // 放进视图（而不是只写在测试里），是为了让 UI 也能显示成警告。
      implementedCapabilities: Object.keys(skill.providers || {}),
      // 该模块注册的行为钩子名（确定性型常见形态：靠钩子插进主流程）
      hooks: Object.keys(skill.hooks || {}),
      // 当前设置值（密文已脱敏）与字段描述 —— UI 靠这两个渲染"技能设置"弹窗。
      // 放在列表里而不是让前端再发一次请求：技能页本来就要拉一次列表。
      settings: this.settingsView(id),
      configSchema: (m.configSchema && typeof m.configSchema === 'object') ? m.configSchema : {},
      requires: [...(m.requires || [])],
      missingRequires: missing,
      toolIds: [...(skill.toolIds || [])]
    };
  }

  // ── 开关 ────────────────────────────────────────────────────────────────

  /**
   * 开启 Skill 并调用 activate 生命周期。
   * 配置写入由调用方（routes）负责，这里只管生命周期回调，
   * 避免"改配置"和"跑回调"两件事耦合在一个函数里。
   */
  activate(id, context = {}) {
    const skill = this.registry.get(id);
    if (!skill) throw new SkillError(SKILL_ERROR.NOT_FOUND, `Skill 不存在：${id}`);
    this.#safeCall(skill, 'activate', context);
    return true;
  }

  deactivate(id, context = {}) {
    const skill = this.registry.get(id);
    if (!skill) return false;
    this.#safeCall(skill, 'deactivate', context);
    return true;
  }

  /** 当前配置下的 Skill 设置（已合并 manifest 默认值）。 */
  settingsOf(id) {
    const skill = this.registry.get(id);
    if (!skill) return {};
    return getSkillConfig(id, skill.manifest.settings || {});
  }

  // ── 能力 ────────────────────────────────────────────────────────────────
  /**
   * 技能的对外设置视图（给 UI 渲染表单用）。
   *
   * 密文字段（configSchema 里标了 secret: true）脱敏成 '******'：
   * 设置接口会把整个配置回给前端，明文 Key/Cookie 不该出现在响应里。
   * 写入侧约定：收到 '******' 或空串表示"不修改"，保持原值
   * —— 否则用户只是打开表单点了保存，密文就被覆盖成六个星号了。
   *
   * ⚠️ secret 判定还必须**下钻一层**（2026-09-26 审查二轮发现）：
   *   ① 字段名兜底：manifest 作者忘了在 configSchema 标 secret 时，
   *      名字命中 /key|token|secret|cookie|password/i 的字符串字段同样脱敏
   *      —— skills/web-fetch 的 cookie（type=internal，无 secret 标记）曾把
   *      SESSDATA 明文回传给浏览器。
   *   ② 数组内对象：plugins/account-pool 的 settings.accounts[].key 存的是
   *      真实 API Key，字段在数组第二层，顶层判 secret 永远罩不住它。
   *      数组里的条目按"字段名含 key/token/secret/password 的字符串值"逐个
   *      掩码（cookie 不掩：数组里没有这种形态，过度掩码会破坏 UI 结构）。
   */
  settingsView(id) {
    const skill = this.registry.get(id);
    if (!skill) return {};
    const values = this.settingsOf(id);
    const schema = skill.manifest.configSchema || {};
    const SECRET_NAME_RE = /key|token|secret|password|cookie/i;
    const mask = (v) => (String(v ?? '').trim() ? '******' : '');
    const isSecretField = (k) => Boolean(schema[k]?.secret)
      || (SECRET_NAME_RE.test(k) && typeof values[k] === 'string');
    const out = {};
    for (const [k, v] of Object.entries(values)) {
      if (isSecretField(k)) { out[k] = mask(v); continue; }
      if (Array.isArray(v)) {
        // 数组型密钥容器（account-pool 的 accounts）：只掩码条目里的密钥值，
        // 其余字段（id/baseUrl/model 等 UI 要显示的结构）原样保留
        out[k] = v.map((item) => {
          if (!item || typeof item !== 'object') return item;
          const clone = { ...item };
          for (const [ik, iv] of Object.entries(clone)) {
            if (SECRET_NAME_RE.test(ik) && typeof iv === 'string' && iv.trim()) clone[ik] = '******';
          }
          return clone;
        });
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  /**
   * 该能力是否有**真实实现**的提供者（占位登记不算）。
   * 语义对齐 getCapabilityProviders：两边都以"能用"为准，
   * 避免出现"hasCapability 说能、取提供者却是空"的口径分裂。
   */
  hasCapability(capability) {
    return this.getCapabilityProviders(capability).length > 0;
  }

  /** 取所有**生效中**的能力提供者。context 用于可用性判断。 */
  getCapabilityProviders(capability, context = {}) {
    return this.capabilities.providersOf(capability)
      .filter((p) => p.provider !== null && p.provider !== undefined)   // 排除"仅声明未实现"的占位
      .filter((p) => this.isActive(p.ownerId, context).active)
      .map((p) => ({ skillId: p.ownerId, fn: p.provider }));
  }

  /** 明确列出能力的不可用原因（UI/排障用）。 */
  explainCapability(capability, context = {}) {
    const all = this.capabilities.providersOf(capability);
    if (!all.length) {
      return { available: false, reason: `没有任何 Skill 提供能力：${capability}`, providers: [] };
    }
    const details = all.map((p) => {
      const a = this.isActive(p.ownerId, context);
      const implemented = p.provider !== null && p.provider !== undefined;
      return {
        skillId: p.ownerId,
        active: a.active,
        code: a.code,
        reason: a.reason,
        implemented,
        usable: a.active && implemented
      };
    });
    const anyUsable = details.some((d) => d.usable);
    let reason = '';
    if (!anyUsable) {
      reason = details
        .map((d) => (d.implemented
          ? `${d.skillId}：${d.reason || '不可用'}`
          : `${d.skillId}：声明了能力 ${capability} 但未提供实现`))
        .join('；') || '提供者均不可用';
    }
    return { available: anyUsable, reason, providers: details };
  }

  // ── 扩展点 ──────────────────────────────────────────────────────────────

  /**
   * 顺序执行某个 hook。错误隔离：单个 Skill 抛错只记日志，不影响其它 Skill；
   * 超时同样跳过（Promise.race + unref 定时器，不阻塞进程退出）。
   */
  async runHook(name, context = {}) {
    const results = [];
    for (const skill of this.registry.list()) {
      const fn = skill.hooks?.[name];
      if (typeof fn !== 'function') continue;
      const st = this.isActive(skill.manifest.id, context);
      if (!st.active) continue;
      try {
        const out = await this.#withTimeout(fn(context, { skillId: skill.manifest.id }), skill.manifest.id);
        if (out !== undefined) results.push({ skillId: skill.manifest.id, value: out });
      } catch (error) {
        this.#warn(skill.manifest.id, `hook ${name} 失败`, error);
      }
    }
    return results;
  }

  /**
   * 收集提示词片段。priority 降序（数字大的更靠前），
   * 且一律排在核心系统提示词之后由 prompt.js 决定插入位置。
   */
  getPromptSections(context = {}) {
    const out = [];
    for (const skill of this.registry.list()) {
      const st = this.isActive(skill.manifest.id, context);
      if (!st.active) continue;
      const sections = skill.manifest.prompt?.sections || [];
      for (const s of sections) out.push({ ...s, skillId: skill.manifest.id });
      // 动态片段：Skill 可选实现 promptSections(context)
      if (typeof skill.promptSections === 'function') {
        try {
          const dyn = skill.promptSections(context);
          for (const s of dyn || []) {
            if (!s?.content) continue;
            out.push({
              id: String(s.id || `${skill.manifest.id}-dynamic`),
              title: String(s.title || ''),
              content: String(s.content),
              priority: Math.min(99, Number(s.priority) || 40),
              skillId: skill.manifest.id
            });
          }
        } catch (error) {
          this.#warn(skill.manifest.id, 'promptSections 失败', error);
        }
      }
    }
    // 去重（同 id 后写覆盖），再按 priority 降序
    const byId = new Map();
    for (const s of out) byId.set(s.id, s);
    return [...byId.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /** LLM 请求参数转换器（按注册顺序串行，后者能看到前者的输出）。 */
  getRequestTransforms(context = {}) {
    return this.getCapabilityProviders('llm.request-params', context).map((p) => p.fn);
  }

  /** LLM 响应转换器。 */
  getResponseTransforms(context = {}) {
    return this.getCapabilityProviders('llm.response', context).map((p) => p.fn);
  }

  /** LLM usage 附加统计（如 reasoning tokens）。 */
  getUsageTransforms(context = {}) {
    return this.getCapabilityProviders('llm.usage', context).map((p) => p.fn);
  }

  /**
   * 请求失败后是否可以"换个姿势重试"。
   * Skill 只给建议，真正的重试仍由 llm.js 执行 —— 这样超时、abort、
   * 计费、日志、fallback 模型都不会被绕过。
   */
  getRetryAdvisors(context = {}) {
    return this.getCapabilityProviders('llm.retry-advisor', context).map((p) => ({ fn: p.fn, skillId: p.skillId }));
  }

  /** 工具可用性附加判断器：Skill 可以否决自己注册的工具。 */
  getToolGuards(context = {}) {
    return this.getCapabilityProviders('tool.guard', context).map((p) => ({ fn: p.fn, skillId: p.skillId }));
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────

  /** 给 /api/status 用的紧凑摘要。 */
  summary(context = {}) {
    const list = this.list(context);
    return {
      total: list.length,
      active: list.filter((s) => s.active).length,
      disabled: list.filter((s) => s.loaded && !s.enabled).length,
      broken: list.filter((s) => !s.loaded).length,
      capabilities: this.capabilities.list().sort()
    };
  }

  /** 记录一个 Skill 的运行期错误（UI 展示"上次出错"）。 */
  recordError(id, error) {
    const msg = String(error?.message ?? error ?? '').slice(0, 300);
    if (msg) this.errors.set(String(id), msg);
  }

  #warn(id, message, error) {
    const text = `[skill:${id}] ${message}：${error?.message ?? error}`;
    try { this.log(text); } catch { /* 日志失败不影响主流程 */ }
    this.recordError(id, error);
  }

  #safeCall(skill, method, arg) {
    const fn = skill?.[method];
    if (typeof fn !== 'function') return;
    try { fn(arg); } catch (error) { this.#warn(skill.manifest.id, `${method} 失败`, error); }
  }

  #withTimeout(promise, id) {
    if (!this.hookTimeoutMs || !Number.isFinite(this.hookTimeoutMs)) return promise;
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SkillError(SKILL_ERROR.TIMEOUT, `Skill ${id} 执行超时（${this.hookTimeoutMs}ms）`)), this.hookTimeoutMs);
      // ⚠️ 这里**不能** unref：
      //    unref 后，如果 hook 自身永不 resolve 且当时没有其它任务让事件循环保持活跃
      //    （例如脚本里单独跑一次 hook），Node 会直接退出进程 —— 超时永远不触发，
      //    表现为"调用一个卡死的 Skill，进程静默消失"。
      //    定时器不会被漏掉：无论谁先结束，.finally 都会 clearTimeout。
    });
    return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
  }
}

/** 进程级单例：所有模块共享同一份 Skill 状态。 */
export const skillManager = new SkillManager();
