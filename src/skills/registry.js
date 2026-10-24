// Skill 注册表：id → Skill 实例。
//
// 只负责"存"，不做开关判断、不做能力解析（那些在 manager.js）。
// 拆开的原因：注册表要被 tool-registry / routes 等模块直接读取，
// 如果它同时依赖 config 就会产生循环引用。

export class SkillRegistry {
  constructor() {
    this.skills = new Map();      // id -> skill 实例
    this.order = [];              // 注册顺序（UI 展示稳定性：不随对象键顺序抖动）
  }

  /**
   * 注册一个 Skill。重复 id 覆盖（热重载场景），并保留原注册顺序。
   * @returns {{ok: boolean, replaced: boolean, error?: string}}
   */
  register(skill) {
    if (!skill?.manifest?.id) return { ok: false, replaced: false, error: '缺少 manifest.id' };
    const id = skill.manifest.id;
    const replaced = this.skills.has(id);
    if (!replaced) this.order.push(id);
    this.skills.set(id, skill);
    return { ok: true, replaced };
  }

  unregister(id) {
    const existed = this.skills.delete(id);
    if (existed) this.order = this.order.filter((x) => x !== id);
    return existed;
  }

  get(id) {
    return this.skills.get(String(id)) ?? null;
  }

  has(id) {
    return this.skills.has(String(id));
  }

  /** 按注册顺序返回全部 Skill。 */
  list() {
    return this.order.map((id) => this.skills.get(id)).filter(Boolean);
  }

  get size() {
    return this.skills.size;
  }

  /** 清空（测试/热重载用）。返回被清空的 id 列表，便于调用方逐个 dispose。 */
  clear() {
    const ids = [...this.order];
    this.skills.clear();
    this.order = [];
    return ids;
  }
}
