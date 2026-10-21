/** Preserve the existing UTF-16 length budget without cutting a surrogate pair in half. */
export function truncateText(text, limit) {
  let end = Math.min(text.length, Math.max(0, Math.floor(Number(limit) || 0)));
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  }
  return text.slice(0, end);
}

/** Strict JSON decoders reject lone UTF-16 surrogates. Repair string values after all transforms. */
export function stringifyWellFormedJson(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'string' ? item.toWellFormed() : item);
}
