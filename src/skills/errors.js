// Skill 统一错误类型。
//
// 为什么单独定义错误码：UI、日志和工具执行层都需要**明确解释**为什么某个能力不可用，
// 而不是笼统地报"工具关闭"。错误码是机器可读的唯一口径：
//   skill-not-found     Skill 目录里没有这个 id
//   skill-not-loaded    Skill 存在但加载失败（语法/依赖/manifest 错误）
//   skill-disabled      用户关闭了 Skill 开关
//   skill-unavailable   依赖不满足（缺 API Key、模型不支持、缺可执行文件…）
//   skill-timeout       Skill hook 超时（防止一个 Skill 卡死整轮对话）
//   capability-missing  声明了 requires 但没有任何 Skill 提供该能力

export const SKILL_ERROR = {
  NOT_FOUND: 'skill-not-found',
  NOT_LOADED: 'skill-not-loaded',
  DISABLED: 'skill-disabled',
  UNAVAILABLE: 'skill-unavailable',
  TIMEOUT: 'skill-timeout',
  CAPABILITY_MISSING: 'capability-missing'
};

/** 人类可读的原因文案（UI 直接用，不再拼接字符串）。 */
const REASON_TEXT = {
  [SKILL_ERROR.NOT_FOUND]: 'Skill 不存在',
  [SKILL_ERROR.NOT_LOADED]: 'Skill 加载失败',
  [SKILL_ERROR.DISABLED]: 'Skill 未启用',
  [SKILL_ERROR.UNAVAILABLE]: 'Skill 依赖不满足',
  [SKILL_ERROR.TIMEOUT]: 'Skill 执行超时',
  [SKILL_ERROR.CAPABILITY_MISSING]: '缺少所需能力'
};

export class SkillError extends Error {
  constructor(code, message, detail = null) {
    super(message || REASON_TEXT[code] || code);
    this.name = 'SkillError';
    this.code = code;
    this.detail = detail;
  }
}

export function skillErrorText(code) {
  return REASON_TEXT[code] || code;
}
