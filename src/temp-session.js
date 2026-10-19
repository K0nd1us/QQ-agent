// 群成员私聊与群临时会话共用独立的群白名单；空名单始终拒绝，不继承全放行开关。
function qqId(value) {
  const text = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? String(Number(text)) : null;
}

export function privateMessageSource(event) {
  const values = [event.group_id, event.sender?.group_id, event.temp_source?.group_id]
    .filter((value) => value != null && String(value) !== '0');
  const temporary = event.sub_type === 'group' || values.length > 0 || event.temp_source != null;
  const ids = values.map(qqId);
  // 缺失、非法或相互矛盾的来源不能退化为普通好友私聊。
  const groupId = ids.length && ids.every((id) => id && id === ids[0]) ? ids[0] : null;
  return { temporary, groupId };
}

export function tempSessionAllowed(userId, groupId, cfg) {
  const user = qqId(userId);
  const group = qqId(groupId);
  if (!user || !group || cfg.tempSession?.enabled !== true) return false;
  const groups = cfg.tempSession?.groups;
  if (!Array.isArray(groups) || !groups.map(String).includes(group)) return false;
  const deniedGroups = cfg.deny?.group ?? cfg.deny?.groups ?? [];
  const deniedUsers = cfg.deny?.private ?? cfg.deny?.privates ?? [];
  if (deniedGroups.map(String).includes(group) || deniedUsers.map(String).includes(user)) return false;
  return !(cfg.blocklist?.[group] || []).map(String).includes(user);
}

// 入站私聊与 send_to 共用成员校验，历史会话只用于优先查哪个群，不作为成员凭据。
export async function findAllowedMemberGroup(userId, cfg, onebot, { preferredGroupId = null, requiredGroupId, log = null } = {}) {
  const candidates = requiredGroupId !== undefined ? [requiredGroupId]
    : [...new Set([preferredGroupId, ...(Array.isArray(cfg.tempSession?.groups) ? cfg.tempSession.groups : [])])];
  for (const candidate of candidates) {
    const groupId = String(candidate ?? '');
    if (!tempSessionAllowed(userId, groupId, cfg)) continue;
    try {
      const member = await onebot.call('get_group_member_info', {
        group_id: Number(groupId), user_id: Number(userId), no_cache: true
      });
      if (String(member?.user_id ?? '') === String(userId)
        && (member.group_id == null || String(member.group_id) === groupId)) return groupId;
    } catch (error) {
      log?.(`群成员私聊身份校验失败（群 ${groupId}，QQ ${userId}）：${error?.message ?? error}`);
    }
  }
  return null;
}
