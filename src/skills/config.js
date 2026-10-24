// Skill 配置读写：所有 Skill 开关的唯一入口。
//
// 核心原则（防止"多个开关打架"）：
//   1. Skill 的启用状态**只**存在 config.skills[id].enabled 一处；
//      模块不允许再维护 config.xxx.enabled 之类的影子开关。
//   2. 旧配置里的历史字段（如 api.vision、webSearch.enabled）仍然由各自模块读取
//      （它们是"功能开关"，不是"Skill 开关"），但 Skill 自己不再复制一份。
//   3. 读取时用 manifest.settings 作为默认值补齐，保证 Skill 侧拿到的配置形状稳定。

import { getConfig, updateConfig } from '../config.js';

/** 取某个 Skill 的配置对象（已与 manifest 默认值合并）。 */
export function getSkillConfig(id, defaults = {}) {
  const raw = getConfig()?.skills?.[String(id)];
  const merged = { ...(defaults || {}) };
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined) merged[k] = v;
    }
  }
  return merged;
}

/**
 * Skill 是否被用户开启。
 * 未配置过时回退到 manifest 的 enabledByDefault（默认 true）。
 */
export function isSkillEnabledInConfig(id, enabledByDefault = true) {
  const raw = getConfig()?.skills?.[String(id)];
  if (!raw || raw.enabled === undefined) return enabledByDefault !== false;
  return raw.enabled !== false;
}

/** 写入某个 Skill 的配置（浅合并进该 Skill 的命名空间）。 */
export function setSkillConfig(id, patch) {
  const key = String(id);
  const current = getConfig()?.skills?.[key];
  const next = { ...(current && typeof current === 'object' ? current : {}), ...(patch || {}) };
  const cfg = updateConfig({ skills: { [key]: next } });
  return cfg.skills?.[key] || next;
}

/** 只切开关，保留该 Skill 的其它配置。 */
export function setSkillEnabled(id, enabled) {
  return setSkillConfig(id, { enabled: !!enabled });
}

/** 当前配置里已存在的 Skill 配置键（用于 UI 显示"已配置但未安装"的 Skill）。 */
export function listConfiguredSkillIds() {
  const skills = getConfig()?.skills;
  if (!skills || typeof skills !== 'object') return [];
  return Object.keys(skills);
}
