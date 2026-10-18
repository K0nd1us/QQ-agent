// NapCat private poke: user_id is the conversation peer; sender_id is the actor.
const idOf = (value) => /^[1-9]\d*$/.test(String(value ?? '')) ? String(value) : '';
export function normalizePokeEvent(event, botId) {
  const selfId = idOf(botId) || idOf(event.self_id);
  const isGroup = event.group_id != null;
  const operatorId = idOf(isGroup ? event.user_id : (event.sender_id ?? event.user_id));
  const targetId = idOf(event.target_id);
  if (!selfId || !operatorId || !targetId || operatorId === selfId) return null;
  let id = isGroup ? idOf(event.group_id) : idOf(event.user_id);
  // Standard OneBot implementations may use user_id for the actor instead.
  if (!isGroup && (!id || id === selfId)) id = operatorId;
  if (!id) return null;
  return { isGroup, id, operatorId, targetId, selfId };
}
