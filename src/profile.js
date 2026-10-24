// Profile identity is deliberately limited to a numeric instance id.
const rawProfile = String(process.env.QQ_AGENT_PROFILE ?? '').trim();

export const PROFILE_ID = /^\d+$/.test(rawProfile) ? rawProfile : '';

export function isSecondary() {
  return PROFILE_ID !== '';
}

export function profileSuffix() {
  return isSecondary() ? `-${PROFILE_ID}` : '';
}

export function dataDirName() {
  return `data${profileSuffix()}`;
}

export function portOffset() {
  // 每个实例偏移 PROFILE_ID * 100：#2 → +100、#3 → +200。
  // 恒 100 的旧实现会让 #2 和 #3 的 HTTP/OneBot 端口互撞。
  return isSecondary() ? Number(PROFILE_ID) * 100 : 0;
}

export function describeInstance() {
  return isSecondary() ? `QQ Agent #${PROFILE_ID}` : 'QQ Agent';
}
