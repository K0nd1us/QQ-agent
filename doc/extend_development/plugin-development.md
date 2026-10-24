# 确定性型插件开发（`plugins/`）

> 本文管**一类**扩展：提供能力（`providers`）或钩子（`hooks`），
> **满足条件就一定执行，不经过 LLM** —— 模型想忽略也忽略不掉。
> 另一类是 **LLM 型**（`skills/`，注册工具、由模型决定何时用），见
> [skill-development.md](./skill-development.md)。
> 两者的共同机制（清单字段、生命周期、能力系统、热重载、上架）见
> [skill-reference.md](./skill-reference.md)。

---

## 📎 把本文档交给 AI 生成插件时，需要一并提供的文档

本文是**主文档**，写明了确定性型插件的全部机制、能力契约表与硬约束，但**有意不重复**以下内容 ——
它们在各自的专门文档里，按需附加（全部在同一目录 `doc/extend_development/`）：

| 需要实现什么 | 必须附加 | 里面有什么 |
|---|---|---|
| **任何功能**（建议总是附加） | [skill-reference.md](./skill-reference.md) | 共同机制完整参考：api 对象全表、ctx 全量字段、能力/钩子的完整语义、硬约束清单（§14）、完整示例（§16）。**§4 的能力契约表在本文是权威版，但其余细节以它为准** |
| 调用 QQ 接口（查群成员、禁言、踢人、撤回、发说说、群文件、群相册……） | [snowluma-capabilities.md](./snowluma-capabilities.md) | 协议端全部 **73 个 OneBot 接口的逐条参数表与返回示例**。本文 §8.2 只讲了调用姿势，**不含参数表** |
| 插件要消费/包装视频理解 | [video-modes.md](./video-modes.md) | 视频理解两条路（原生直读 / ffmpeg 抽帧）的分工、配置项与边界 —— 提供 `video.frames` 类能力前先读 |
| 想让 AI 理解整个系统的设计（可选） | [skill-system.md](./skill-system.md) | 架构总览：状态模型、能力系统、判定链 |

**给小白的操作指引**：你只需要对 AI 说"按 plugin-development.md 的规范生成一个 XXX 插件"，
并**把上表中你用得到的文档内容一起粘贴/上传给 AI**（至少附加 skill-reference.md；
插件涉及操作 QQ 就再加 snowluma-capabilities.md）。AI 输出的会是
`plugins/<id>/plugin.json` + `plugins/<id>/index.js` 两个文件的完整内容，
你把它们保存到项目 `plugins/<id>/` 目录下即自动生效（热重载默认开启）。

⚠️ **一个提前判断**：如果你要的功能是"机器人看到某种话/某个请求时**回应**"（比如
"用户说要图就发图"），那不是插件，是 **LLM 型技能** —— 请改用
[skill-development.md](./skill-development.md)（其文首有同样的附加文档说明）。

**多轮迭代**：如果 AI 生成的插件加载失败或行为不对，把控制台「插件」页显示的
错误原因（或加载日志里的 ❌ 行）原样发给 AI 让它修正 —— 本文 §11 的常见失败对照表
就是给 AI 排错用的。

---

## 0. 一句话判断该不该做确定性型

### 定义

- **插件（确定性型，`plugins/`）**：触发条件能**写成代码里死的规则**的扩展。
  它提供能力（`providers`）或钩子（`hooks`），由**核心程序**在条件命中时**必然**调用——
  不经过 LLM，模型想忽略也忽略不掉。它像电路里的继电器：接对了就一定通电。
- **技能（LLM 型，`skills/`）**：触发条件要**靠模型读懂自然语言**的扩展。
  它注册工具（`registerTool`）进模型的 function 列表，**用不用、什么时候用由模型自己判断**。
  它像一位知道自己什么时候该开口的助手——你只能说服它，不能命令它。

一句话：**规则能写死 → 插件；要理解人话 → 技能。**

### 判断方法（按顺序问三个问题）

**第一问：触发时机能用 if 描述吗？**

```js
if (消息里有 B站链接) …            // ✅ 能 → 插件
if (用户 @机器人 && 提到"天气") …   // ⚠️ 半能 → 技能（@是死条件，"提到天气"要理解语义）
if (收到一条语音) …                // ✅ 能 → 插件
```

**第二问：漏触发一次的代价是什么？**

- 漏一次就丢数据/坏事（语音没转文字、禁言状态没记住）→ **插件**
- 漏一次只是少个花活（这次没接梗）→ **技能**

**第三问：参数从哪来？**

- 参数是系统给的（消息对象、链接、文件路径）→ **插件**
- 参数要从人话里抠出来（"来张猫娘图"→ 关键词=猫娘）→ **技能**

三问结论一致就定了；不一致时**以第一问为准**。完整版（含对照表与口诀）见
[skill-development.md §0](./skill-development.md#0-先做这个判断)——两型的 §0 是同一套判据，以那份为准。

### 快速对照

| 你的需求 | 该做哪一型 |
|---|---|
| 群里出现某类链接 → 一定下载转发 | **插件** |
| 每条语音 → 一定转成文字 | **插件** |
| 账号池负载均衡、图片格式降级、思考参数适配 | **插件** |
| 每轮回复都要过一道安全检查 | **插件** |
| 用户说"来张图" → 发图（时机由自然语言决定） | 技能（LLM 型） |
| 计算、查天气、做总结 | 技能（LLM 型） |

**关键机制差异**（这张表决定了一切）：

| 机制 | 谁决定何时生效 | 是否进模型的 `tools` 列表 | 是否进提示词文本 |
|---|---|---|---|
| 工具 `registerTool`（`skills/`） | **模型** | ✅ | ❌（走 function calling） |
| 提示词片段 `prompt.sections` | 模型（读了才知道） | ❌ | ✅ |
| **能力 `providers`（`plugins/`）** | **核心代码**，确定性调用 | ❌ | ❌ |
| **钩子 `hooks`（`plugins/`）** | **核心代码**，固定时机 | ❌ | ❌ |

⚠️ **想让模型能用，只有注册工具这一条路。** 只提供能力的模块放在 `skills/` 里，
对模型是完全隐形的，功能永远不会被触发（加载器会警告，见 §10）。

---

## 1. 最小可用模板

```json
// plugins/my-plugin/plugin.json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "media",
  "description": "一句话说明（UI 显示）。",
  "enabledByDefault": false,
  "capabilities": ["my.capability"],
  "settings": {},
  "configSchema": {}
}
```

```js
// plugins/my-plugin/index.js
let cfg = () => ({});

export function setup(api) {
  cfg = api.config;                 // 读本插件设置
}

export const providers = {
  // 入参/返回由**消费方（核心）**约定，见 §4
  'my.capability': ({ input } = {}) => {
    return { ok: true, output: String(input || '').trim() };
  }
};
```

两个文件即可，放进 `plugins/my-plugin/`，**默认就生效**（热重载默认开着）。

> **在哪看它？** 控制台顶部的 **「插件」页签**（就在「技能」右边）——
> 那一页列出全部确定性型插件、各自提供的能力、以及"为什么没生效"。
> 旁边的「技能」页签管的是另一型（LLM 型，`skills/`），两页互不混入。
> 这是有意的：判别"这个功能会不会被模型忽略"是使用者最关心的一件事，所以分页展示。

```bash
npm run new:skill my-plugin -- --legacy    # 脚手架生成（--legacy 生成 plugin.json 形态）
```

> `plugin.json` 与 `skill.json` 走同一条 `normalizeManifest`，**功能完全等价** ——
> 都支持 `capabilities` / `requires` / `hooks` / `prompt` / `settings` / `configSchema`。
> 用哪个文件名只影响"放在哪个目录更合适"这件事本身。

---

## 2. 两种扩展点怎么选

| 你想做的事 | 用哪个 | 为什么 |
|---|---|---|
| 核心在某个时机"问一个问题"，我回答 | **能力** | 核心按能力名取用，签名由核心定 |
| 每轮对话/每次工具调用前后"顺手做点什么" | **钩子** | 固定时机自动触发 |
| 我想**否决**一次工具调用 | 钩子 `before-tool` | 唯一能返回 `{block:true}` 的地方 |
| 我想替换某个功能的**实现**（如抽帧换方案） | **能力** | 换实现不用改核心、不用改提示词 |
| 我要发起网络请求 / 做重试 / 发消息 | **都不行** → 该做成 LLM 型的工具 | 钩子有 5 秒超时且不得有副作用，见 §3.2 |

---

## 3. 扩展点契约

### 3.1 能力（`providers`）

```js
export const providers = {
  '能力名': (args) => 结果      // 同步
  '能力名': async (args) => 结果 // 或异步
};
```

规则：

- **每个键必须在 `manifest.capabilities` 里声明**。声明了没实现 → 审计报错；实现了没声明 → 审计也报错
- 能力名格式：小写点分（`^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$`）
- 签名（入参/返回）**由消费方约定**，不是自定义的自由接口 —— 见 §4 的全表
- 大小写敏感：`capability('X')` 里的 `capability` 是 API 名，能力名字符串要完全一致

### 3.2 钩子（`hooks`）

```js
export const hooks = {
  'before-context': ({ triggerEntries, store, memory, ...ctx }) => { /* 原地加工 */ },
  'before-llm-messages': ({ messages, ...ctx }) => { /* 原地改 messages */ },
  'after-response': ({ response, session, ...ctx }) => { /* 就地改 response */ },
  'before-tool': ({ toolName, argsRaw, session, ...ctx }) => {
    if (toolName === 'send_message' && 某个条件) return { block: true, reason: '本次调用被拒绝' };
  },
  'after-tool': ({ toolName, argsRaw, result, session, ...ctx }) => { /* 观察 */ }
};
```

全部 5 个钩子及其语义：

| 钩子名 | 时机 | 参数（除公共 ctx） | 返回值 |
|---|---|---|---|
| `before-context` | 组装提示词之前 | `triggerEntries`、`store`、`memory` | 忽略（要原地改传入对象） |
| `before-llm-messages` | 发给模型之前 | `messages`（**同一数组引用，可原地改**） | 忽略 |
| `after-response` | 拿到模型响应后 | `response`、`session` | 忽略（就地改 `response`） |
| `before-tool` | 每次工具调用**之前** | `toolName`、`argsRaw`、`session` | `{ block: true, reason }` → **否决这次调用** |
| `after-tool` | 每次工具调用**之后** | `toolName`、`argsRaw`、`result`、`session` | 忽略 |

公共 `ctx`：`chatKey`、`kind`、`chatId`、`chatName`、`model`、`provider`、`visionEnabled`、`searchEnabled`、`proactive`、`sessionId`。

⚠️ **钩子的硬约束**（这几条不是风格建议，是设计边界）：

1. **单个 Skill 超时 5 秒就被跳过**（`DEFAULT_HOOK_TIMEOUT_MS`）→ 不能在里面做网络请求、下载、模型调用
2. **钩子错误的隔离方式**是"只记日志、跳过该 Skill" → 钩子坏了不会中断对话，但也不会重试
3. **不发送消息、不发请求、不重试** —— 需要这些就去注册工具（LLM 型）
4. 钩子里抛错只影响自己；但反复抛错会在 UI 上留下"上次出错"记录
5. 钩子**不能覆盖核心安全规则**：`prompt.sections` 的 `priority` 上限 99，技能片段永远排在核心规则之后

---

## 4. 被核心消费的能力名（完整契约表）

这是本文最有价值的部分：**只有这些能力名会有人来调**。

> 判定依据：核心代码里出现的能力名。自建一个新名字不会有人来调 —— 见 §5。

### 4.1 消息与文本

| 能力名 | 消费方 | 入参 | 返回 |
|---|---|---|---|
| `message.speaker-format` | `prompt.js` | `{ message, notes, selfLabel }` | 字符串标签 |
| `message.inline-at-normalize` | `onebot.js` | `{ text, members:[{userId,nickname}], atUserId }` | `string` 或 `null`（`null` = 不改） |
| `message.owner-check` | `orchestrator.js` | `{ triggerEntries, kind, selfId, persona }` | `{ persona, rules }` |

### 4.2 媒体

| 能力名 | 消费方 | 入参 | 返回 |
|---|---|---|---|
| `media.transcribe` | `onebot.js` | `{ record, onebot }` | `{ ok, text, error }` |
| `media.download` | `app.js` → `media-links.js` | `{ url, text, onebot, sender, kind, chatId }` | 见下 |
| `video.frames` | `video-reader.js` | `{ filePath, count, durationSec }` | `{ frames:[...], times:[...] }` 或 `{ error }` |
| `video.frames.available` | `video-reader.js` | `{}` | `{ ok: true \| false }` |
| `image.mime-support` | `tools.js` | `{ mime }` | `{ supported: boolean }` |

`media.download` 是**多提供者**能力（按平台拆分实现），三种返回形态：

```js
{ ok: true, platform, kind: 'video' | 'images', title, durationSec, count }  // 认领并处理成功
{ ok: false, skip: true }        // 这条链接不归我管 → 核心会问下一个提供者
{ ok: false, error, friendly }   // 归我管但失败；friendly 会被发给群（可选）
```

核心会把消息里的候选链接依次喂给所有 `media.download` 提供者，**谁认领谁处理**。
新增一个平台 = 再写一个插件提供 `media.download`，核心零改动。

### 4.3 会话状态

| 能力名 | 消费方 | 入参 | 返回 |
|---|---|---|---|
| `chat.ban-state` | `orchestrator.js` | `{ chatKey, action: 'check' }` | `{ known: boolean, muted: boolean }` |

### 4.4 LLM 链路

| 能力名 | 消费方 | 入参 | 返回 |
|---|---|---|---|
| `llm.request-params` | `llm.js` | `{ body, api, model, messages, tools, temperature, context }` | `{ body, omitTemperature? }` |
| `llm.response` | `llm.js` | `{ result, ...ctx }` | `{ result }` |
| `llm.usage` | `llm.js` | `{ result, usage, ...ctx }` | `{ 额外统计: number }`（会累加进 `extraUsage`） |
| `llm.retry-advisor` | `llm.js` | `{ body, errorText, status, ...ctx }` | `{ body, reason }` 或 `null`（= 不归我管） |
| `llm.endpoint-pick` | `llm.js` | `{ model }` | `{ id, baseUrl, apiKey, model }` |
| `llm.endpoint-feedback` | `llm.js` | `payload`（失败反馈） | 忽略 |
| `model.thinking-detect` | `routes.js` | `{ baseUrl, model }` | 思考模式信息，或 `null` |
| `tool.guard` | `tool-registry.js` | `{ toolId, tool, context }` | `false` 或 `{ ok:false, reason }` → 该工具本次不可用 |

### 4.5 回复链路（回复安全网）

这一组专治"模型不遵守工具协议"（把要说的话写在正文里）。**全部默认关闭**，
且拿不准时一律选择沉默（把内心话发进群比这轮不说话严重得多）。

| 能力名 | 消费方 | 入参 | 返回 |
|---|---|---|---|
| `reply.inline-calls` | `orchestrator.js` | `{ text, loose? }` | `{ calls:[{name,args}], stickerAnnotation? }` |
| `reply.loose-send` | `src/reply-rescue.js` | `{ text }` | `{ messages: string[] }` |
| `reply.salvage` | `src/reply-rescue.js` | `{ text, trigger, api }` | `{ say: boolean, messages: string[] }` |
| `reply.salvage-lines` | `src/reply-rescue.js` | `{ text, trigger, alreadySent, api }` | 同上 |
| `reply.is-planning-text` | `src/reply-rescue.js` | `{ text }` | `{ planning: boolean }` |
| `reply.grounded-select` | `src/reply-rescue.js`、`orchestrator.js` | `{ remember }` / `{ reset }` / `{ proposed, sent }` | `{ picked: string[] }` |
| `reply.local-policy` | `orchestrator.js` | `{ api, entries, batch }` | `{ shouldEnd, budget, ... }` |

### 4.6 多提供者能力

大多数能力只应该有**一个**提供者（两个技能抢同一个能力名 = 配置错误，审计会报）。
以下几类语义上就是"一条流水线上的多个环节"，**允许多个提供者**：

```
llm.request-params   llm.response   llm.usage
llm.retry-advisor    tool.guard     media.download
```

多提供者的取用语义（以 `llm.retry-advisor` 为例）：核心**挨个问过去**，
谁认领谁处理（返回 `null` 表示"不归我管"，继续问下一个）。
其余能力由 `getCapabilityProviders(name)[0]` 取**第一个生效的**。

---

## 5. 自建能力名（新名字没人会调）

如果你提供的是**核心不认识**的能力名：

- 核心**不会**来调用它
- 它只能被**别的 Skill** 通过 `api.capability('你的能力名')` 软依赖取用

```js
// 在另一个 Skill 里
export function setup(api) {
  const fn = api.capability('my.capability');     // 有就拿到，没有就是 undefined
  if (fn) { /* 增强路径 */ } else { /* 降级，照常工作 */ }
}
```

`requires`（清单里）与 `api.capability()` 的区别很重要：

| | 语义 | 缺了会怎样 |
|---|---|---|
| `manifest.requires` | **硬依赖** | 本 Skill 被判为"不可用"，UI 显示"依赖未就绪" |
| `api.capability()` | **软依赖** | 静默降级，本 Skill 照常工作 |

**判据**：缺了它就完全没法工作 → `requires`；缺了只是少个增强 → `api.capability()`。

⚠️ 审计脚本有一项"孤儿能力检查"：**有提供方但全项目没有取用调用**的能力会被报出来。
如果核心不认、也没有别的 Skill 消费它，那这个功能永远不会被触发 —— 要么接上消费方，
要么把能力名从 `capabilities` 里去掉（当普通导出用）。

---

## 6. `api` 里有什么

`setup(api)` 拿到的 API 面：

| 成员 | 说明 |
|---|---|
| `api.config()` | 读本插件设置（默认值已由 `manifest.settings` 合并） |
| `api.capability(name, args?)` | **软依赖**取用别人的能力；没有提供者时返回 `undefined`，抛错也被吞掉 |
| `api.hasCapability(name)` | 有没有人提供这个能力 |
| `api.isSkillActive(id, ctx?)` | 某个 Skill 是否生效 |
| `api.registerTool(def)` | 注册工具（**LLM 型才需要**） |
| `api.log/warn/error(...)` | 自动加 `[skill:<id>]` 前缀 |
| `api.fetch` | ⚠️ 只有清单声明了 `permissions: ["web_fetch"]` 才拿得到；否则调用即 reject |
| `api.utils.sleep(ms)` / `api.utils.safeJsonParse(text, fallback)` | 小工具 |

> 注意：能力是 `export const providers` **导出**的，不是 `api.registerXxx` 注册的，也没有 `api.registerHook`。

---

## 7. 生命周期与可用性

```js
export function setup(api) { /* 加载时一次 */ }
export function available() { return { ok: false, reason: '依赖没装' }; }   // 可选自检
export async function activate(ctx) { /* 启用时：起定时器、订阅 */ }
export async function deactivate(ctx) { /* 禁用时：**必须**清掉 activate 建的东西 */ }
export function dispose() { /* 卸载/热重载时最后清理 */ }
```

- **`available()` 必须同步**。可用性判定走同步链，返回 Promise 会被当成"可用"。
  异步探测（spawn、网络）用"首次乐观放行 + 后台探测 + 缓存结果"模式
  （参考 `plugins/speech-to-text/index.js` 的 `probeState`）
- `deactivate` 里不清理 → "关掉了但还在推消息"、重复发言、内存增长
- 热重载顺序：**先 `deactivate` + `dispose` 旧实例，再跑新 `setup`**，所以不要在
  `setup` 里启动需要显式停止的东西（放 `activate`）

---

## 8. 写操作的边界

### 8.1 发消息必须走 `sender`

核心会把 `sender`（发送队列）**随能力入参传进来**（如 `media.download`），
或者你在工具里用 `ctx.sender`。

```js
await sender.sendTextBatch(`${kind}:${chatId}`, ['文本'], { replyToMessageId });
await sender.sendMedia(`${kind}:${chatId}`, [{ type: 'video', data: { file: '/x.mp4' } }], { label: '[视频]' });
```

**不得**直接调 `onebot.sendSegments` / `sendGroupMsg` —— 那会跳过：

- 每会话串行（消息乱序）
- 限频（媒体把配额吃光后，文字突然发不出）
- 去重（重复刷屏）
- 留档（下一次运行不知道自己发过 → 重复发）

审计脚本有静态检查抓这个：**凡调 `onebot.send*` 的文件，必须同时出现 `sender.sendMedia`**
（说明做了"优先走队列、直发仅兜底"的收口）。

### 8.2 操作 QQ（禁言/踢人/撤回）

```js
try {
  await onebot.call('set_group_ban', { group_id: Number(gid), user_id: Number(uid), duration: 600 });
} catch (e) { log(`禁言失败：${e.message}`); }
```

- `call()` 是**纯透传**（`POST {httpUrl}/{action}`），**没有 action 白名单** → 协议端 73 个接口全部可达
- 失败**会抛错**（HTTP 非 2xx 或 `retcode !== 0`）→ 必须 `try/catch`
- **没有白名单 = 没有护栏**：禁言/踢人/撤回/发说说一旦调用就真的生效。
  确定性型插件是"条件满足必跑"，所以更要自己加权限判断和自保逻辑
- 接口清单与**每个接口的参数表**见 [snowluma-capabilities.md](./snowluma-capabilities.md)
  —— 本文不重复参数表；交给 AI 生成涉及 QQ 操作的插件时，**必须把那份文档一并附加**

---

## 9. 热重载与上架

### 热重载

**默认开启**：目录放进 `plugins/` 就生效，不需要重启。

- 监听 `plugins/` 与 `skills/`；重载后重跑激活 → 刷新工具定义 → 推送状态到 UI
- 删除目录 → 下一次重扫把它卸掉
- 配置项 `config.extensions.hotReload`（默认 `true`）；`QQ_AGENT_DEV=1` 可强制打开
- ⚠️ 安全含义：等价于"任意落地的 JS 会被执行"。共享机器/固定版本建议关掉

### 上架

打包 zip（包内**直接**是 `plugin.json` + `index.js`）→ `POST /api/community/skills/upload`（multipart，字段 `file`）。

| 限制 | 值 |
|---|---|
| 压缩包大小 | ≤ 8MB |
| 解压后总大小 | ≤ 32MB |
| 文件数 | ≤ 100 |
| 必须包含 | `plugin.json` 或 `skill.json` |
| 清单编码 | 合法 UTF-8 JSON，**不能带 BOM** |
| 禁止 | 绝对路径 / `..` / `.exe .dll .bat .cmd .ps1 .vbs .sh` |
| `id` | 合法且未被占用（重复 → 409） |

打包前清掉：`node_modules/`、`data/`、密钥文件、`entry.json`。

---

## 10. 自检清单

**结构**
- [ ] 目录 `plugins/<id>/`，含 `plugin.json` + `index.js`
- [ ] 至少提供**一个能力或钩子**（否则没有任何代码会调用它 → 应改做 LLM 型）
- [ ] 清单文件不带 UTF-8 BOM
- [ ] 没有在 `plugins/` 下另建顶层共享目录（加载器只扫一级子目录）

**能力**
- [ ] `providers` 的每个键都在 `capabilities` 里声明（双向一致）
- [ ] 能力名是"小写点分"格式
- [ ] **入参/返回符合消费方的约定**（对照 §4；这不是自由接口）
- [ ] 自建能力名有别的 Skill 消费它（否则是孤儿，功能永不触发）
- [ ] 声明了 `requires` 的能力，项目里确实有人提供

**钩子**
- [ ] 没有在钩子里做网络请求 / 下载 / 模型调用（5 秒超时会被跳过）
- [ ] 没有在钩子里发消息或重试
- [ ] `before-tool` 的否决返回的是 `{ block: true, reason }`

**运行期**
- [ ] `available()` 是同步的
- [ ] `activate` 建的定时器/监听器在 `deactivate` 里清了
- [ ] 发消息走 `sender`，没有直接调 `onebot.send*`
- [ ] 操作 QQ 的写接口有权限判断 + `try/catch`
- [ ] 密钥标了 `secret: true`，代码里没有硬编码

---

## 11. 常见失败对照表

| 现象 | 原因 | 修法 |
|---|---|---|
| 加载成功但功能从不触发 | 放错目录（只有 providers 却在 `skills/`），或能力名没人消费 | 移到 `plugins/`；或让核心/别的 Skill 消费它 |
| 审计报"实现了但没声明" | `providers` 的键不在 `capabilities` 里 | 补进 `capabilities` |
| 审计报"声明了但没实现" | `capabilities` 里有键但 `providers` 没写 | 实现它，或从清单里删掉 |
| 审计报"孤儿能力" | 有提供方、全项目无取用调用 | 接上消费方，或把能力名降为普通导出 |
| 审计报"能力名冲突" | 两个插件提供同一个单提供者能力 | 合并实现；确实需要多提供者就加到白名单并说明理由 |
| 钩子里的耗时操作不稳定生效 | 超过 5 秒被跳过 | 搬到工具里（LLM 型） |
| 关掉插件后行为还在 | `deactivate` 没清定时器/订阅 | 在 `deactivate` 里清理 |
| 插件关着却仍有网络请求 | 忘了先检查 `providers` 是否存在（核心取不到提供者时会跳过，但你自己别主动跑） | 核心侧已按"无提供者即空操作"实现，插件侧不要自作主张 |
| 消息重复 / 刷屏 | 绕过 `sender` 直连 OneBot | 改用 `ctx.sender` / `sender.sendMedia` |
| 加载日志里出现 `⚠️ 在 plugins/ 却没有提供能力或钩子` | 放错了目录 | 移到 `skills/` 并注册工具 |
| 加载日志里出现 `⚠️ 在 skills/ 却没有注册任何工具` | 放错了目录 | 移到 `plugins/` 或补 `registerTool` |
| 在「插件」页找不到它 | 放到了 `skills/`（会显示在「技能」页） | 确认目录与类型一致 |

---

## 12. 完整示例：能力 + 钩子齐备的插件

```json
// plugins/quiet-hours/plugin.json
{
  "id": "quiet-hours",
  "name": "安静时段",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "message",
  "description": "在设定时段内禁止机器人发消息（确定性拦截，不依赖模型自觉）。",
  "enabledByDefault": false,
  "capabilities": ["chat.quiet-gate"],
  "settings": { "startHour": 1, "endHour": 7, "blockMedia": true },
  "configSchema": {
    "startHour": { "type": "number", "label": "开始小时", "description": "0~23，默认 1。" },
    "endHour":   { "type": "number", "label": "结束小时", "description": "0~23，默认 7。" },
    "blockMedia": { "type": "boolean", "label": "同时拦截媒体", "description": "关闭后只拦文字。" }
  }
}
```

```js
// plugins/quiet-hours/index.js
let cfg = () => ({});

export function setup(api) {
  cfg = api.config;
  api.log('安静时段已加载');
}

/** 当前是否处于安静时段。跨零点（如 23 → 7）也要算对。 */
function inQuietHours(now = new Date()) {
  const c = cfg();
  const start = Math.max(0, Math.min(23, Number(c.startHour) ?? 1));
  const end = Math.max(0, Math.min(23, Number(c.endHour) ?? 7));
  if (start === end) return false;
  const h = now.getHours();
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

export const providers = {
  /**
   * 供别的模块（或工具）问"现在能不能发消息"。
   * 自建能力名 —— 核心不认识它，所以必须有人用 api.capability() 取用，
   * 否则审计会把它标成孤儿能力（表示这个功能永远不会被触发）。
   */
  'chat.quiet-gate': () => ({ quiet: inQuietHours(), config: { startHour: cfg().startHour, endHour: cfg().endHour } })
};

export const hooks = {
  /**
   * 工具执行前拦截：安静时段直接否决所有发送类工具。
   * 这是"确定性"的关键 —— 不靠提示词劝模型别发，而是让 send_message 根本执行不了。
   */
  'before-tool': ({ toolName }) => {
    if (!inQuietHours()) return;
    const sending = ['send_message', 'send_sticker', 'send_poke'];
    if (cfg().blockMedia !== false) sending.push('send_image', 'read_video');
    if (sending.includes(toolName)) {
      return { block: true, reason: `现在是安静时段（${cfg().startHour}~${cfg().endHour} 点），不允许发消息` };
    }
  }
};
```

这个示例覆盖了：确定性拦截（钩子否决）、自建能力名、跨零点的时间判断、配置读取。

> ⚠️ 注意最后一点：`chat.quiet-gate` 是**自建能力名**，核心不会调它。
> 要么让某个工具/插件用 `api.capability('chat.quiet-gate')` 取用，
> 要么把这一项从 `capabilities` 里去掉、只当普通导出的辅助函数用。
> 留着又没人用 → 审计会报孤儿能力。

---

## 13. 本仓库现状（可直接参考的实例）

### `plugins/`（确定性型，10 个）

| 插件 | 默认 | 提供的能力 |
|---|---|---|
| `account-pool` | 关 | `llm.endpoint-pick`、`llm.endpoint-feedback` |
| `ban-state` | **开** | `chat.ban-state` |
| `image-compat` | **开** | `image.mime-support`、`llm.retry-advisor` |
| `media-download` | 关 | `media.download` |
| `owner-identity` | 关 | `message.owner-check` |
| `reply-safety` | 关 | `reply.*`（7 个） |
| `speaker-identity` | **开** | `message.speaker-format`、`message.inline-at-normalize` |
| `speech-to-text` | 关 | `media.transcribe` |
| `thinking-adapters` | **开** | `llm.request-params`、`llm.response`、`llm.usage`、`llm.retry-advisor`、`model.thinking-detect` |
| `video-frames` | **开** | `video.frames`、`video.frames.available` |

### `skills/`（LLM 型，5 个）

| 技能 | 默认 | 注册的工具 |
|---|---|---|
| `calculator` | 开 | 计算器 |
| `text-tools` | 开 | 文本工具（2 个） |
| `weather-query` | 开 | 天气查询 |
| `random-image` | 关 | 发二次元随机图 |
| `sticker-annotate` | 关 | 表情包标注 |

---

## 相关文档

交给 AI 时的附加文档选择见文首的「📎」一节。

- [skill-development.md](./skill-development.md) —— LLM 型技能开发（注册工具）
- [skill-reference.md](./skill-reference.md) —— 共同机制完整参考（清单、生命周期、能力系统、ctx 全量字段、硬约束清单、上架）
- [snowluma-capabilities.md](./snowluma-capabilities.md) —— 协议端 73 个接口的逐条参数表
- [skill-system.md](./skill-system.md) —— 架构总览
- [video-modes.md](./video-modes.md) —— 视频理解两条路的分工与配置（提供 video.frames 类能力前先读）
