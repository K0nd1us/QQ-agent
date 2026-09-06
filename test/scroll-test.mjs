// 验证存档滚动加载修复：
//   ① 多次渲染不会重复挂监听器
//   ② 加载更多时滚动位置保持（不"自己往上滚"）
//   ③ 只替换 tbody，外层结构不被重建（工具栏事件不重复绑定）
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { if (c) { pass++; console.log('  OK   ' + n); } else { fail++; console.log('  FAIL ' + n + (e ? ' -> ' + e : '')); } };

// ── 可测滚动的 DOM 桩 ──
const listeners = new Map();          // el -> { scroll: [fn] }
function makeEl(id = '', tag = 'div') {
  const el = {
    id, tag, dataset: {}, _cls: new Set(),
    style: { setProperty() {}, removeProperty() {} },
    textContent: '', innerHTML: '',
    value: '', checked: false, children: [],
    classList: null,
    // 滚动相关：可读写，模拟真实容器
    scrollTop: 0, scrollHeight: 1000, clientHeight: 500,
    // 每次 innerHTML 被重写，浏览器会重置 scrollTop（这就是原来的 bug）
    _resetScrollOnHtml() { el.scrollTop = 0; },
    addEventListener(ev, fn) {
      const key = ev;
      if (!listeners.has(el)) listeners.set(el, {});
      const bag = listeners.get(el);
      (bag[key] ||= []).push(fn);
    },
    removeEventListener() {},
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    insertAdjacentHTML(pos, html) { if (pos === 'beforeend') el.innerHTML += html; },
    appendChild(c) { el.children.push(c); return c; },
    remove() {}, closest: () => null,
    setAttribute() {}, getAttribute: () => null,
    focus() {}, scrollIntoView() {}
  };
  el.classList = {
    add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
    toggle: (c, on) => { if (on) el._cls.add(c); else el._cls.delete(c); },
    contains: (c) => el._cls.has(c)
  };
  return el;
}

const byId = new Map();
const document = {
  documentElement: makeEl('html'), body: makeEl('body'), head: makeEl('head'),
  querySelector(sel) {
    if (sel.startsWith('#')) return document.getElementById(sel.slice(1));
    if (!byId.has(sel)) byId.set(sel, makeEl(sel));
    return byId.get(sel);
  },
  querySelectorAll: () => [],
  getElementById(id) {
    if (!byId.has('#' + id)) byId.set('#' + id, makeEl(id));
    return byId.get('#' + id);
  },
  createElement: (tag) => makeEl('', tag),
  addEventListener() {}
};

// 关键：让 #chat-detail 的 innerHTML 重写会重置 scrollTop（模拟浏览器真实行为）
const chatDetail = document.getElementById('chat-detail');
Object.defineProperty(chatDetail, 'innerHTML', {
  get() { return chatDetail._html || ''; },
  set(v) { chatDetail._html = v; chatDetail.scrollTop = 0; }   // 浏览器行为
});
const tbody = document.getElementById('chat-msg-body');
const more = document.getElementById('chat-msg-more');

const sandbox = {
  document, window: null,
  localStorage: { getItem: () => null, setItem() {} },
  location: { href: 'http://127.0.0.1/' },
  fetch: async () => ({ ok: true, json: async () => ({ messages: [] }) }),
  EventSource: function () { this.addEventListener = () => {}; this.close = () => {}; },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  alert: () => {}, confirm: () => true,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  navigator: { userAgent: 'node' }, requestAnimationFrame: (f) => setTimeout(f, 0),
  URL, Intl, Math, JSON, Date, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone: (x) => JSON.parse(JSON.stringify(x))
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
new vm.Script(code, { filename: 'ui/app.js' }).runInContext(ctx);

const CHAT_MSG_PAGE_GUESS = 500;
const state_currentChatKey = 'group:test';

// 造 1200 条消息
const msgs = [];
for (let i = 0; i < 1200; i++) {
  msgs.push({ id: i + 1, ts: 1000 + i, senderId: 'u' + (i % 7), senderName: '群友' + (i % 7), text: '消息' + i, self: false, read: true, media: [] });
}
vm.runInContext('state.chatMessages = ' + JSON.stringify(msgs) + ';', ctx);
vm.runInContext("state.currentChatKey = 'group:test';", ctx);
vm.runInContext('state.chats = [{ key: "group:test", total: 1200 }];', ctx);

console.log('=== ① 监听器只挂一次 ===');
const renderChat = ctx.renderChatMessages;
const updateBody = ctx.updateChatMessagesBody;
const initLoader = ctx.initChatScrollLoader;

// 首次渲染会自己调 initChatScrollLoader
renderChat();
const n1 = (listeners.get(chatDetail)?.scroll || []).length;
check('首次渲染挂 1 个监听器', n1 === 1, `实际 ${n1}`);

// 再多次调用（模拟反复渲染）
for (let i = 0; i < 5; i++) initLoader();
const n2 = (listeners.get(chatDetail)?.scroll || []).length;
check('重复调用 5 次仍只有 1 个', n2 === 1, `实际 ${n2}（>1 说明没防重复）`);

// 模拟"用户滚到底部"：scrollTop 设为 总高-可视高（触发条件才会满足）
const scrollToBottom = () => { chatDetail.scrollTop = chatDetail.scrollHeight - chatDetail.clientHeight; };
// 节流是 120ms：真实用户滚动间隔必然大于它，测试要模拟这个间隔，
// 否则连续调用会被节流挡掉（那是正确行为，不是 bug）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n=== ② 加载更多时滚动位置保持 ===');
// 首屏 500 条
check('首屏显示 500 条', (tbody.innerHTML.match(/<tr/g) || []).length === 500,
  String((tbody.innerHTML.match(/<tr/g) || []).length));

// 模拟用户滚到底部（内容 500 条 → 给一个合理的高度）
chatDetail.scrollHeight = 8000;
scrollToBottom();
const beforeTop = chatDetail.scrollTop;
const beforeHeight = chatDetail.scrollHeight;

// 触发滚动（模拟加载更多）
const scrollFns = listeners.get(chatDetail).scroll;
const tbodyHtmlBefore = tbody.innerHTML;
scrollFns[0]();
await sleep(150);

// 加载后：内容变多（高度增加）
chatDetail.scrollHeight = beforeHeight + 3000;   // 新增 200 条 → 高度增加

// 关键断言：scrollTop 没被重置为 0（原 bug 就是这里被重置）
check('加载后 scrollTop 未被重置为 0', chatDetail.scrollTop !== 0,
  `scrollTop=${chatDetail.scrollTop}（原 bug 会变成 0）`);
check('加载后显示了 700 条', (tbody.innerHTML.match(/<tr/g) || []).length === 700,
  String((tbody.innerHTML.match(/<tr/g) || []).length));
// 追加式渲染：已有 500 行的 HTML 必须原样保留（前缀不变），只往下接新行。
// 全量重建时浏览器会重排已有行 —— 那就是"临界线滚动迟钝"的根源之一。
check('加载更多是追加（已有行未重建）', tbody.innerHTML.startsWith(tbodyHtmlBefore),
  '已有行的 HTML 被重写了（说明还在全量重建）');

// 再加载一次（先滚到新的底部）
scrollToBottom();
const topBefore2 = chatDetail.scrollTop;
scrollFns[0]();
await sleep(150);
check('连续加载仍不重置（可继续滚）', chatDetail.scrollTop >= topBefore2,
  `${topBefore2} -> ${chatDetail.scrollTop}`);
check('第二次加载后 900 条', (tbody.innerHTML.match(/<tr/g) || []).length === 900,
  String((tbody.innerHTML.match(/<tr/g) || []).length));

console.log('\n=== ③ 外层结构不重建（工具栏事件不重复绑）===');
const htmlAfterFirst = chatDetail.innerHTML;
chatDetail.scrollTop = 3000;
scrollFns[0]();
check('加载更多时 detail.innerHTML 未被整体重写',
  chatDetail.scrollTop !== 0 && chatDetail.innerHTML === htmlAfterFirst,
  'innerHTML 被重写了（说明还在全量重建）');

// 工具栏按钮只绑一次
const wakeBtn = document.getElementById('chat-wake-btn');
const wakeCount = (listeners.get(wakeBtn)?.click || []).length;
check('唤醒按钮只绑 1 次点击', wakeCount <= 1, `实际 ${wakeCount}`);

console.log('\n=== ④ 到底部后不再增长 ===');
// 一直加载到底（每次先滚到底）
for (let i = 0; i < 10; i++) { scrollToBottom(); scrollFns[0](); await sleep(150); }
const finalRows = (tbody.innerHTML.match(/<tr/g) || []).length;
check('全部加载完 = 1200 条', finalRows === 1200, String(finalRows));
check('到底后底部文案为"已显示全部"', /已显示全部/.test(String(document.getElementById('chat-msg-more').textContent)),
  String(document.getElementById('chat-msg-more').textContent));


// ── ⑤ 轮询刷新不能把用户滚出来的内容冲掉 ──
// 这是最容易复现的 bug：轮询每 15 秒调 loadChats → loadChatMessages，
// 如果那时重置了分页，用户滚出来的几百条会瞬间缩回第一页、位置也回顶部。
console.log('\n=== ⑤ 轮询刷新保持已加载内容与位置 ===');
{
  // 重新加载一次干净的视图
  vm.runInContext('state.chatMsgLimit = CHAT_MSG_PAGE;', ctx);
  renderChat();
  chatDetail.scrollHeight = 8000;
  const scrollFns = listeners.get(chatDetail).scroll;

  // 滚两次，加载出 900 条
  scrollToBottom(); scrollFns[0]();
  await sleep(150);
  scrollToBottom(); scrollFns[0]();
  await sleep(150);
  const rowsBefore = (tbody.innerHTML.match(/<tr/g) || []).length;
  chatDetail.scrollTop = 4200;                  // 用户滚到中间
  const topBefore = chatDetail.scrollTop;

  // 模拟轮询：把 loadChatMessages 拦截成"数据没变"，再真跑一次 keepView 路径
  vm.runInContext(`
    globalThis.__origApi = api;
    api = async (u) => {
      if (String(u).includes('/messages')) return { messages: state.chatMessages };
      return { chats: state.chats };
    };
  `, ctx);
  await (ctx.loadChatMessages || sandbox.loadChatMessages)(state_currentChatKey, { keepView: true });
  vm.runInContext('api = globalThis.__origApi;', ctx);

  const rowsAfter = (tbody.innerHTML.match(/<tr/g) || []).length;
  check('轮询后已加载条数不变（900）', rowsAfter === rowsBefore && rowsBefore === 900,
    `${rowsBefore} -> ${rowsAfter}`);
  check('轮询后滚动位置不变', chatDetail.scrollTop === topBefore,
    `${topBefore} -> ${chatDetail.scrollTop}`);
  check('轮询后没有回到第一页（不是 500）', rowsAfter !== CHAT_MSG_PAGE_GUESS,
    `实际 ${rowsAfter}`);
}


// ── ⑥ 快速滚到底：最后一个事件被节流也必须补触发（尾随调用）──
// 曾经的节流没有尾随：快速滚动时"到底"那一下总被 120ms 窗口吞掉，
// 用户停手后没有新事件 → 加载永远不触发（"滚得快会滚不下去"）。
console.log('\n=== ⑥ 快速滚到底：被节流的尾部事件必须补触发 ===');
{
  const fns = listeners.get(chatDetail).scroll;
  await sleep(150);                              // 先让节流窗口过去
  const rowsBefore = (tbody.innerHTML.match(/<tr/g) || []).length;   // 900（⑤ 之后）
  chatDetail.scrollHeight = 20000;

  // 第一次事件：不在底部 → 立即处理但不加载，同时刷新节流时间戳
  chatDetail.scrollTop = 1000;
  fns[0]();
  // 第二次事件（间隔远小于 120ms）：已经到底 → 被节流挡掉，但必须留下尾随调用
  scrollToBottom();
  fns[0]();
  const rowsImmediate = (tbody.innerHTML.match(/<tr/g) || []).length;
  check('被节流的瞬间不加载（节流本身正常）', rowsImmediate === rowsBefore,
    `${rowsBefore} -> ${rowsImmediate}`);

  await sleep(200);                              // 等尾随调用执行
  const rowsAfter = (tbody.innerHTML.match(/<tr/g) || []).length;
  check('尾随调用补上了加载（900 → 1100）', rowsAfter === rowsBefore + 200,
    `${rowsBefore} -> ${rowsAfter}（没补上就是"滚得快滚不下去"那个 bug）`);
}

console.log('\n' + (fail ? 'FAILED ' + fail : 'ALL PASSED ' + pass));
process.exit(fail ? 1 : 0);
