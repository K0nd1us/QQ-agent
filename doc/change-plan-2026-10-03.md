# 改动方案 v2（待评审）

日期：2026-10-03 ｜ 本版范围：**问题①（缓存，走 B）** + **问题②（思考落盘 / 沉默为界）**
说明：原 v1 的第二个改动项（问题③ 连贯性）**本次不纳入**，方案原文保留在文末附录，随时可启用。
依据：`doc/issue-analysis-2026-10-03.md`、`doc/fix-plan-2026-10-03.md`

---

## 一、问题① 走 B：把"会变的段"挪到【已读信息】之后

### 设计原则

前缀缓存只要遇到**第一个不同的字节**，其后全部失效。所以：

> **凡是"会自己变"的段，一律排到【已读信息】之后。**
> 稳定前缀 = 系统提示 +【角色设定】+【引导说明】+【已读信息】（后者由锚点保证字节不变）。

### 新段落顺序

```
【角色设定】→【引导说明】→【已读信息】→【新已读信息】→【记忆】→【未读信息】→【可用表情包】→【当前时间】
```

**引导说明新增两行**（本次你提的两处调整，合并在同一次改动里）：
- 「对群友的印象见下方【记忆】段；本会话可用的表情包列表见下方【可用表情包】段。」

### 改动点

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `src/prompt.js` `buildUserPrompt` `787-889` | 按新顺序重排 `parts`；`引导说明` 段加上述两行 |
| 2 | `src/prompt.js` `811-825`、`859-866` | 记忆渲染去两套口径（anchored / 标准）→ 统一"本轮窗口成员"；**删除【新加入成员】段** |
| 3 | `src/prompt.js` `resolvePromptAnchor` `628-691` | 删 `memberIds` / `newUserIds` / `hasNewMember → reset`（`655-658`）；`anchor` 收敛为 `{readIds, readCount}`；保留 readIds 对齐 + `maxExtraRead` 预算 + 锚点头滚出池 → reset |
| 4 | `src/prompt.js` `740-753` / `812-821` | 删 `newUsers` 预计算；`relevantUserIds` 两分支合并 |
| 5 | `src/config.js:277` | `promptAnchor.maxExtraRead` 默认 `5 → 15` |
| 6 | 注释同步 | `prompt.js:776-886` 排序说明、`prompt-anchor-test.mjs` 顶部说明 |

### 需要同步的测试

- `test/prompt-anchor-test.mjs`
  - `prefixOf()`（`74-82`）：前缀起点从【记忆】改为【已读信息】。
  - **场景 F（`150-163`）断言反转**：新群友不再导致 reset（应仍为 `anchored`）。
  - 删 `memberIds` 断言（`97`、`160`）；场景 H（`190`）里 `【新加入成员】以下是` 已不存在。
- `test/test-prompt.mjs:119-122`：段落顺序断言改成新顺序。
- `test/wake-semantics-test.mjs`：切片用 `indexOf` 定位，顺序变化后仍成立，只需更新 `129` 行注释。

### 验收（核心回归）

连续两轮构建 `buildUserPrompt`，中间**写一条新记忆 + 发一次表情**，断言「系统 + 角色设定 + 引导说明 + 已读信息」前缀**逐字节一致**。
→ 这条在**当前代码上必然失败**（就是问题复现），修好后应通过。

### 附带发现（建议顺带修，独立小改）

`orchestrator.js:1028` 把 `raw: response.raw` 放进了 `assistantEntry`，而该条目被 push 进**真正发给 API 的 `messages`**（`1030`）。多轮工具调用时，每一轮请求都会把**之前所有轮次的完整原始响应**再发一遍 —— 请求体显著膨胀。
修法：发给 API 的 `messages` 里剥掉 `raw`（`session.messages` 保留，UI 照旧）。与缓存无关，但直接省钱。

---

## 二、问题②：沉默为界 —— 思考链落盘

### 目标

让"机器人自己的思考/私有状态"能跨轮存活，且**不靠"重新注入大段 CoT"来换**：
- 活跃对话内：**思考天然留在上下文里**（不重开 session），成本靠前缀缓存压住；
- 沉默之后：缓存反正已失效 → 把整段 CoT 蒸馏成一小段私有状态再开新会话。

### 核心机制

```
群里消息间隔 < T（沉默阈值）  →  继续同一会话：在已存 messages 上「追加」
沉默 ≥ T  / 超轮次上限        →  关闭会话 → 蒸馏私有状态 → 下次触发带蒸馏开新会话
```

**为什么省**：沉默后前缀缓存 TTL 已过，这一发本就全价 —— 用一小段蒸馏结果替掉"80 条已读信息 + 整段 CoT 重放"，是"全价得少一点"。沉默后的**第二发**起，新会话又是纯追加 → 缓存重新命中。

**沉默阈值 T 的口径**：对齐各家的**缓存 TTL**（扣掉一轮生成耗时 + 留余量）。超过 TTL 时，"继续扛长上下文"严格劣于"关会话 + 蒸馏 + 重开"。详见下方《沉默阈值怎么定》。

### 沉默阈值怎么定（各家缓存 TTL 实测口径，2026-10 查证）

| 渠道 | 缓存模式 | 官方 TTL |
|---|---|---|
| Anthropic (Claude) | 显式 `cache_control` | **5 分钟**（每次命中刷新）；可选 1 小时（写入加价） |
| OpenAI (GPT-5.x) | 隐式自动 | **~5–10 分钟**（GPT-5.6+ 最低 30 分钟） |
| Qwen / 百炼 | 隐式（默认，TTL 不确定）｜显式 | 显式 **5 分钟**（命中重置）；隐式"定期清理" |
| DeepSeek | 隐式硬盘缓存 | **不承诺固定 TTL**：官方"数小时到数天"；第三方实测报 ~10 分钟 |
| Gemini | 隐式（RAM）｜显式 | 隐式 24 小时（不保证命中）｜显式可自设 |
| GLM / 智谱 | 隐式缓存 | 未公开明确 TTL |

三条容易踩的细节：
1. **TTL 从"发起请求"起算，生成耗时也计入**（Anthropic 官方明说）。所以实际可用间隔 ≈ `TTL − 上一轮耗时`。
2. **每次命中都会刷新 TTL** —— 活跃对话期间缓存一直热；TTL 只在"静默间隔"时才咬人。
3. **缓存按 API Key + 模型隔离** → 走 `fallbackModels` 降级换模型时，缓存必然失效（延续的收益在该轮归零）。

**结论**：
- **默认 `silenceMinutes: 5` 是上限**，10 分钟对 Anthropic/Qwen 用户已经**太长**（第 10 分钟续上时缓存早失效，白扛一整段长上下文，严格更差）。
- 但 DeepSeek 官方口径是"数小时到数天"，对 DeepSeek 用户 5 分钟又**过于保守**（过早切断、频繁蒸馏）。
- → **改成按渠道自动取值**（复用现成的 `detectDialect()`，`thinking.js:92` 已导出、零依赖），手动值可覆盖：

```
anthropic      → 4 分钟   （5 分钟 TTL 扣掉生成耗时 + 余量）
qwen/dashscope → 5 分钟
openai-o       → 8 分钟
deepseek       → 60 分钟
gemini         → 60 分钟
其它 / generic → 5 分钟   （保守兜底）
```

- `continuation.silenceMinutes: 0` = **不按沉默切分**（只靠 `maxTurns` / `maxChars` 兜底）——给"我就想连续到底"的用户。
- **可自证**：`usage.cachedTokens` 已在记（`llm.js:603-617`）。若续上的那一发 `cachedTokens ≈ 0`，说明阈值对该渠道太长 → 用量页可直接观察、回调研判。


### 新模块：`src/conversation.js`（ConversationBuffer）

按 `chatKey` 维护"会话缓冲"，**落盘**（不能只放内存 —— 参考 `activeTopics` 重启即丢的坑）：

```
data/conversations/<chatKeySafe>.json
{
  chatKey, systemPrompt, toolNames: [...], messages: [...],
  startedAt, lastTurnAt, lastActivityAt, turns, chars,
  lastDistilledAt
}
```

- `messages`：**剥掉 `raw`** 的 OpenAI 序列（system 除外，单独存 `systemPrompt`）
- `systemPrompt` / `toolNames`：用于判定"前缀是否还稳定"

### 每次运行前的决策（`wake` 入口）

```
buffer 存在
  && continuation.enabled
  && now - buffer.lastActivityAt < silenceMs
  && 本次 systemPrompt 与 buffer.systemPrompt 逐字节相同
  && 本次工具集与 buffer.toolNames 相同
  && buffer.turns < maxTurns && buffer.chars < maxChars
→ mode = continue
否则 → mode = fresh（若存在旧 buffer，先走 close 流程）
```

### 两种模式的构造（`#runAgent`）

**fresh（现状 + 一点）**
- 照旧构造 system + user prompt（用 ① 的新段落顺序）
- **额外注入**【上一段对话的私有状态】（若该会话有蒸馏结果）
- 跑完后：把 system / messages / toolNames **存入 buffer**（不再丢弃）

**continue**
- system 用 buffer 里保存的**原字符串**（逐字节复用）
- `messages` 前缀 = `buffer.messages`（逐字节复用）
- **只追加一条新的 user 消息**：内容是**增量** —— 上次之后的新消息 + 【记忆】+【可用表情包】+【当前时间】（都在尾部，属"新增字节"，不影响已缓存前缀）
- **不再注入【已读信息】整窗**（否则双重计费）
- 跑完后：把本轮新增的 assistant/tool 条目**追加**进 buffer

### 关闭与蒸馏（`closeBuffer(chatKey, reason)`）

触发时机：下次 `wake` 决策时懒关闭（+ 可选定时清扫）。
流程：
1. 取 buffer 里 assistant 的**思考/正文文本**（截断到预算内）
2. 调**一次**小模型调用（走 `chatCompletionWithRetry`，小 `max_tokens`）：
   「从这段内部推理中提炼**需要跨会话记住的私有状态**：未完成的目标、自己定下的规则、答案、待办。没有就回空。」
3. 结果写入**自身记忆**（见下）
4. buffer 归档（可保留最近 N 个供 UI 回溯），清空

### 自身记忆出口（蒸馏的落点）

现状没有任何"机器人自己的记忆"位置（`memory.js:222-229` 只认 `memberImpression`；旧 `pendingThought` 被显式删除于 `memory.js:124`）。需要补：

- `memory.js`：新增 category `selfNote`，落 `<chatDir>/_self.json`（`[{content, createdAt}]`）
- `memory.js`：新增 `formatSelfForPrompt(chatKey)` → 渲染成【自身状态】段
- `tools.js`：新增 `remember_self` 工具（描述：记录需要跨会话记住的自己的状态/待办）
- `prompt.js`：在**易变区**注入【自身状态】段（与【记忆】同区，别放稳定前缀）

### 前缀稳定的四个保障（这是 continue 能不能省钱的关键）

1. **systemPrompt 逐字节复用**：存字符串、重发同一份；配置/人设/技能一变 → 判定 fresh。
2. **工具集复用**：`toolNames` 不一致 → 判定 fresh（工具定义在请求体里排在 messages 之前，一变全废）。
3. **append-only**：永远只在数组尾部追加，绝不改写历史字节。
4. **剥 `raw`**：见 §一 附带发现（否则历史条目字节不稳、体积膨胀）。

### 媒体瘦身

continue 时把 buffer 里历史的 `image_url` 部分替换为文字占位（如 `[已看过这张图：<摘要>]`）——否则图片 token 每轮重发，缓存收益差。

### 硬上限与兜底（防"连聊三小时"）

`maxTurns`（默认 30）、`maxChars`（默认 ~240k 字符，约 60k token）→ 超限走 `closeBuffer` 的同一流程（软重置）。
沉默阈值管的是"外部静默"，管不了"连续不断的长会话"，这两个上限是必需的第二道闸。

### 配置项

在 `src/config.js` DEFAULT_CONFIG 注册：
```
store.continuation = {
  enabled: true,
  silenceMinutes: null,     // null = 按渠道自动取值（见上表）；数字 = 强制；0 = 不按沉默切分
  maxTurns: 30,
  maxChars: 240000,
  distillOnClose: true
}
```

### 分期（强烈建议按此推进，别一次做完）

- **P1（核心，可独立验收）**：Buffer 落盘 + continue/fresh 决策 + 只追加增量。
  → 直接解决"思考链能跨轮"这个主诉求。
- **P2**：`closeBuffer` + 蒸馏 + 自身记忆出口（`selfNote` + `remember_self` + 注入段）。
  → 解决"跨沉默"。
- **P3**：媒体瘦身、buffer 归档回溯、UI 展示（会话页"延续中"标记）。

### 测试

- **新增 `test/conversation-continuation-test.mjs`**
  - 连续两次触发：断言第二次请求的 `messages` **前缀 == 上一次的 messages（逐字节）**，且只多出增量。
  - 沉默超阈值后再触发：断言新会话 `messages` 只有 `system + 1 条 user`（回到 fresh）。
  - 上限触发：轮次/字符超限 → 走软重置。
  - 蒸馏：`closeBuffer` 后自身记忆里出现条目，且下次 fresh 注入【自身状态】段。
- **`test/wake-semantics-test.mjs` 必改**：场景 D/E 的 drain 语义从"新开会话"变成"续用同一 buffer"，断言要跟着改。
- **`coverage-e2e.mjs` / `usage-e2e.mjs` / `selftest.mjs`**：凡断言"每次触发 = 独立 messages"的用例都要重判。

### 风险与要改的文档

- **架构承诺变更**：从「无状态、单次成本恒定」变为「有界增长、单价靠缓存压住」→ **README「技术架构」第 2~4 条要改写**。
- 缓存不生效时成本上升 → `maxChars` 是兜底闸；用量页能观察到。
- 长会话"自我锚定"（被自己早期推理带偏）→ 沉默边界 + 轮次上限缓解。
- 同一 `chatKey` 的并发：现有 `runningChats` 已保证单会话串行，continue 天然安全。

---

## 三、实施顺序

1. **① + 附带修 `raw`**（含两个测试文件同步）→ `npm run test:prompt` 全绿
2. **② P1**（buffer + continue/fresh）→ 新增 continuation 测试 + 修 wake-semantics
3. **② P2**（蒸馏 + 自身记忆）
4. **② P3**（瘦身 / UI）
5. 每阶段 `npm test`；收尾 `npm run test:coverage`
6. 更新 `doc/issue-analysis-2026-10-03.md` 结论状态 + README 架构段

---

## 四、确认状态

| 项 | 结论 |
|---|---|
| 1. ① 新段落顺序 | ✅ 已确认 |
| 2. ② 分期推进 P1 → P2 → P3 | ✅ 已确认 |
| 3. `silenceMinutes` 默认值 | ✅ 已定：**按渠道自动取值**（默认 5 分钟兜底，`null` 表示自动；`0` = 不切分）。理由见 §二《沉默阈值怎么定》 |
| 4. 附带修（剥 `raw`） | ✅ 一起做 |

**下一步**：从 **① + 剥 `raw`** 开工。

---

## 附录：问题③（连贯性）暂缓方案 —— 原样保留，随时启用

> 本次不纳入。以下为 v1 定稿内容，未做改动，直接可用。

**设计原则**：把"内容相关度"从 0 权重里拿回来 —— 能判断"这是在跟我说话"的信号，一律升格为触发；只有真无从判断时才交骰子。

- **B1 结构化捕获"回复我"**：`src/app.js:842-851` 包一层 `resolveReply`，闭包记录被引用者 QQ 与 `selfId` 比对 → entry 新增 `replyToSelf`（`store.js:83-110`）。`resolveReply` 已能拿到被引用者 `senderId`（`app.js:806-822`），只是没落成字段。
- **B2 "回复我" = 触发**：`src/prompt.js:446-512` 新增 `replyToMe`，与 `atMe` 同级 → `tier 1` 必响应；新增开关 `store.replyTriggers`（默认 true）。⚠️ 1 档语义会变，设置页文案需同步。
- **B3 连贯窗口**：`orchestrator.js` 新增 `lastSelfSpeakAt`（会话结束时 `session.sent.length > 0` → 记录）；`onIncoming` 里 `now - lastSelfSpeakAt < windowMs && entry.ts > lastSelfSpeakAt` → 视作触发。新增 `store.continuityWindowMs`（默认 90000）。护栏：每个机器人发言只允许一次连贯触发，防 ping-pong。
- **B4 三档概率偏置**：`prompt.js:482-508` 改为 `effectivePercent = 偏置 ? max(randomPercent, 60) : randomPercent`；**不动 `roll` 语义**。
- **B5（不做）**：未触发不立即判死 —— 与"一次定生死"正面冲突，改动面大。

**测试影响**：`test/wake-semantics-test.mjs` 的 mock 默认不发消息（`_harness.mjs:274`），不受影响；但 `coverage-e2e.mjs` / `usage-daily-test.mjs` / `selftest.mjs` 里有脚本发 `send_message` 的用例需逐个校准。
