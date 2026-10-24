// reply-safety —— 回复安全网：把「写在正文里、却没通过工具发出去」的成稿抢救成一条 send_message。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// 核心的硬规则是：assistant 的正文（content）只是思考，**永远不会发到 QQ**；
// 要发言必须调用 send_message。这个规则能挡住内心戏，但也带来一个副作用：
// 不严格遵守工具协议的模型有时会把完整的回复写进正文，然后结束这一轮。
// 群友什么都收不到，用户看到的就是「它思考完就不回复了」。
//
// 核心已经留好了三条能力接口（src/reply-rescue.js）：
//   ① reply.is-planning-text  —— 先否决计划腔/候选稿
//   ② reply.loose-send        —— 从正文里抽出成品话
//   ③ reply.grounded-select   —— 只允许抽出的句子确实出自本轮草稿、且没发过
// 本插件只实现这三条，不碰提示词、不碰发送链路、不额外调用模型。
//
// ── 安全边界（比「多回一句」重要）─────────────────────────────────────────
//   · 只搬原句：不生成、不改写、不补全
//   · 拿不准一律沉默：宁可这轮不发，也不能把内心戏发进群
//   · 不自己发送：只返回文本，由核心合成 send_message 走统一发送链路
//     （限频/去重/分条/CQ 转义/存档/守卫一个都不会被绕开）
//   · 默认可用，但可以在设置页关掉；关掉后行为与没装插件完全一致

/** 计划腔行首标签：这些行整行丢弃（注意：`回复：` 不在此列，它只是标签，后面的话要留）。 */
const META_LABEL = /^(?:分析|思路|思考|计划|方案|候选|备选|草稿|策略|判断|结论|备注|内心|心理|打算|想法|理由|说明|语气|口吻|措辞|风格|回法|回复策略|话术|做法|选择|选项|规划)\s*[:：]\s*/;

/** 正文标签：`回复：xxx` 里的 `回复：` 是壳，剥掉后 xxx 仍可能是成品话。 */
const REPLY_LABEL = /^(?:最终回复|回复|回答|答案|回法|要说的话|要发的话|要发的内容|发送内容|输出内容|输出|正文|内容|消息)\s*[:：]\s*/;

/** Markdown 列表/引用符号。 */
const BULLET = /^(?:[-*•·>]+|\d+[.)、])\s+/;

/** 纯舞台说明：`（沉默）`、`[不回复]`、`(笑)`。 */
const STAGE = /^[（(\[【][^）)\]】]{0,40}[）)\]】]$/;

/** 原生/文本工具调用痕迹：出现就整段放弃，交给核心的解析器处理。 */
const TOOL_MARKUP = /<\/?(?:tool_call|function|parameter)\b|"tool_calls"\s*:/i;

/**
 * 行内计划腔。只收「明显是在对自己说话」的句式；
 * 不用宽泛的「我」「他」—— 成品回复里也可能出现。
 */
const META_INLINE = [
  /(?:他|她|对方|群友|用户|主人)(?:刚才|刚刚|现在|在)?(?:问|说|发|讲|提|想|要|让|嫌|觉得)/,
  /(?:这条|那条|本条|这轮|本次|这次)(?:消息|信息|对话|内容)?(?:不|无需|不用|没必要)/,
  /^(?:我|咱)(?:先|得|要|去|来)?(?:看看|查查|查一下|搜一下|搜搜|翻翻|确认一下|了解一下|分析一下|想一下|考虑一下)/,
  /^(?:让我|我先)(?:看看|查查|想|确认)/,
  /(?:调用|使用|执行|触发)(?:工具|send_message|get_[a-z_]+|web_[a-z_]+|finish)/i,
  /(?:应该|可以|不如|或许|也许|要不)(?:回|说|答|发)/,
  /(?:回复|回答|说法|话术)(?:候选|选项|备选|方案)/,
  /(?:候选|备选|选项)\s*[\d一二三四五]?\s*[:：]/,
  /^(?:可以回|回一句|回复一句|说一句)/,
  /(?:语气|口吻|措辞|风格)(?:要|得|应该|可以)/,
  /^(?:i should|i'll|i will|let me|the user|we need|so the|maybe i|analysis|reasoning|thinking|draft|reply options?)\b/i
];

/** 明确的「这轮不说话」决定。 */
const SILENT_DECISION = /(?:^|\n)\s*(?:算了|不回了|不说了|不发言|保持沉默|安静(?:地)?(?:结束|待着)|这轮(?:就)?不(?:说|回|发)|我(?:先)?不(?:说|回)了)/;

/** 候选/择一：模型在正文里比较几种说法，整段都不能发。 */
const CANDIDATE = /(?:^|\n)\s*(?:候选|备选|选项)\s*[:：]|(?:候选|备选)(?:回复|说法|话术|选项|方案|答案)|(?:二选一|选哪(?:个|句)|回哪(?:个|句))/;

/** 外层引号（整段被引号包住时剥掉，避免发出去带一对「」）。 */
const QUOTE_PAIRS = [
  ['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'], ['‘', '’'], ["'", "'"]
];

let cfg = () => ({});
let log = () => {};
/** 本次运行里模型写过的正文草稿（reply.grounded-select 的溯源依据）。 */
let drafts = [];

function config() {
  try { return cfg() || {}; } catch { return {}; }
}

function isEnabled() {
  return config().enabled !== false;
}

function isDryRun() {
  return config().dryRun === true;
}

function maxChars() {
  const n = Number(config().maxChars);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

/** 归一化：去空白、标点、引号，用于「这句确实出自草稿」的比对。 */
function squash(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000\u200b-\u200d\ufeff]+/g, '')
    .replace(/[，。！？!?,.;；:：、~～"'“”‘’（）()\[\]【】《》…—\-_/\\|]/g, '');
}

/** 去掉 `回复：` 这类壳；不是壳就原样返回。 */
function stripReplyLabel(line) {
  let s = String(line ?? '').trim();
  s = s.replace(BULLET, '').trim();
  if (REPLY_LABEL.test(s)) s = s.replace(REPLY_LABEL, '').trim();
  return s;
}

/** 这一行是不是「在对自己说话」。 */
function isMetaLine(line) {
  const s = String(line ?? '').trim();
  if (!s) return true;
  if (META_LABEL.test(s)) return true;
  if (STAGE.test(s)) return true;
  if (TOOL_MARKUP.test(s)) return true;
  if (META_INLINE.some((re) => re.test(s))) return true;
  return false;
}

/** 整段被一对引号包住时剥掉；不是就原样返回。 */
function stripOuterQuotes(text) {
  const t = String(text ?? '').trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (t.length > open.length + close.length
      && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, t.length - close.length).trim();
      if (inner) return inner;
    }
  }
  return t;
}

/**
 * 这段正文是否属于「计划腔/候选稿/决定不说话」——是就整段放弃。
 * 注意：只要还有一行像成品话，就不能整段否决；逐行筛由 extractMessages 做。
 */
export function isPlanningText(text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!t) return true;
  if (TOOL_MARKUP.test(t)) return true;
  if (SILENT_DECISION.test(t)) return true;
  if (/(?:不需要|无需)(?:回复|回应|发言|理)/.test(t)) return true;
  if (CANDIDATE.test(t)) return true;
  const lines = t.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return true;
  // 所有行都在对自己说话 → 整段是思考
  const meta = lines.filter((line) => {
    if (META_LABEL.test(line)) return true;
    const s = stripReplyLabel(line);
    return !s || isMetaLine(s);
  }).length;
  return meta === lines.length;
}

/**
 * 从正文里抽出可以直接发的原句。
 * 返回数组最多一条：整段作为一个消息发送，保留原有换行，不拆句、不改写。
 */
export function extractMessages(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];
  if (TOOL_MARKUP.test(raw)) return [];

  const kept = [];
  for (const rawLine of raw.split('\n')) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^```/.test(line)) continue;            // 代码围栏标记
    if (/^#{1,6}\s+/.test(line)) continue;       // Markdown 标题
    if (STAGE.test(line)) continue;
    if (META_LABEL.test(line)) continue;
    line = stripReplyLabel(line);
    if (!line) continue;
    if (isMetaLine(line)) continue;
    kept.push(line);
  }
  if (!kept.length) return [];

  const body = stripOuterQuotes(kept.join('\n').trim());
  if (!body) return [];
  if (body.length > maxChars()) return [];
  // 抽完再整体复核一次：剩下的内容仍像计划腔，就不发
  if (isPlanningText(body)) return [];
  return [body];
}

/**
 * 只保留「确实出自本轮草稿、且没发过」的句子。
 * 这是最后一道闸：就算上层抽错了，没有出处的句子也过不去。
 */
export function pickGrounded(proposed, sent) {
  const draftNorms = drafts.map(squash).filter(Boolean);
  if (!draftNorms.length) return [];
  const sentNorms = (Array.isArray(sent) ? sent : [])
    .filter((item) => item?.type === 'text')
    .map((item) => squash(item.text))
    .filter(Boolean);

  const picked = [];
  for (const item of Array.isArray(proposed) ? proposed : []) {
    const norm = squash(item);
    if (!norm) continue;
    // proposed 必须能在本轮草稿里找到原文（不反向包含，避免短草稿匹配长句）
    if (!draftNorms.some((draft) => draft.includes(norm))) continue;
    // 已经发过（或高度重合）就不再发
    if (sentNorms.some((prev) => prev === norm || prev.includes(norm) || norm.includes(prev))) continue;
    if (picked.some((already) => squash(already) === norm)) continue;
    picked.push(String(item));
  }
  return picked;
}

export function setup(api = {}) {
  if (typeof api.config === 'function') cfg = api.config;
  if (typeof api.log === 'function') log = api.log;
  else if (typeof api.warn === 'function') log = api.warn;
}

export function dispose() {
  drafts = [];
}

export const providers = {
  // ① 计划腔否决
  'reply.is-planning-text': ({ text } = {}) => {
    if (!isEnabled()) return { planning: false };
    return { planning: isPlanningText(text) };
  },

  // ② 从正文抽成品话（不花模型调用）
  'reply.loose-send': ({ text } = {}) => {
    if (!isEnabled()) return { messages: [] };
    const messages = extractMessages(text);
    if (!messages.length) return { messages: [] };
    if (isDryRun()) {
      log(`[reply-safety] 试运行：本来会抢救 ${messages.length} 条 ${messages[0].length} 字：${messages[0].slice(0, 60)}`);
      return { messages: [] };
    }
    log(`[reply-safety] 从正文抢救 ${messages.length} 条 ${messages[0].length} 字：${messages[0].slice(0, 60)}`);
    return { messages };
  },

  // ③ 草稿溯源：remember / reset / proposed+sent
  'reply.grounded-select': (input = {}) => {
    // 关掉时返回空挑选（而不是 enabled:false）——后者会让核心放行未经溯源的候选。
    if (!isEnabled()) return { enabled: true, picked: [] };
    if (input?.reset) {
      drafts = [];
      return { enabled: true, picked: [] };
    }
    if (typeof input?.remember === 'string' && input.remember.trim()) {
      drafts.push(input.remember);
      if (drafts.length > 8) drafts = drafts.slice(-8);
      return { enabled: true, picked: [] };
    }
    const picked = pickGrounded(input?.proposed, input?.sent);
    return { enabled: true, picked };
  }
};
