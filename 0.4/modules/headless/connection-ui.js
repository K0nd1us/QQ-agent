const field = id => document.getElementById(id);
function showType() {
  field('onebot').hidden = field('type').value !== 'onebot';
  field('qqbot').hidden = field('type').value !== 'qqbot';
}
field('type').addEventListener('change', showType);
async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (response.status === 401) { location.assign('/'); throw new Error('请重新登录 / Sign in again'); }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function load() {
  const config = await request('/api/runtime/connection');
  field('enabled').checked = config.enabled;
  field('type').value = config.type;
  for (const id of ['mode', 'apiTransport', 'wsUrl', 'httpUrl', 'reversePath']) field(id).value = config.onebot[id];
  field('appId').value = config.qqbot.appId;
  field('intents').value = config.qqbot.intents;
  field('sandbox').checked = config.qqbot.sandbox;
  showType();
  const status = await request('/api/status');
  field('status').textContent = status.connection.connected ? '已连接 / Connected' : status.onebot.diagnosis;
}
field('connection').addEventListener('submit', async event => {
  event.preventDefault();
  const onebot = Object.fromEntries(['mode', 'apiTransport', 'wsUrl', 'httpUrl', 'reversePath'].map(id => [id, field(id).value.trim()]));
  const qqbot = { appId: field('appId').value.trim(), intents: Number(field('intents').value), sandbox: field('sandbox').checked };
  for (const id of ['accessToken', 'httpAccessToken']) if (field(id).value) onebot[id] = field(id).value;
  if (field('appSecret').value) qqbot.appSecret = field('appSecret').value;
  try {
    await request('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ connection: { enabled: field('enabled').checked, type: field('type').value, onebot, qqbot } }) });
    for (const id of ['accessToken', 'httpAccessToken', 'appSecret']) field(id).value = '';
    field('result').textContent = '已保存 / Saved';
    await load();
  } catch (error) { field('result').textContent = error.message; }
});
load().catch(error => { field('result').textContent = error.message; });
