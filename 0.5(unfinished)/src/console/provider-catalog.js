// js-yaml 5.x 只提供命名导出；命名空间导入同时兼容 4.x/5.x。
import * as yaml from 'js-yaml';

// YAML is data only. Credentials are extracted into the host's separate key map;
// the source returned to panels never contains a pasted credential.
export function parseProviderCatalog(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 262144) throw new Error('请提供不超过 256KB 的渠道 YAML');
  const parsed = yaml.load(source, { schema: yaml.JSON_SCHEMA });
  let visited = 0;
  function inspect(value, ancestors = new Set(), depth = 0) {
    if (!value || typeof value !== 'object') return;
    if (depth > 12 || ++visited > 50000 || ancestors.has(value)) throw new Error('渠道 YAML 嵌套过深或包含循环引用');
    const next = new Set(ancestors).add(value);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('渠道 YAML 包含不安全的键');
      inspect(item, next, depth + 1);
    }
  }
  inspect(parsed);
  const raw = parsed?.providers ?? parsed;
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.entries(raw).map(([id, item]) => ({ ...item, id })) : null;
  if (!rows?.length || rows.length > 1000) throw new Error('渠道 YAML 需要 providers 数组或渠道映射（最多 1000 条）');
  const keys = {}, ids = new Set();
  const providers = rows.map((row) => {
    if (!row || typeof row !== 'object') throw new Error('渠道条目必须是对象');
    const id = String(row.id ?? row.name ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || ids.has(id)) throw new Error(`渠道 ID 无效或重复：${id}`);
    ids.add(id);
    const baseUrl = String(row.baseURL ?? row.baseUrl ?? row.base_url ?? '').trim();
    let url; try { url = new URL(baseUrl); } catch { throw new Error(`渠道 ${id} 缺少有效 Base URL`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`渠道 ${id} 需要 http(s) Base URL`);
    const models = (Array.isArray(row.models) ? row.models : Object.keys(row.models ?? {})).map((m) => typeof m === 'string' ? m : String(m?.id ?? m?.model ?? '')).filter(Boolean);
    const key = row.apiKey ?? row.api_key;
    if (typeof key === 'string' && key !== '******') keys[id] = key;
    return { id, displayName: String(row.displayName ?? row.name ?? id), baseUrl, models: [...new Set(models)], ...(row.apiKeyFrom ? { apiKeyFrom: String(row.apiKeyFrom) } : {}) };
  });
  return { providers, keys, source: yaml.dump({ providers }, { noRefs: true }) };
}
