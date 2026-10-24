# LLM 型技能开发（`skills/`）

> 本文管**一类**扩展：注册工具，交给模型决定什么时候用。
> 另一类是**确定性型**（`plugins/`，满足条件必然触发、不经过 LLM），见
> [plugin-development.md](./plugin-development.md)。
> 两者的共同机制（清单字段、生命周期、能力系统、热重载、上架）见
> [skill-reference.md](./skill-reference.md)。

---

## 📎 把本文档交给 AI 生成技能时，需要一并提供的文档

本文是**主文档**，写明了 LLM 型技能的全部机制与硬约束，但**有意不重复**以下内容 ——
它们在各自的专门文档里，按需附加（全部在同一目录 `doc/extend_development/`）：

| 需要实现什么 | 必须附加 | 里面有什么 |
|---|---|---|
| **任何功能**（建议总是附加） | [skill-reference.md](./skill-reference.md) | 共同机制完整参考：api 对象全表、ctx 全量字段（store/memory/stickers/session/reminders 的每个方法）、硬约束清单（§14）、完整示例（§16）。**本文为了篇幅只摘了常用部分** |
| 调用 QQ 接口（查群成员、禁言、踢人、撤回、发说说、群文件、群相册……） | [snowluma-capabilities.md](./snowluma-capabilities.md) | 协议端全部 **73 个 OneBot 接口的逐条参数表与返回示例**（每个接口的字段名、类型、必填）。本文 §5.2 只讲了调用姿势，**不含参数表** |
| 想让 AI 理解整个系统的设计（可选） | [skill-system.md](./skill-system.md) | 架构总览：状态模型、能力系统、判定链 |
| 零基础人类阅读（可选，AI 不需要） | [skill-guide-for-beginners.md](./skill-guide-for-beginners.md) | 大白话教程 |

**给小白的操作指引**：你只需要对 AI 说"按 skill-development.md 的规范生成一个 XXX 技能"，
并**把上表中你用得到的文档内容一起粘贴/上传给 AI**（至少附加 skill-reference.md；
功能涉及操作 QQ 就再加 snowluma-capabilities.md）。AI 输出的会是
`skills/<id>/skill.json` + `skills/<id>/index.js` 两个文件的完整内容，
你把它们保存到项目 `skills/<id>/` 目录下即自动生效（热重载默认开启）。

**多轮迭代**：如果 AI 生成的技能加载失败或行为不对，把控制台「技能」页显示的
错误原因（或加载日志里的 ❌ 行）原样发给 AI 让它修正 —— 本文 §12 的常见失败对照表
就是给 AI 排错用的。

---

## 0. 先做这个判断

同一种功能，做错类型的后果是**功能静默失效**（不报错、不崩、就是没反应）。所以动手前先回答一个问题：

> **这个功能"什么时候该运行"——触发条件是死的，还是要靠理解一句人话？**

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

把"什么时候该运行"翻译成代码条件试试：

```js
if (消息里有 B站链接) …            // ✅ 能 → 插件
if (用户 @机器人 && 提到"天气") …   // ⚠️ 半能：@ 是死条件，但"提到天气"要理解语义 → 技能
if (收到一条语音) …                // ✅ 能 → 插件
```

**第二问：漏触发一次的代价是什么？**

- 漏一次就丢数据/坏事（语音没转文字、禁言状态没记住）→ **插件**，必须每次都跑
- 漏一次只是少个花活（这次没接梗、没发图）→ **技能**，模型下次还有机会

**第三问：参数从哪来？**

- 参数是系统给的（消息对象、链接、文件路径）→ **插件**
- 参数要从人话里抠出来（"来张猫娘图"→ 关键词=猫娘）→ **技能**

三问结论一致就定了；不一致时**以第一问为准**（触发条件是本质，其余是佐证）。

### 对照表

| 情况 | 该做哪一型 | 为什么 |
|---|---|---|
| 群里出现 B站链接 → 下载转发 | **插件** | 条件是明确的（有链接），不该让模型决定 |
| 每条语音 → 转成文字 | **插件** | 每条语音都该转，模型漏一次就丢信息 |
| 账号池负载均衡、图片格式降级、思考参数适配 | **插件** | 纯管道逻辑，没有"要不要做"的判断 |
| 被禁言的群直接不跑 | **插件** | 状态判断是死的 |
| 用户说"来张图"→ 发图；问天气 → 查天气 | **技能** | 什么时候用取决于自然语言，只有模型判得准 |
| 计算、查询、生成、需要"看情况发挥" | **技能** | 参数和时机都灵活 |
| 关掉某功能后，工具的可用性跟着变 | **插件** | 这是能力提供方，不是"工具" |

### 判断口诀（记不住表格时用）

> **"模型必须看见它做的决定" → 插件（替模型做死决定）**
> **"模型看见它才有的可做" → 技能（给模型添新决定）**

⚠️ 只有工具会进模型的 `tools` 列表。所以：

- 想让模型能用它 → **必须** `registerTool`
- 只写 `providers` 却放在 `skills/` → 模型完全看不到它（加载器会给警告，见 §11）

---

## 1. 最小可用模板

```js
// skills/my-skill/skill.json
{
  "id": "my-skill",
  "name": "我的技能",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "一句话说明这个技能干什么（UI 上会显示）。",
  "enabledByDefault": false,
  "settings": {},
  "configSchema": {}
}
```

```js
// skills/my-skill/index.js
export function setup(api) {
  api.registerTool({
    id: 'my_tool',                       // 会成为 my-skill__my_tool
    name: '做某件事',
    description: '当用户要求……时使用。参数 x 表示……',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'string', description: '要处理的文本' }
      },
      required: ['x']                    // 空数组时**省略**这个字段
    },
    async execute(ctx, args) {
      return { content: `处理结果：${args.x}` };
    }
  });
}
```

就这两个文件。放进 `skills/my-skill/`，**默认就生效**（热重载开着，见 §9）。

> **在哪看它？** 控制台顶部的 **「技能」页签**——
> 那一页列出全部 LLM 型技能、各自注册的工具、以及"为什么没生效"。
> 旁边还有一个 **「插件」页签**（确定性型，`plugins/`），两页互不混入 ——
> 所以如果你把技能放错到 `plugins/` 里，它会出现在「插件」页而不是「技能」页。

也可以让脚手架生成骨架：

```bash
npm run new:skill my-skill -- --name "我的技能" --category utility
```

---

## 2. 目录与文件

```
skills/<id>/
├── skill.json       必须。不写 → 加载失败（缺少 skill.json / plugin.json）
├── index.js         必须。不写 → 清单能读，但模型一个工具都没有
├── README.md        可选。⚠️ 加载器不读它，删掉不影响运行
└── lib/*.js         可选。代码拆分用，相对 import 正常（已验证）
```

> ⚠️ **不要把共用代码放到 `skills/` 下的另一个顶层目录**（如 `skills/shared/`）。
> 加载器只扫描**一级子目录**，`skills/shared/` 会被当成一个 Skill 去加载，
> 然后因为缺清单而失败。共享代码放在使用它的技能内部（`skills/a/lib/`）。

测试文件放**项目根的 `test/`**，不要放在技能目录里：

```
test/my-skill-test.mjs
```

---

## 3. 清单字段（`skill.json`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识。`^[a-zA-Z0-9][a-zA-Z0-9._-]*$` |
| `name` | ✅ | 显示名（UI） |
| `version` | ✅ | 语义化版本 |
| `apiVersion` | | Skill API 版本，当前 `1` |
| `enabledByDefault` | | 用户从没配置过时用这个。**默认 `true`**，新技能建议显式写 `false` |
| `category` | | `model` / `message` / `knowledge` / `media` / `utility`。非法值会被回退成 `utility` 并记 problem |
| `description` | | 一句话说明（UI 展示） |
| `author` | | 作者署名；上架时用作市场里的名字 |
| `prompt` | | 提示词片段，见 §7 |
| `settings` | | 默认配置值，见 §8 |
| `configSchema` | | 配置项声明（UI 据此渲染表单），见 §8 |
| `requires` | | **硬依赖**的能力名数组。缺了 → 本技能被判为"不可用" |
| `capabilities` | | 本技能**提供**的能力名数组（LLM 型通常为空） |
| `deprecated` | | `true` 标记过期（仍能加载，UI 提示） |

---

## 4. 工具定义规范

`registerTool(def)` 的字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 工具名。会变成 `skillId__<id>` 发给模型 |
| `name` | ✅ | 中文显示名（UI 与日志用） |
| `description` | ✅ | **给模型看的**。写法见下 |
| `execute` | ✅ | `async (ctx, args) => { content, isError? }` |
| `category` | | `messaging` / `sticker` / `query` / `memory` / `web` / `knowledge` / `media` / `system` |
| `icon` | | emoji（UI 用） |
| `defaultEnabled` | | 默认是否启用（默认 `true`） |
| `requiresVision` | | `true` → 模型不支持图片时自动禁用 |
| `requiresSearch` | | `true` → 搜索关闭时自动禁用 |
| `requires` | | 需要的能力名数组；没有提供者时该工具不可用 |
| `parameters` | | OpenAI function 参数 schema |

### 4.1 id 的硬约束

工具 id 会成为发给模型的 **OpenAI function name**，只允许 `[a-zA-Z0-9_-]`、总长 ≤ 64。

- 注册时会**自动加前缀** `<skillId>__`（`skillId` 截到 24、工具名截到 38，正好 ≤ 64）
- 所以技能目录名/id 里的 `.`、`:` 等字符会被替换成 `_`
- 违规会被注册表**直接拒绝**（不是警告）—— 因为严格端点（OpenAI / DeepSeek）会用 400 拒掉整个请求，连带这一轮所有工具都失效

### 4.2 description 怎么写

这段文字是模型唯一的判断依据。三条规则：

1. **写清触发时机**，不是写功能。"随机取若干张二次元插画并发到群里。当用户说'来张图/随机图/二次元图'时使用。"
2. **必要时写"什么时候不要用"**。"只在这个群需要时用，不要主动发。"
3. **写清参数的语义和边界**。"关键词，可选。如'猫娘''风景'。不填则完全随机。"

反例（等于没写）：`"发送图片"` —— 模型不知道什么时候该调它。

### 4.3 parameters

标准 JSON Schema：

```js
parameters: {
  type: 'object',
  properties: {
    query: { type: 'string', description: '搜索关键词（越具体越准）' },
    limit: { type: 'integer', description: '最多返回几条，默认 8' }
  },
  required: ['query']
}
```

- `required` 是**空数组时直接省略**这个字段（写成 `required: []` 会被审计判为不规范）
- 可选参数请不要塞进 `required`
- 参数超过 5 个就考虑拆成多个工具 —— 参数越多，模型填错率越高

### 4.4 execute 的返回值

```js
return { content: '给模型看的结果文本' };              // 正常
return { content: '错误说明', isError: true };          // 失败（模型能看到并自行纠正）
return { content: [{ type: 'text', text: '...' },
                   { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }] };
```

- `content` 可以是字符串，也可以是 parts 数组（带图片/视频）
- ⚠️ 图片**必须**走 parts（`image_url`），**绝不能**把 base64 拼进文本 —— 模型看不到图，却要为几十万 token 付钱
- 失败的路径要返回 `isError: true` 而不是抛错；抛错会被上层兜成通用错误，模型拿不到有用信息

---

## 5. `ctx` 里有什么

`execute(ctx, args)` 的 `ctx` 由核心组装：

| 字段 | 说明 |
|---|---|
| `chatKey` / `kind` / `chatId` | 会话标识。`kind` 是 `'group'` / `'private'` |
| `selfId` / `selfNickname` / `botName` | 机器人自己的身份 |
| `sender` | **发送队列**。发消息一律用它，见 §6 |
| `onebot` | OneBot 客户端。`ctx.onebot.call(action, params)` 可调协议端任意接口 |
| `session` | 本次运行的会话对象（`sent` 是已发送记录） |
| `store` / `memory` / `stickers` | 聊天存档 / 长期记忆 / 表情库 |
| `reminders` / `videoReader` | 提醒服务 / 视频理解 |

> 本表是**摘要**。`ctx.store` / `ctx.memory` / `ctx.stickers` / `ctx.session` /
> `ctx.reminders` / `ctx.videoReader` 每个对象的**完整方法签名**见
> [skill-reference.md §10](./skill-reference.md#10-executectx-args-的-ctx-全量字段)。
> 技能要用到这些对象（而不是只发消息）时，把 skill-reference.md 一并交给 AI。
| `emit(type, payload)` | 往控制台推事件 |

### 5.1 发消息必须走 `ctx.sender`

```js
await ctx.sender.sendTextBatch(ctx.chatKey, ['消息一', '消息二'], { replyToMessageId: mid });
await ctx.sender.sendImage(ctx.chatKey, { dataUrl }, { note: '说明' });
await ctx.sender.sendSticker(ctx.chatKey, sticker);
await ctx.sender.poke(ctx.chatKey, userId);
await ctx.sender.sendMedia(ctx.chatKey, segments, { label: '[媒体]' });   // 视频/多图
```

`SendQueue` 里做了四件事，**一件都不能省**：

- **每会话串行**（消息不会乱序）
- **限频**（分钟/小时配额，超限拒绝）
- **去重**（窗口期内相同内容只发一次）
- **留档**（记为 `self=true`，否则下一次运行不知道自己发过，可能重复发）

⚠️ 直接调 `ctx.onebot.sendSegments` / `sendGroupMsg` 会跳过以上全部。审计脚本有一条静态检查专门抓这个（见 §11）。

### 5.2 操作 QQ（禁言/踢人/撤回等）

```js
try {
  await ctx.onebot.call('set_group_ban', { group_id: Number(id), user_id: Number(uid), duration: 600 });
} catch (e) {
  return { content: `禁言失败：${e.message}`, isError: true };
}
```

- `call()` 是**纯透传**：`POST {httpUrl}/{action}`，**没有任何白名单** → 协议端支持的接口全部可达
- 失败**会抛错**（HTTP 非 2xx，或响应 `retcode !== 0`）→ 必须 `try/catch`
- 没有白名单 = 没有护栏：禁言/踢人/撤回/发说说一旦调用就真生效。**涉及 QQ 写操作时自己加权限判断**
- 接口清单（73 个）与**每个接口的参数表**见 [snowluma-capabilities.md](./snowluma-capabilities.md)
  —— 本文不重复参数表；交给 AI 生成涉及 QQ 操作的技能时，**必须把那份文档一并附加**

---

## 6. 提示词片段（`prompt.sections`）

想让模型"知道某件事"，而不是"能调用某个工具"，用提示词片段：

```json
{
  "prompt": {
    "sections": [
      {
        "id": "my-note",
        "title": "关于某件事",
        "priority": 35,
        "content": "群友发的语音会被转成文字给你看。转写可能有错，拿不准时按上下文理解。"
      }
    ]
  }
}
```

- `priority` **上限 99**，且技能片段永远排在核心规则之后 —— 技能不能覆盖安全规则（审计会检查这一点）
- 数字越大越靠前（同一批技能之间）
- 两三句话写清"什么时候该注意什么"就够了，不要写成长文
- 也可以导出 `promptSections(ctx)` 函数，根据运行期状态动态生成

---

## 7. 配置项（`settings` + `configSchema`）

```json
{
  "settings": { "maxCount": 3, "safeMode": true, "source": "auto", "apiKey": "" },
  "configSchema": {
    "maxCount": { "type": "number", "label": "每次最多几张", "description": "1~10，默认 3。" },
    "safeMode": { "type": "boolean", "label": "安全模式", "description": "关闭后会取到不适宜的图。" },
    "source":   { "type": "enum", "values": ["auto", "a", "b"], "label": "图源", "description": "auto 表示自动选择。" },
    "apiKey":   { "type": "string", "label": "API Key", "description": "填写后启用 XX。", "secret": true }
  }
}
```

| `type` | UI 渲染 |
|---|---|
| `boolean` | 开关 |
| `number` | 数字输入 |
| `enum` | 下拉（**必须带 `values` 数组**） |
| `string` | 文本框（默认） |

补充字段：

- `label` ✅ 必填；`description` 强烈建议写
- `secret: true` → 密码框 + "留空 = 不修改"占位；**脱敏值不会回填**，接口返回 `******`
- `multiline: true`（string）→ 多行文本
- `type: 'internal'` → 不给用户编辑的值（必须写 `description` 说明用途）

读取方式：

```js
let cfg = () => ({});
export function setup(api) { cfg = api.config; }
// 之后 cfg().maxCount
```

**规则**：

- `settings` 里有默认值 → `configSchema` 里**必须有**对应声明（否则审计报错：UI 上永远改不了）
- 声明的默认值来自 `settings`，运行时合并，**不落盘**；只有用户改过才写进 `data/config.json` 的 `skills.<id>`

---

## 8. 生命周期与可用性

```js
export function setup(api) { /* 加载时一次：注册工具、读配置 */ }

export function available() {                 // 可选：自检
  return { ok: false, reason: '还没填 API Key' };   // 不可用时 UI 直接显示原因
}

export async function activate(ctx) { /* 被启用时：起定时器、订阅事件 */ }
export async function deactivate(ctx) { /* 被禁用时：**必须**清掉 activate 建的东西 */ }
export function dispose() { /* 卸载/热重载时最后清理 */ }
```

⚠️ **`available()` 必须是同步的**。可用性判定走同步调用链，返回 Promise 会被当成"可用"。
需要探测外部依赖（如 spawn 进程）时用"首次乐观放行 + 后台探测 + 缓存结果"的模式（可参考 `plugins/speech-to-text/index.js`）。

⚠️ `deactivate` 里不清定时器/监听器 → 表现为"关掉了但还在推消息"、重复发言、内存增长。

---

## 9. 热重载

**默认开启**。把目录放进 `skills/` 就生效，不需要重启：

- 监听 `skills/` 与 `plugins/`
- 重载后自动：重跑激活 → 刷新工具定义 → 推送状态到 UI
- 删除目录 → 下一次重扫把它卸掉（清理幽灵残留）

配置项：`config.extensions.hotReload`（默认 `true`）。
环境变量 `QQ_AGENT_DEV=1` 可强制打开。

> ⚠️ **安全含义**：热重载等价于"任意落地的 JS 会被执行"。共享机器 / 只跑固定版本时建议关掉。

---

## 10. 上架到市场

1. 把技能目录打包成 zip（压缩包内**直接**是 `skill.json` + `index.js` + 子目录，不要多套一层文件夹）
2. `POST /api/community/skills/upload`，multipart，字段名 **`file`**
3. 服务端校验：
   - 压缩包 ≤ **8MB**，解压后 ≤ **32MB**，文件数 ≤ **100**
   - 必须含 `skill.json` 或 `plugin.json`
   - 清单必须是合法 UTF-8 JSON（**不能带 BOM**）
   - `id` 合法且**未被占用**（重复 → 409）
   - 禁止绝对路径 / `..`；**禁止 `.exe .dll .bat .cmd .ps1 .vbs .sh`**
4. 服务端生成 `entry.json`（市场元数据）并缓存打包好的 zip（用户下载时**不含** `entry.json`）

**打包前必须清掉**：`node_modules/`、`data/`、API Key 等敏感文件、`entry.json`（那是服务端的东西）。

---

## 11. 自检清单

跑 `npm run test:audit` 会自动查大部分。人工再确认：

**结构与命名**
- [ ] 目录 `skills/<id>/`，含 `skill.json` + `index.js`
- [ ] `id` 匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`
- [ ] 没有在 `skills/` 下另建顶层共享目录
- [ ] 清单文件**不带 UTF-8 BOM**（Windows 编辑器容易加）

**工具**
- [ ] 至少注册了一个工具（否则模型看不到它 → 应改做确定性型）
- [ ] 工具 `id` 只用 `[a-zA-Z0-9_-]`
- [ ] 每个工具的 `description` 写清了触发时机
- [ ] `parameters` 是合法 JSON Schema；`required` 为空时**省略**
- [ ] 失败路径返回 `isError: true` 而不是抛错
- [ ] 图片/视频走 parts（`image_url`），没有把 base64 塞进文本

**配置与提示词**
- [ ] `settings` 里每个键都在 `configSchema` 里有声明
- [ ] `enum` 带了 `values`；`internal` 带了 `description`
- [ ] 密钥字段标了 `secret: true`，代码里**没有硬编码**密钥
- [ ] 提示词片段 `priority ≤ 99`

**运行期**
- [ ] 发消息一律用 `ctx.sender`，没有直接调 `onebot.send*`
- [ ] `available()` 是同步的
- [ ] `activate` 建的东西在 `deactivate` 里清掉了
- [ ] 操作 QQ 的写接口有权限判断 + `try/catch`

---

## 12. 常见失败对照表

| 现象 | 原因 | 修法 |
|---|---|---|
| 加载失败：`缺少 skill.json / plugin.json` | 清单缺失，或放在了 `skills/` 的二级目录里 | 检查路径；共享代码移到技能内部 `lib/` |
| `清单解析失败：Unexpected token` | 文件带了 UTF-8 BOM | 存成无 BOM 的 UTF-8 |
| 加载成功，但模型从不调用 | 没注册工具，或放错目录（只有 providers 却在 `skills/`） | `registerTool`，或移到 `plugins/` |
| 模型调用后报 400 `invalid function name` | 工具 id 含 `.` `:` 等非法字符 | 只用 `[a-zA-Z0-9_-]` |
| 工具列表里没有它 | 技能被禁用了 / `available()` 返回了 `ok:false` / `requiresVision` 但模型不支持图 / `requires` 的能力没人提供 | 逐项查可用性原因（UI 会显示） |
| UI 上看不到某个设置项 | `settings` 有默认值但 `configSchema` 没声明 | 补上声明 |
| 改了设置没反应 | 代码读的是常量而不是 `api.config()` | 用 `api.config()` 读 |
| 关掉技能后行为还在 | `deactivate` 没清定时器/监听器 | 在 `deactivate` 里清理 |
| 消息重复发送 | 绕过了 `ctx.sender` 直连 OneBot | 改用 `ctx.sender`（去重 + 留档都在里面） |
| 放了目录进去没加载 | 热重载被关了 | 检查 `config.extensions.hotReload` |
| 在「技能」页找不到它 | 放到了 `plugins/`（会显示在「插件」页） | 确认目录与类型一致；加载器启动日志也会警告 |
| 上架被拒：`该 Skill id 已存在` | id 撞了 | 换 id 或走升级流程 |
| 上架被拒：`禁止上传可执行文件` | 包里带了 `.bat` / `.py` 等 | 清掉 |

---

## 13. 完整示例：带配置、提示词、自检的工具技能

```json
// skills/dice-roller/skill.json
{
  "id": "dice-roller",
  "name": "骰子",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "按群规掷骰子（如 1d100），用于决定谁去做某件事。",
  "enabledByDefault": false,
  "settings": { "maxSides": 100, "announce": true },
  "configSchema": {
    "maxSides": { "type": "number", "label": "最大面数", "description": "超过这个面数的请求会被拒绝，防止刷屏。默认 100。" },
    "announce": { "type": "boolean", "label": "自动报结果", "description": "开启后掷完直接把结果发到群里。" }
  },
  "prompt": {
    "sections": [
      {
        "id": "dice-note",
        "title": "掷骰子",
        "priority": 30,
        "content": "群友说「掷骰子」「roll」「1d100」时用 roll_dice 工具，不要自己编数字。"
      }
    ]
  }
}
```

```js
// skills/dice-roller/index.js
let cfg = () => ({});

export function setup(api) {
  cfg = api.config;

  api.registerTool({
    id: 'roll_dice',
    name: '掷骰子',
    description: '按 NdM 的形式掷骰子并返回每个骰子的点数与总和。当群友要求「掷骰子」「roll」「比大小」时使用。',
    category: 'utility',
    icon: '🎲',
    parameters: {
      type: 'object',
      properties: {
        notation: { type: 'string', description: '骰子表达式，如 "1d100"、"2d6"。默认 1d100。' }
      }
    },
    async execute(ctx, args) {
      const notation = String(args?.notation || '1d100').trim().toLowerCase();
      const m = notation.match(/^(\d{1,2})d(\d{1,4})$/);
      if (!m) return { content: `看不懂这个表达式：${notation}。请用 NdM 形式，如 1d100。`, isError: true };

      const count = Math.max(1, Math.min(10, Number(m[1])));
      const sides = Number(m[2]);
      if (sides > Math.max(2, Number(cfg().maxSides) || 100)) {
        return { content: `面数超过设置上限（${cfg().maxSides}），换小一点。`, isError: true };
      }

      const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
      const total = rolls.reduce((a, b) => a + b, 0);
      const text = `${notation} → ${rolls.join(' + ')}${count > 1 ? ` = ${total}` : ''}`;

      if (cfg().announce !== false) {
        try {
          await ctx.sender.sendTextBatch(ctx.chatKey, [text]);
          ctx.session?.sent?.push({ type: 'text', text, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          return { content: `已把结果发到群里：${text}。不要再复述一遍。` };
        } catch (error) {
          return { content: `发送失败：${error?.message ?? error}`, isError: true };
        }
      }
      return { content: text };
    }
  });
}
```

这个示例覆盖了：配置读取、参数校验、`isError` 返回、走 `ctx.sender` 发送、发完不重复复述、提示词片段。

---

## 相关文档

交给 AI 时的附加文档选择见文首的「📎」一节。

- [plugin-development.md](./plugin-development.md) —— 确定性型插件开发（能力 / 钩子）
- [skill-reference.md](./skill-reference.md) —— 共同机制完整参考（清单、生命周期、能力系统、ctx 全量字段、硬约束清单）
- [snowluma-capabilities.md](./snowluma-capabilities.md) —— 协议端 73 个接口的逐条参数表
- [skill-system.md](./skill-system.md) —— 架构总览
