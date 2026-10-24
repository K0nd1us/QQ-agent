// 能力注册表：capability 名 → provider 列表。
//
// 为什么需要它：核心模块（llm / prompt / orchestrator）不应该 import 具体 Skill。
// 它们只问"谁提供 llm.request-params 能力"，由这里回答。
// 这样将来换掉 thinking Skill 的实现，llm.js 一行都不用改。

export class CapabilityRegistry {
  constructor() {
    this.providers = new Map();   // capability -> [{ ownerId, provider }]
  }

  /** 注册一个能力提供者。ownerId 用于卸载时批量清理。 */
  provide(capability, ownerId, provider) {
    const cap = String(capability || '').trim();
    if (!cap) return false;
    // ⚠️ provider 通常是函数（typeof === 'function'），不是 'object'。
    // 只判断 typeof !== 'object' 会把所有函数提供者静默丢掉 —— 表现为
    // "Skill 加载成功、能力却永远查不到"，非常难排查。
    const isFn = typeof provider === 'function';
    const isObj = provider !== null && typeof provider === 'object';
    // null 是**显式占位**：Skill 在 manifest 里声明了能力但没给实现。
    // 允许登记是为了让 explainCapability 能给出"声明了但未实现"这个准确原因；
    // 消费方（manager.getCapabilityProviders）会把它过滤掉，不会拿 null 去调用。
    const isPlaceholder = provider === null;
    if (!isFn && !isObj && !isPlaceholder) return false;
    const list = this.providers.get(cap) || [];
    // 同一 owner 重复注册同一能力：覆盖（热重载），不叠加
    const idx = list.findIndex((p) => p.ownerId === ownerId);
    const entry = { ownerId, provider };
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.providers.set(cap, list);
    return true;
  }

  /** 某个能力的所有提供者（注册顺序）。 */
  providersOf(capability) {
    return [...(this.providers.get(String(capability)) || [])];
  }

  has(capability) {
    return (this.providers.get(String(capability)) || []).length > 0;
  }

  /** 已注册的全部能力名。 */
  list() {
    return [...this.providers.keys()];
  }

  /** 移除某个 owner 的所有能力（Skill 卸载时调用）。 */
  removeOwner(ownerId) {
    let removed = 0;
    for (const [cap, list] of this.providers) {
      const next = list.filter((p) => p.ownerId !== ownerId);
      removed += list.length - next.length;
      if (next.length) this.providers.set(cap, next);
      else this.providers.delete(cap);
    }
    return removed;
  }

  clear() {
    const count = [...this.providers.values()].reduce((a, l) => a + l.length, 0);
    this.providers.clear();
    return count;
  }
}
