# QQ Agent 扩展开发 · 共同机制参考

> ## ⚠️ 想写一个新扩展？先看这两份，按类型二选一
>
> | 你要做的东西 | 放哪 | 开发文档 |
> |---|---|---|
> | **LLM 型** —— 注册工具，模型决定什么时候用（计算、查询、生成……） | `skills/` | **[skill-development.md](./skill-development.md)** |
> | **确定性型** —— 提供能力/钩子，满足条件必然触发（拦截、适配、转发、转写……） | `plugins/` | **[plugin-development.md](./plugin-development.md)** |
>
> 判据只有一句：**规则能写死 → 确定性型（插件）；要理解人话 → LLM 型（技能）**。
> 选错类型的后果是**功能静默失效**（不报错、不崩、就是没反应），所以这两份文档请务必先读。
>
> **本文是两型共用的机制手册**：清单字段、生命周期、能力系统、状态判定、OneBot 接口、
> 上架流程、硬约束、失败排查。两型在这部分完全一致，所以不再重复。
>
> ---
>
> **这份文档的用途**：把开发一个扩展可能接触到的所有共同机制集中在一个文件里。
>
> **主要读者是 AI**：可以把整份文件作为上下文交给 AI，让它直接产出可用的扩展。
> 因此本文密度优先、不铺垫。所有内容**以源码为准逐项核实**（核实日期 2026-09-14）。
> 未在源码确认的内容会标注「未确认」，不做推测。

---

## 目录

- [0. 最小可用模板（先看这个）](#0-最小可用模板先看这个)
- [1. Skill 是什么、放在哪、怎么生效](#1-skill-是什么放在哪怎么生效)
- [2. 清单文件 skill.json](#2-清单文件-skilljson)
- [3. 入口文件 index.js 的模块导出](#3-入口文件-indexjs-的模块导出)
- [4. setup(api) 的 api 对象](#4-setupapi-的-api-对象)
- [5. registerTool 工具定义](#5-registertool-工具定义)
- [6. configSchema 配置项类型](#6-configschema-配置项类型)
- [7. prompt 提示词片段](#7-prompt-提示词片段)
- [8. 能力 capability](#8-能力-capability)
- [9. hooks 钩子](#9-hooks-钩子)
- [10. execute(ctx, args) 的 ctx 全量字段](#10-executectx-args-的-ctx-全量字段)
- [11. 状态、错误码与工具可用性判定链](#11-状态错误码与工具可用性判定链)
- [12. 命令速查](#12-命令速查)
- [13. 上架到 Skill 市场](#13-上架到-skill-市场)
- [14. 硬约束清单（AI 生成时必须遵守）](#14-硬约束清单ai-生成时必须遵守)
- [15. 常见失败对照表](#15-常见失败对照表)
- [16. 完整示例](#16-完整示例)
- [17. 两型语义与术语](#17-两型语义与术语)

---

## 0. 最小可用模板（先看这个）

一个新 Skill = 一个目录 + 两个文件。

```
skills/my-skill/
├── skill.json      # 清单
└── index.js        # 入口
```

**skill.json**

```json
{
  "id": "my-skill",
  "name": "我的技能",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "一句话说明这个技能做什么",
  "enabledByDefault": true
}
```

**index.js**

```js
export function setup(api) {
  api.registerTool({
    id: 'run',
    name: '我的技能',
    description: '这里写清楚「做什么」和「什么时候用」，模型靠这句话决定要不要调用。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string', description: '输入内容' } },
      required: ['input']
    },
    async execute(_ctx, args) {
      const input = String(args?.input ?? '').trim();
      if (!input) return { content: '缺少 input 参数', isError: true };
      try {
        return { content: `处理结果：${input}` };
      } catch (error) {
        return { content: `失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}
```

> 也可以用脚手架生成：`npm run new:skill my-skill -- --name "我的技能" --category utility`
> 生成的是**可运行骨架**（含工具/能力/配置/提示词片段/自检/hook 各一个最小实现）。

### 0.1 AI 应该产出哪些文件

**必须产出的只有 2 个：**

| 文件 | 作用 | 不写会怎样 |
|---|---|---|
| `skills/<id>/skill.json` | 清单 | 加载失败（`缺少 skill.json / plugin.json`） |
| `skills/<id>/index.js` | 入口：`setup(api)` + 工具 | 清单能读但模型没有任何工具可用 |

**以下是可选，按需产出：**

| 文件 | 什么时候要 |
|---|---|
| `skills/<id>/README.md` | 给人看的说明。**加载器不读它**，删掉也不影响运行（脚手架会顺手生成） |
| `skills/<id>/lib/xxx.js` | 代码拆分成多个文件时，放这个技能自己的子目录里 |
| `test/<name>-test.mjs` | 想加自动化测试（见 16.4）。**放 `test/`，不要放进技能目录** |

**目录结构约束（易错）：**

- 加载器**只扫描一级子目录**（`skills/*/`），**不递归**。
  ⚠️ 所以**不要建 `skills/shared/`、`skills/lib/` 这类"共享目录"** —— 它会被当成一个 Skill
  去加载，然后因为缺 `skill.json` 而报错。共用代码请放在**某个技能内部**的 `lib/` 下：
  ```
  skills/my-skill/lib/helper.js     ✅ 正确（在技能内部）
  skills/shared/helper.js           ❌ 会被当成一个 Skill 加载并失败
  ```
- 技能目录里**不要**放：`node_modules/`、`data/`、API Key 等敏感文件、`entry.json`
  （`entry.json` 是**服务端**的市场元数据，上传时由服务端生成，手写它没有意义）。
- 一个技能 = 一个目录，目录名建议与 `id` 一致（不一致时以 manifest 的 `id` 为准）。

### 0.2 AI 不需要动的文件（别多手）

| 文件 | 谁写 | 说明 |
|---|---|---|
| `data/config.json` 里的 `skills.<id>` | **程序自动** | 用户改开关/设置时才写入。AI 不要去手改配置文件 |
| `data/community/skills/<id>/{entry.json,...}` | **服务端自动** | 上架时生成，并缓存打包好的 zip |
| `src/*.js`（加载器、工具注册、能力系统） | 人工 | **加 Skill 不需要改核心代码**。Skill 通过能力名被核心取用，不是核心来 import 你 |
| `ui/*.js`（控制台前端） | 人工 | 设置页表单由 `configSchema` 自动渲染，不需要写前端 |

> 换句话说：**写一个 Skill = 新建一个目录 + 两个文件，零侵入。**
> 如果你发现"必须改 `src/` 才能实现"，那多半是方向错了 —— 先确认是不是该用
> 能力（`providers`）或钩子（`hooks`），它们本就是为"不侵入核心"设计的。

---

## 1. Skill 是什么、放在哪、怎么生效

### 1.1 概念

Skill = **可插拔能力模块**。核心代码通过**能力名（capability）**依赖 Skill，而不是通过 Skill 名字硬编码，
所以替换实现不需要改核心代码。

一个 Skill 可以提供四种东西：

| 提供什么 | 机制 | 核心怎么用 |
|---|---|---|
| 工具（tool） | `api.registerTool()` | 交给模型，模型决定调用 |
| 能力（capability） | `providers` 导出 | 核心按能力名取提供者调用 |
| 提示词片段 | `skill.json` 的 `prompt.sections` | 拼进系统提示词 |
| 行为钩子 | `hooks` 导出 | 在固定时机被调用 |

> ⚠️ 这四者的「决定权」不同：工具和提示词片段是**交给 LLM 决定**，
> 能力和钩子是**核心代码确定性触发**。选错机制会出现"装了但一直不生效"。
> 详见 [1.7 三种机制怎么选](#17-三种机制怎么选重要)。

**能操作 QQ 到什么程度？** 通过 `ctx.onebot.call()` 可触达协议端的**全部 73 个 OneBot 接口**
（发消息、撤回、禁言、踢人、群文件、群相册、空间说说、语音转文字……）。
完整清单见 [10.2.2](#1022-可用接口全表按分类)。

### 1.2 放置位置

两个目录都会被扫描。**区别是语义分类，不是格式新旧**：

| 目录 | 含义 | 清单文件名 | 入口函数名 |
|---|---|---|---|
| `plugins/<id>/` | **确定性型**：提供能力（`providers`）/ 钩子（`hooks`）。满足条件必然执行，不经过 LLM | `plugin.json` | `setup(api)`（或 `register(api)`） |
| `skills/<id>/` | **LLM 型**：注册工具（`registerTool`）+ 提示词片段。模型决定何时用 | `skill.json` | `setup(api)` |

两种清单文件走同一条 `normalizeManifest`，**功能完全等价** —— 都支持
`capabilities` / `requires` / `hooks` / `providers` / `prompt` / `settings` / `configSchema`。
所以放哪个目录只决定"它什么时候会被执行"，不限制能用哪些特性。

- 该做哪一型、以及判据 → [plugin-development.md §0](./plugin-development.md#0-一句话判断该不该做确定性型)
- 两型的完整开发指南 → [plugin-development.md](./plugin-development.md) / [skill-development.md](./skill-development.md)

加载器会做**两型归位校验**（`lintKindPlacement`）：放错目录只警告、不阻断加载，
因为后果很隐蔽（功能静默失效）。

> ⚠️ `tools[]` 在清单里只是说明性元数据，加载器不消费。工具必须在入口里 `registerTool` 注册，
> 否则会警告"清单里有工具但入口没注册"。

### 1.3 加载 → 生效 全流程

```
① 启动时扫描 skills/ 与 plugins/ 下的一级子目录
        ↓
② 读清单（优先 skill.json，其次 plugin.json；UTF-8 BOM 会被自动剥离）
        ↓
③ 校验清单 → normalizeManifest() 补默认值 + 收集 problems
        ↓
④ 动态 import 入口文件；调用 setup(api) 完成工具注册
        ↓
⑤ 状态四层判定（见 1.4）
        ↓
⑥ active 的 Skill 执行 activate()；其工具进入可用工具集，提示词片段进入系统提示词
        ↓
⑦ 会话运行时：工具可被模型调用；钩子在对应时机被触发
        ↓
⑧ 用户在控制台「技能」页改开关 → deactivate()；卸载 → dispose() + 工具自动回收
```

**加载失败不会拖垮启动**：单个 Skill 的 problem 只记录并让它下线，启动继续。
`GET /api/skills` 能看到每个 Skill 的 `code` + `reason`。

### 1.4 状态模型（四层）

```
loaded     代码是否加载成功
enabled    用户开关（config.skills[id].enabled，缺省取 manifest.enabledByDefault）
available  依赖是否满足（requires 声明的能力 + Skill 自己的 available()）
active     最终是否生效 = loaded && enabled && available
```

### 1.5 配置落盘位置

用户改过的开关与设置存在 `config.skills[id]`：

```jsonc
{
  "skills": {
    "my-skill": { "enabled": true, "前缀": "...", "其它设置项": "..." }
  }
}
```

**默认值来自各 Skill 的 `settings`**；`config.skills` 里只存用户改过的值。
改设置后**不需要重启**，下次执行读到新值。

### 1.6 热重载

```bash
QQ_AGENT_DEV=1 npm run server
```

- 监听 `skills/` 与 `plugins/`（递归），文件变化后 **500ms 防抖**重扫。
- 重载后会**重跑 activate + 刷新工具定义**，所以不需要重启进程。
- **生产环境（不设 `QQ_AGENT_DEV=1`）没有热重载**，改完必须重启。
- 删除目录会在重扫时把对应 Skill 卸掉（清理幽灵残留）。

### 1.7 三种机制怎么选（重要）

一个 Skill 能提供四种东西，但**决定权在谁手上**完全不同。这是设计时第一个要想清楚的问题：

| 机制 | 谁决定「什么时候生效」 | 是否注入提示词 | 写起来 |
|---|---|---|---|
| **工具** `registerTool` | **LLM 决定**（模型自己判断该不该调） | ❌ 走 OpenAI `tools` 参数，**不进 prompt 文本** | 4.x / 5 章 |
| **提示词片段** `prompt.sections` | **LLM 决定**（读到了，自行决定遵不遵守） | ✅ 真的进 prompt 文本 | 7 章 |
| **能力** `providers` | **核心代码决定**（按能力名取，满足条件一定调用） | ❌ 完全不经过 LLM | 8 章 |
| **钩子** `hooks` | **核心代码决定**（固定时机一定触发，可否决） | ❌ 不经过 LLM | 9 章 |

**怎么选**：

- 要「**满足条件一定发生**」（拦截、改写、跳过、统计）→ 用**能力**或**钩子**。这是确定性的，LLM 无法阻止也无法忽略。
- 要「**让模型自己判断该不该做**」（查天气、算数、翻译）→ 用**工具**。
- 只是「**想让它的说话方式变一变**」→ 用**提示词片段**。

> ⚠️ 常见误解：以为注册了工具就等于"装上了功能"。
> 实际上**工具只是给模型递了一张名片** —— 模型可能一直不用它。
> 需要"一定会执行"的逻辑，必须走能力或钩子。

### 1.8 ⚠️ 自建能力名，核心不认识

上面说"能力由核心代码消费"，但**核心只消费它写死的那几个能力名**。
你新造一个 `my-tool.convert`，核心不会知道要去调它 —— 只有**别的 Skill** 会通过
`api.capability('my-tool.convert')` 软依赖来找你。

所以：

| 你的目标 | 该用什么 | 原因 |
|---|---|---|
| 让模型能用一个新功能 | **必须 `registerTool`** | 只有工具会进模型的 `tools` 列表 |
| 给别的 Skill 提供可复用的实现 | `providers` | 对方按能力名软依赖你 |
| 实现某个**核心已在找**的标准能力 | `providers` | 核心会主动来找（见 8.4 的清单） |

**核心当前实际消费的能力名（14 个，已核对源码）**：

```
video.frames              video-reader.js
chat.ban-state            orchestrator.js
message.owner-check       orchestrator.js
message.speaker-format    prompt.js
message.inline-at-normalize  onebot.js
image.mime-support        tools.js
model.thinking-detect     routes.js
llm.endpoint-pick         llm.js
llm.endpoint-feedback     llm.js
llm.request-params        manager → llm.js
llm.response              manager → llm.js
llm.usage                 manager → llm.js
llm.retry-advisor         manager → llm.js
tool.guard                manager → tool-registry.js
```

> 📌 **换句话说：想接入 LLM，只有一条路 —— 注册工具。**
> 能力机制是给"核心已经认识的扩展点"和"Skill 之间复用"用的。
> 如果你写了个只有 `providers` 的 Skill，它对着模型是**完全隐形**的。

### 1.9 本项目的实际约定（观测结果）

| | `skills/`（12 个） | `plugins/`（3 个） |
|---|---|---|
| 注册工具数 | **0** | **4** |
| 提供能力 | 全部 12 个都有 | 无 |
| 提示词片段 | 部分有 | 全部有 |

30 个工具里 26 个来自核心 `src/tools.js`，4 个来自 `plugins/` 下的旧插件。也就是：

> **核心提供工具（模型看到的 API 面），技能提供能力的实现（背后插拔）。**

好处：工具面由核心统一策划（命名、参数风格、数量可控）；技能在背后插拔实现 ——
换掉抽帧实现不需要改核心，也不需要改提示词。

> ⚠️ 注意这是**约定，不是代码强制**。加载器对 `skills/` 与 `plugins/` 一视同仁，
> 两种格式都能注册工具、也都能导出 hooks/providers。
> **新写的一律放 `skills/`，机制按需选** —— 需要模型能用就注册工具，这一步不能省。

> 注意这只是**约定，不是代码强制**：加载器对 `skills/` 与 `plugins/` 一视同仁，
> 两种格式都能注册工具、也都能导出 hooks/providers。新写的一律放 `skills/`，机制按需选。

---

## 2. 清单文件 skill.json

### 2.1 字段全表

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | string | **是** | 目录名 | 唯一标识，只允许 `[a-zA-Z0-9._-]` 且以字母/数字开头 |
| `name` | string | 否 | `id` | 显示名 |
| `version` | string | 否 | `0.0.0` | 版本号 |
| `apiVersion` | number | 否 | `1` | 大于 1 会记 problem（不致命） |
| `category` | string | 否 | `utility` | **只能是** `model` / `message` / `knowledge` / `media` / `utility`；其它值记 problem 并回退 `utility` |
| `description` | string | 否 | `''` | 一句话说明，设置页展示 |
| `author` | string | 否 | `''` | 作者 |
| `enabledByDefault` | boolean | 否 | `true` | 用户没配置过时的默认开关 |
| `capabilities` | string[] | 否 | `[]` | 本 Skill **提供**的能力名 |
| `requires` | string[] | 否 | `[]` | 本 Skill **依赖**的能力名（写进自己 capabilities 的会被自动移除） |
| `settings` | object | 否 | `{}` | 各项设置的默认值（必须是非数组对象） |
| `configSchema` | object | 否 | `{}` | 配置项声明（决定设置页表单，也是写入白名单） |
| `prompt` | object | 否 | `null` | 提示词片段，见第 7 节 |
| `permissions` | string[] | 否 | `[]` | 权限声明，目前只有 `web_fetch` 有效 |
| `deprecated` | boolean | 否 | `false` | 标记弃用（仍加载，UI 提示） |

### 2.2 校验行为（重要）

校验是**宽松**的：不会"一个 Skill 写错就拒绝启动"，而是收集 `problems`：

| 情况 | problems 内容 | 是否致命 |
|---|---|---|
| manifest 不是对象 | `manifest 不是对象` | **致命**（不加载） |
| 缺 `id` | `缺少 id` | **致命**（不加载） |
| `id` 含非法字符 | `id 只能包含字母/数字/._-（当前：xxx）` | **致命**（不加载） |
| `apiVersion` 过高 | `apiVersion N 高于当前支持的 1` | 否 |
| `category` 非法 | `category 非法（xxx），已回退为 utility` | 否 |

### 2.3 命名规则

- `id`：✅ `weather-query`、`my_skill_2`、`a.b` ❌ `Weather Query`、`天气`、`-start`
- 目录名与 `id` 不一致时，**以 manifest 为准**。

---

## 3. 入口文件 index.js 的模块导出

全部可选，按需导出：

| 导出 | 类型 | 何时调用 | 说明 |
|---|---|---|---|
| `setup(api)` | function | 加载时一次 | **注册入口**。`register(api)` 是等价的旧写法，仍支持 |
| `activate(ctx)` | function | Skill 变为 active 时 | 建立定时器/监听的地方 |
| `deactivate(ctx)` | function | Skill 被关闭时 | **必须清干净**，否则留幽灵行为 |
| `dispose()` | function | 卸载时 | 工具会被自动回收 |
| `available(ctx)` | function | 可用性判定时（**同步调用链**） | 返回 `false` 或 `{ok:false, reason}` 表示依赖不满足 |
| `promptSections(ctx)` | function | 组装提示词时 | 动态提示词片段，见 7.3 |
| `hooks` | object | 各时机 | `{ '钩子名': fn }`，见第 9 节 |
| `providers` | object | 取能力提供者时 | `{ '能力名': fn }`，见第 8 节 |

### 3.1 ⚠️ `available()` 必须同步

可用性判定（`isActive` / `getToolAvailability`）走的是**同步调用链**。
`available()` 返回 Promise 会被当成"可用"（Promise 是 truthy），
表现为**界面显示"生效中"但实际跑不通**。

需要异步探测（如 spawn 一个 ffmpeg 看装没装）时，用「**首次乐观放行 + 后台探测 + 缓存结果**」：

```js
let ffmpegOk = null;          // null = 还没探测出结果
let probing = false;

export function available() {
  if (ffmpegOk === null && !probing) {
    probing = true;
    probeFfmpeg().then((ok) => { ffmpegOk = ok; }).catch(() => { ffmpegOk = false; });
  }
  if (ffmpegOk === false) return { ok: false, reason: '未找到 ffmpeg' };
  return true;                // 首次乐观放行
}
```

真实参考实现：`skills/video-frames/index.js`。

---

## 4. setup(api) 的 api 对象

`setup(api)` 收到的 `api` 对象**完整方法表**（源码：`src/plugin-loader.js` 的 `createSkillApi` 函数）：

| 方法 | 签名 | 说明 |
|---|---|---|
| `registerTool` | `(def) => string` | 注册工具，返回实际注册的 id（已加前缀）。缺 `id` 会抛错 |
| `config` | `() => object` | 读本 Skill 配置（`settings` 默认值已合并）。**先存起来，后续每次执行时读** |
| `isSkillActive` | `(id, ctx?) => boolean` | 查询**别的** Skill 是否生效 |
| `capability` | `(name, args?) => any` | **软依赖**：问"谁提供这个能力"，有就调用并返回结果，没有则返回 `undefined` |
| `hasCapability` | `(name) => boolean` | 该能力是否有真实提供者 |
| `log` / `warn` / `error` | `(...args) => void` | 带 `[skill:<id>]` 前缀的日志 |
| `fetch` | `(url, options) => Promise<Response>` | **仅当清单声明 `permissions: ["web_fetch"]` 时可用**；否则调用即 reject `Skill xxx 未声明 web_fetch 权限` |
| `utils.sleep` | `(ms) => Promise` | 延时 |
| `utils.safeJsonParse` | `(text, fallback?) => any` | 安全 JSON 解析，失败返回 fallback |

### 4.1 ⚠️ `setup` 阶段拿不到的东西

`setup(api)` 时**没有** QQ 接口、没有会话上下文、没有 store/memory。
要做这些事，必须在**工具执行时**通过 `execute(ctx, args)` 的 `ctx` 拿（见第 10 节）。

### 4.2 配置读取的标准写法

```js
let cfg = () => ({});

export function setup(api) {
  cfg = api.config;                 // 记住函数
  api.registerTool({
    id: 'run', name: 'x', description: 'x',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const { prefix = '', verbose = false } = cfg();   // 每次执行时读一次
      return { content: verbose ? `${prefix}:详细` : `${prefix}:简略` };
    }
  });
}
```

> ⚠️ 别在 `setup` 时调一次 `cfg()` 把值存成普通变量 —— 那样用户改设置后不会生效。

---

## 5. registerTool 工具定义

### 5.1 字段表

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | **是** | 工具短名。**缺了直接抛错** |
| `name` | 是 | 显示名 |
| `description` | 是 | **给模型看的说明，决定它会不会调用。必须写清「做什么」+「什么时候用」** |
| `parameters` | 是 | 参数的 JSON Schema（见 5.3） |
| `execute` | 是 | `async (ctx, args) => ({ content, isError? })` |
| `category` | 否 | 工具分类，影响「分类开关」判定。常见值：`messaging` / `sticker` / `query` / `memory` / `web` / `knowledge` / `media` / `system` |
| `icon` | 否 | emoji 图标 |
| `defaultEnabled` | 否 | 默认是否启用。`false` 时用户需手动开 |
| `requires` | 否 | 依赖的能力名数组（工具级别的能力依赖） |
| `requiresVision` | 否 | `true` 时，当前模型不支持图片则工具不可用 |
| `requiresSearch` | 否 | `true` 时，联网搜索关闭则工具不可用 |

### 5.2 ⚠️ 工具 id 的三条硬规则

1. **自动加前缀**：注册后变成 `<skillId>__<toolId>`（**双下划线**）。
   你在 `def.id` 里只写短名；`execute` 里也不用关心前缀。
2. **字符白名单**：只允许 `[a-zA-Z0-9_-]`，其它字符会被替换成 `_`。
3. **长度**：`skillId` 截断到 24 字符，`toolId` 截断到 38，加 `__` 后总长 ≤ 64。

> ⚠️ **绝对不要用 `:` 或 `.` 拼接 id**。这个 id 会成为发给模型的 OpenAI function name，
> 严格端点（DeepSeek / OpenAI 官方）会以 `400 invalid function name` **拒掉整个请求** ——
> 不是你的工具失效，而是这次对话整个失败。

**撞名**：sanitize + 截断后与其他 Skill 的工具重名时，后加载者覆盖先加载者，控制台打告警。

### 5.3 parameters 写法

标准 JSON Schema 子集：

```js
parameters: {
  type: 'object',
  properties: {
    text:  { type: 'string',  description: '要处理的文本' },
    count: { type: 'number',  description: '数量，1~10，默认 1' },
    force: { type: 'boolean', description: '是否强制' },
    mode:  { type: 'string',  enum: ['fast', 'full'], description: '模式' }
  },
  required: ['text']
}
```

要点：
- 每个参数都要写 `description`，模型才能填对。
- `required` 里没列的参数要准备默认值。
- 参数名建议用英文小写。

### 5.4 execute 的返回值

```js
// 成功（文本）
return { content: '给模型看的结果文本' };

// 成功（多模态：parts 数组，媒体会被拆出来单独补发）
return { content: [
  { type: 'text', text: '这是说明' },
  { type: 'image_url', image_url: { url: 'https://...' } }
] };

// 失败
return { content: '出错说明', isError: true };
```

- `content` 是**给模型看的资料**，不是直接发给群友的话。
- `isError: true` 时，`content` 会作为错误信息回给模型。
- 抛出的异常会被外层兜住并转成 `{content: '错误：...', isError: true}`，
  但**建议自己 try/catch 并返回人话**。

---

## 6. configSchema 配置项类型

设置页表单**完全按 `configSchema` 渲染，前端不硬编码任何字段名**。

| `type` | 渲染成 | 额外字段 |
|---|---|---|
| `boolean` | 复选框 | — |
| `number` | 数字输入框 | `min` / `max` / `step` |
| `enum` | 下拉菜单 | **必须** `options: [{value, label}]` |
| `string` | 文本框 | `multiline: true` 时占整行 |
| `internal` | **不渲染** | 列表/对象类字段，弹窗里只提示"去哪改" |

通用字段：
- `label`：标题
- `description`：标题下的灰色说明（描述较长时字段自动占整行）
- `default`：默认值
- `secret: true`：密码框。**对外视图脱敏成 `******`，用户提交空串或 `******` = 不修改**

### 6.1 写入白名单

**只有 `configSchema` 里声明过的键才会被 HTTP 接口写进配置。**
`settings` 里声明但 `configSchema` 没声明的项，用户在设置页看不到、也存不进去。

### 6.2 secret 字段的完整语义

| 场景 | 行为 |
|---|---|
| UI 读取设置 | 显示 `******` |
| 用户提交 `******` 或空串 | **不修改**，保持原值 |
| Skill 代码 `api.config()` 读到 | **明文** |
| 用户填了新值 | 写入新值 |

---

## 7. prompt 提示词片段

### 7.1 静态片段（写在清单里）

```json
"prompt": {
  "sections": [
    { "id": "my-note", "title": "我的技能", "priority": 40, "content": "规则正文" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识（同 id 后者覆盖前者） |
| `title` | 小标题 |
| `content` | 正文（**空的会被过滤掉**） |
| `priority` | 数字越大越靠前。**被强制压到 99 以内**（核心安全规则恒为 100+） |

兼容写法：只写 `prompt.instruction` 会自动转成一个 `id: 'main'`、`priority: 50` 的片段。

### 7.2 注入规则

- 片段一律排在**核心系统提示词之后**。
- Skill **不可能**覆盖安全规则、工具协议等核心约束。
- 收集时按 `priority` **降序**排列；同 `id` 去重，后写覆盖先写。
- 注入的片段对象会带上 `skillId` 字段。

### 7.3 动态片段（`promptSections` 导出）

```js
export function promptSections(ctx) {
  return [{ id: 'dyn', title: '动态', priority: 40, content: `当前群：${ctx.chatName ?? ''}` }];
}
```

- 返回数组，元素结构同静态片段。
- `priority` 同样被压到 99 以内，默认 40。
- 抛错只记日志，不影响主流程。

### 7.4 写作建议

- 每次对话都会带上，**别写长**（写 3000 字 = 每次都多花 token）。
- 写清楚**触发时机**和**输出风格要求**。
- 别放安全指令（放了也没用）。

---

## 8. 能力 capability

### 8.1 双向声明

| 角色 | 清单里 | 代码里 |
|---|---|---|
| **提供方** | `"capabilities": ["my.cap"]` | `export const providers = { 'my.cap': fn }` |
| **使用方（硬依赖）** | `"requires": ["my.cap"]` | — |
| **使用方（软依赖）** | 不用声明 | `api.capability('my.cap', args)` |

### 8.2 硬依赖 vs 软依赖

| | 硬依赖 `requires` | 软依赖 `api.capability()` |
|---|---|---|
| 缺了会怎样 | 本 Skill 判定为**不可用**，UI 显示"依赖未就绪" | 拿到 `undefined`，本 Skill **照常工作** |
| 适用场景 | 缺了就没法工作 | 锦上添花、可选增强 |

**选择原则**：能用软依赖就别用硬依赖（少一个模块就整块失效，体验很差）。

### 8.3 多提供者

绝大多数能力**约定只有一个提供者**（`getCapabilityProviders` 取第一个）。
以下能力**允许多个提供者**（源码里的 `MULTI_PROVIDER_CAPABILITIES`）：

```
llm.request-params
llm.response
llm.usage
llm.retry-advisor
tool.guard
```

### 8.4 已知标准能力名

| 能力名 | 提供者返回 | 消费方 |
|---|---|---|
| `llm.request-params` | `{ body, omitTemperature? }` | `src/llm.js` 改写请求体 |
| `llm.response` | `{ result }` | `src/llm.js` 加工响应 |
| `llm.usage` | `{ [字段]: 数值 }` | `src/llm.js` 附加统计 |
| `llm.retry-advisor` | `{ body, reason }` 或 `null` | `src/llm.js` 决定是否降级重试 |
| `tool.guard` | `true` / `false` / `{ok:false,reason}` | `tool-registry` 运行期否决 |
| `message.speaker-format` | 字符串标签 | 发言链路 |
| `message.inline-at-normalize` | 规范化后的文本 | 发言链路 |
| `video.frames` | `{ frames, times, error? }` | 视频理解链路 |
| `video.frames.available` | `{ ok, reason }` | 视频路由判定 |
| `media.transcribe` | 转写结果 | 语音理解 |
| `chat.ban-state` | 禁言状态 | 运行前跳过 |
| `message.owner-check` | 是否主人 | 主人专属逻辑 |
| `sticker.annotate` / `sticker.annotate-batch` | 表情标注 | 表情库 |
| `image.random` | 随机图 | 图片工具 |
| `media.download.bilibili` / `media.download.douyin` | 下载结果 | 视频下载 |
| `llm.endpoint-pick` / `llm.endpoint-feedback` / `llm.endpoint-snapshot` | 端点选择/反馈 | 账号池 |

> 自建能力名建议用「点分层级」格式（如 `my-tool.convert`），避免与内置冲突。

---

## 9. hooks 钩子

### 9.1 全部钩子与载荷

| 钩子 | 触发时机 | 额外载荷字段 | 能做什么 |
|---|---|---|---|
| `before-context` | 组装提示词之前 | — | 加工触发消息、补充上下文 |
| `before-llm-messages` | 消息即将发给模型 | `messages`（可原地修改） | 改要发出去的消息 |
| `after-response` | 收到模型响应后 | `response`, `session` | 加工响应、记录信息 |
| `before-tool` | 工具执行之前 | `toolName`, `argsRaw`, `session` | **返回 `{block:true, reason}` 可否决这次调用** |
| `after-tool` | 工具执行之后 | `toolName`, `argsRaw`, `result`, `session` | 统计、加工结果 |

### 9.2 公共载荷字段（源码里的 `skillContext`）

```
chatKey, kind, chatId, chatName,
model, provider,
visionEnabled, searchEnabled, proactive,
sessionId
```

### 9.3 hook 执行规则

- **只对 `active` 的 Skill 执行**（未生效的 Skill 的 hook 不会被调用）。
- 调用签名：`fn(context, { skillId })`。
- **超时 5 秒**（`hookTimeoutMs = 5000`），超时抛 `skill-timeout`。
- **错误隔离**：一个 Skill 抛错只记日志，不影响其它 Skill 和主流程。
- 返回值：返回 `undefined` 不记录；返回其它值会被收集为 `{ skillId, value }`。
- `before-tool` 的否决只是**拒绝这一次调用**，不会绕过发送队列/限频/存档。

### 9.4 钩子里的禁令

- ❌ 不能自己发请求
- ❌ 不能自己重试
- ❌ 不能自己发消息

钩子只适合轻量加工。重活请在工具里干。

### 9.5 写法

```js
export const hooks = {
  'before-tool': ({ toolName, argsRaw }) => {
    if (toolName === 'my-skill__danger' && !isAllowed(argsRaw)) {
      return { block: true, reason: '当前条件下不允许执行' };
    }
  },
  'after-tool': ({ toolName }) => { /* 统计 */ }
};
```

---

## 10. execute(ctx, args) 的 ctx 全量字段

`ctx` 由 orchestrator 构造（源码：`src/orchestrator.js` 里 `const ctx = {` 处）。**完整字段表**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `ctx.chatKey` | string | 会话标识，格式 `group:<群号>` 或 `private:<QQ号>` |
| `ctx.kind` | string | `'group'` 或 `'private'` |
| `ctx.chatId` | string | 群号或 QQ 号 |
| `ctx.selfId` | string | 机器人自己的 QQ 号 |
| `ctx.selfNickname` | string | 机器人自己的昵称 |
| `ctx.botName` | string | 人设里配置的机器人名字 |
| `ctx.onebot` | object | OneBot 客户端，见 10.2 |
| `ctx.store` | object | 消息存档，见 10.3 |
| `ctx.memory` | object | 长期记忆，见 10.4 |
| `ctx.stickers` | object | 表情包管理，见 10.5 |
| `ctx.sender` | object | 发送器，见 10.6 |
| `ctx.session` | object | 当前会话对象，见 10.7 |
| `ctx.reminders` | object | 定时提醒，见 10.8 |
| `ctx.videoReader` | object | 视频理解路由，见 10.9 |
| `ctx.emit` | function | `(type, payload) => void`，向控制台推事件 |

### 10.1 execute 的第二个参数 args

`args` 是按 `parameters` schema 解析后的对象。若模型给的 JSON 不合法，
外层直接返回错误，`execute` 不会被调用。**仍需自己校验参数**（模型可能给空值/越界值）。

### 10.2 `ctx.onebot` 方法

这是**与 QQ 通信的唯一通道**。分两类：客户端已封装的便捷方法，以及走 `call()` 的通用透传。

**已封装的便捷方法：**

| 方法 | 说明 |
|---|---|
| `sendText(kind, id, text, options?)` | 发文本（底层，一般用 `ctx.sender` 更好） |
| `sendImage(kind, id, file, options?)` | 发图片 |
| `sendSticker(...)` | 发表情 |
| `sendPoke(...)` | 戳一戳 |
| `sendSegments(kind, id, segments, options?)` | 直接发消息段数组 |
| `getGroupInfo(groupId)` | 查群资料 |
| `getGroupMemberInfo(groupId, userId)` | 查群成员资料 |
| `getMsg(messageId)` | 查消息详情 |
| `call(action, params?, timeoutMs?)` | **通用调用**，见 10.2.1 |
| `selfId` / `selfNickname` | 属性：机器人自己的 QQ 号 / 昵称 |

**⚠️ 优先用 `ctx.sender` 而不是直接 `ctx.onebot` 发消息。**
`sender` 内置了发送队列（按会话串行）、限频、去重、真人式停顿；
绕过它直发会破坏节奏控制，容易被风控或刷屏。

#### 10.2.1 `call()` —— 73 个 OneBot 接口全部可达

`call(action, params, timeoutMs = 15000)` 是**纯透传**：直接
`POST {httpUrl}/{action}`，**没有 action 白名单**。也就是说协议端支持的所有接口，
Skill 都能调。签名：

```js
// 返回值 = OneBot 响应里的 data 字段
const data = await ctx.onebot.call('set_group_ban', { group_id: 123, user_id: 456, duration: 600 });
```

**⚠️ 两个必须知道的点：**

1. **失败会抛错**：HTTP 非 2xx，或响应 `retcode !== 0`，都会 `throw`。
   所以**必须 try/catch**，否则整个工具执行失败。
2. **没有白名单 = 没有护栏**：写操作（禁言/踢人/撤回/发说说）一旦调用就真的生效。
   请自行加权限判断。

#### 10.2.2 可用接口全表（按分类）

**只读接口**（只查数据、不改状态，可放心频繁调用）：

| 分类 | 接口 |
|---|---|
| 信息 | `get_login_info`（登录号与昵称）、`get_status`、`get_version_info`、`can_send_image`、`can_send_record` |
| 好友 | `get_friend_list`、`get_stranger_info` |
| 群信息 | `get_group_list`、`get_group_info`、`get_group_member_list`、`get_group_member_info` |
| 消息 | `get_msg`、`get_group_msg_history`、`get_friend_msg_history` |
| 媒体 | `get_image`、`get_record`、`fetch_ptt_text`（语音转文字） |
| 群相册 | `get_group_album_list`、`get_qun_album_list`、`get_group_album_media_list` |
| 空间 | `get_qzone_msg_list`、`get_qzone_feeds` |
| 群管理 | `get_group_admin_settings` |
| 群文件 | `get_group_file_url`、`get_group_root_files`、`get_group_files_by_folder` |
| 系统表情 | `fetch_sys_faces`、`fetch_face_entity`、`search_sys_faces` |
| 扩展 | `get_essence_msg_list`、`_get_group_notice`、`get_cookies` |

**写操作接口**（会改 QQ 状态，用之前想清楚后果）：

| 分类 | 接口 |
|---|---|
| 消息 | `send_msg`、`send_private_msg`、`send_group_msg`、`delete_msg`（撤回） |
| 群管理 | `set_group_kick`、`set_group_kick_members`（批量踢）、`set_group_ban`（`duration=0` 解除）、`set_group_whole_ban`（全员禁言开关）、`set_group_admin`（设/撤管理）、`set_group_card`（群名片，空串清除）、`set_group_add_option` |
| 请求处理 | `set_friend_add_request`（同意/拒绝加好友）、`set_group_add_request`（同意/拒绝加群） |
| 文件 | `upload_group_file`、`upload_private_file` |
| 互动 | `send_like`（点赞）、`friend_poke`、`group_poke`、`send_poke`、`set_group_reaction`（表情回应） |
| 表情 | `add_custom_face`、`delete_custom_face`、`modify_custom_face` |
| 精华消息 | `set_essence_msg`、`delete_essence_msg` |
| 公告 | `_send_group_notice` |
| 已读 | `mark_group_msg_as_read`、`mark_private_msg_as_read`、`mark_msg_as_read` |
| 转发 | `upload_forward_msg` |
| 群相册 | `upload_image_to_qun_album` |
| 空间 | `send_qzone_msg`、`delete_qzone_msg`、`like_qzone` |
| 流式 | `upload_file_stream`、`download_file_stream`、`download_file_image_stream`、`download_file_record_stream` |

> 完整参数表（每个接口的字段、类型、必填）见
> **[snowluma-capabilities.md](./snowluma-capabilities.md)** —— 73 个接口逐条列了参数与返回。
> 那份是协议端能力清单，本文只做"Skill 怎么用"的索引。

#### 10.2.3 消息段类型（`sendSegments` / `upload_forward_msg` 用）

| type | 说明 |
|---|---|
| `text` | 纯文本 |
| `face` | QQ 表情 |
| `image` | 图片 |
| `record` | 语音 |
| `video` | 视频 |
| `at` | @某人 |
| `reply` | 回复某条消息 |
| `forward` | 合并转发 |
| `file` | 文件 |
| `json` / `xml` | 结构化消息 |
| `poke` | 戳一戳 |

#### 10.2.4 写操作的正确姿势

```js
async execute(ctx, args) {
  const groupId = Number(ctx.chatId);
  const userId = Number(args?.userId);

  // 1) 只在群里做群管理
  if (ctx.kind !== 'group') return { content: '这个操作只在群里可用', isError: true };
  // 2) 参数校验
  if (!Number.isInteger(userId) || userId <= 0) return { content: '缺少有效的 userId', isError: true };
  // 3) 加个纪律：不允许对机器人自己或管理员动手（按需自定）
  if (String(userId) === String(ctx.selfId)) return { content: '不能对自己操作', isError: true };

  try {
    // 4) 必须 try/catch —— call 失败会抛错
    await ctx.onebot.call('set_group_ban', {
      group_id: groupId,
      user_id: userId,
      duration: 600            // 秒；0 = 解除禁言
    });
    return { content: `已禁言 ${userId} 10 分钟` };
  } catch (error) {
    return { content: `操作失败：${error?.message ?? error}`, isError: true };
  }
}
```

### 10.3 `ctx.store` 方法

| 方法 | 说明 |
|---|---|
| `recent(chatKey, {limit, before})` | 取最近消息 |
| `getChatMeta(chatKey)` | 会话元信息（总条数、未读等） |
| `listChats()` | 所有会话 key |
| `unreadCount(chatKey)` | 未读数 |
| `peekUnread(chatKey, n)` | 预读未读（不消费） |
| `markAllRead(chatKey)` | 全部标记已读 |
| `findByMid(chatKey, mid)` / `findByLocalId(...)` | 按 id 查消息 |
| `appendIncoming(...)` / `appendSelf(...)` | 追加消息 |
| `activeMembers(chatKey)` | 活跃成员 |
| `muteUnread(chatKey)` / `clearChat(chatKey)` | 静音 / 清空 |

### 10.4 `ctx.memory` 方法

| 方法 | 说明 |
|---|---|
| `query(chatKey, opts)` | 查询印象 |
| `getMember(chatKey, userId)` | 取某成员印象 |
| `listChats()` | 有记忆的会话 |
| `members(chatKey)` | 成员列表 |
| `editMemberImpression(...)` / `replaceMember(...)` | 改印象 |
| `removeMember(...)` / `remove(...)` / `clear(...)` | 删印象 |
| `formatForPrompt(...)` | 格式化成提示词文本 |
| `append(...)` | 追加 |
| `consolidationState(...)` / `markConsolidated(...)` / `replaceConsolidated(...)` | 整理状态管理 |

### 10.5 `ctx.stickers` 方法（StickerManager）

| 方法 | 说明 |
|---|---|
| `list()` | 列出表情库 |
| `find(ref)` | 按引用查表情 |
| `collect(...)` | 收集表情 |
| `sync(...)` | 同步 |
| `note(id, patch)` | 写备注 |
| `markUsed(id, context)` | 记录使用 |

### 10.6 `ctx.sender` 方法

| 方法 | 签名 | 说明 |
|---|---|---|
| `sendTextBatch` | `(chatKey, messages, {replyToMessageId?, atUserId?})` | 发文本，`messages` 可为字符串或数组 |
| `sendImage` | `(chatKey, {url?, dataUrl?}, {note?, replyToMessageId?, atUserId?})` | 发图片，`url` 与 `dataUrl` 二选一 |
| `sendSticker` | `(chatKey, sticker, {replyToMessageId?, atUserId?})` | 发表情包 |
| `poke` | `(chatKey, targetUserId)` | 戳一戳 |

发送器内置：**发送队列（按会话串行）、限频检查、内容去重、真人式随机停顿**。
失败会抛错，建议 try/catch。

### 10.7 `ctx.session` 字段

```
id, chatKey, startedAt, endedAt, status, waitUntil,
trigger ('message'|'proactive'), triggerSummary, triggerText,
systemPrompt, userPrompt, promptChars,
model, rounds, messages[], sent[], feedbacks[],
finishReason, error,
usage: { promptTokens, completionTokens, totalTokens, cachedTokens, calls }
```

常用：`ctx.session.id`、`ctx.session.triggerText`、`ctx.session.sent`（实际发出的内容）。

### 10.8 `ctx.reminders` 方法

| 方法 | 签名 / 说明 |
|---|---|
| `add` | `({chatKey, text, dueAt, createdBy}) => entry` |
| `cancel(id)` | 取消 |
| `pending()` / `due(now)` | 查询待触发 / 已到期 |
| `prune()` | 清理 |

### 10.9 `ctx.videoReader` 方法

| 方法 | 说明 |
|---|---|
| `describeRoute()` | 当前视频理解走哪条路 |
| `framesAvailable(opts)` | 抽帧是否可用 |
| `probe(filePath)` | 探测视频元信息 |

---

## 11. 状态、错误码与工具可用性判定链

### 11.1 错误码

| code | 含义 |
|---|---|
| `skill-not-found` | 没有这个 Skill |
| `skill-not-loaded` | 加载失败 |
| `skill-disabled` | 用户关闭 |
| `skill-unavailable` | 依赖不满足（缺 Key / 缺二进制 / 模型不支持） |
| `capability-missing` | 缺少被依赖的能力 |
| `skill-timeout` | hook 执行超时 |

### 11.2 工具可用性判定链（`getToolAvailability`）

**按顺序判断，上游不通过就不看下游**，所以 `reason` 一定指向真正的原因：

```
1. tools.enabled === false        → tools-disabled（工具总开关关闭）
2. 所属 Skill 未生效              → skill-disabled / skill-not-loaded / capability-missing
3. 工具 requires 的能力不可用      → capability-missing
4. 分类开关关闭                   → category-disabled
5. 单工具 override 关闭           → tool-disabled
6. requiresVision / requiresSearch → no-vision / no-search
7. Skill 的 tool.guard 否决       → skill-guard
```

> 模块**不允许**再自己写一份判断（那正是"两个开关打架"的来源）。

### 11.3 相关 HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/skills` | 全部 Skill 状态 + 摘要 + 能力列表 |
| POST | `/api/skills/:id` | `{enabled}` 切开关（会跑 activate/deactivate）；`{settings}` 改配置（只接受 configSchema 声明过的键） |
| GET | `/api/skills/capabilities` | 每个能力的可用性与原因 |
| GET | `/api/tools/availability` | 每个工具的可用性与原因 |
| GET | `/api/tools` | 工具清单 |

---

## 12. 命令速查

```bash
# 生成骨架
npm run new:skill <id> -- --name "显示名" --category media --desc "说明"
npm run new:skill <id> -- --legacy            # 生成到 plugins/（确定性型骨架）

# 开发（保存即热重载）
QQ_AGENT_DEV=1 npm run server
# Windows CMD： set QQ_AGENT_DEV=1 && npm run server

# 生产启动
npm run server

# 测试
npm run test:skill     # 技能架构机制（36 项）
npm run test:audit     # 全量工具与 Skill 一致性审查
npm run test:skillui   # 技能设置弹窗渲染
npm test               # 全量
```

`test:audit` 会检查这些**不报错但功能失灵**的问题：

- 声明了能力但代码没实现（调用方拿到空列表、静默失效）
- 实现了能力但清单没声明（用户看不出它提供什么）
- 单提供者能力被两个技能抢（谁生效取决于加载顺序）
- 工具 `requires` 的能力没有任何技能提供（该工具永远不可用）
- 参数不是合法 JSON Schema / 缺 description
- `available()` 返回了 Promise

---

## 13. 上架到 Skill 市场

### 13.1 打包

zip 内保留目录层级（目录名不限，建议用 skill id）：

```
my-skill.zip
└── my-skill/
    ├── skill.json
    ├── index.js
    └── （其它源码文件）
```

### 13.2 上传

打开 <https://www.kondius.cn/qq-agent/skill-market/> → 「上传 Skill ZIP」。

对应接口：`POST /api/community/skills/upload`（multipart，字段名 `file`）。

### 13.3 服务端校验规则

| 规则 | 值 |
|---|---|
| 文件类型 | 仅 zip |
| 单包大小 | ≤ 8 MB |
| 解压后总大小 | ≤ 32 MB |
| 解压后文件数 | ≤ 100 |
| 禁止的文件后缀 | `exe` `dll` `bat` `cmd` `ps1` `vbs` `sh` |
| 禁止的路径 | 绝对路径、含 `..`（含 `\` 变体） |
| `id` | 必须合法且不重名，重名返回 **409** |
| `category` | 按加载器白名单收敛（`system`/`web` 等旧值映射到 `utility`） |

`category` 若顶层没写，会取 `tools[0].category`（兼容旧插件格式）。

### 13.4 上架前必查

- [ ] 代码里**没有**你自己的 API Key、密码、内网地址
- [ ] 跑通 `npm run test:audit`
- [ ] 在真机群聊里试过：正常输入、含糊输入、**不给参数**、**接口失败**
- [ ] `description` 写得足够具体（模型才会调用）

---

## 14. 硬约束清单（AI 生成时必须遵守）

生成 Skill 时逐条自检。

### 14.1 结构与命名

- [ ] 目录 `skills/<id>/`，含 `skill.json` + `index.js`（**只要这两个就能跑**）
- [ ] **没有**在 `skills/` 下另建共享目录（只扫一级子目录，会被误当 Skill）
- [ ] 技能目录里**没有** `entry.json` / `node_modules` / `data/` / 密钥文件
- [ ] 测试文件放 `test/` 而不是技能目录里
- [ ] `id` 匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`
- [ ] `category` ∈ `{model, message, knowledge, media, utility}`
- [ ] `apiVersion: 1`
- [ ] 工具 `id` 只用 `[a-zA-Z0-9_-]`，**不含 `:` 或 `.`**
- [ ] 工具 `id` ≤ 38 字符，skillId ≤ 24 字符
- [ ] 文件编码 **UTF-8**（不要用 PowerShell 写含中文的文件）

### 14.2 代码正确性

- [ ] `setup(api)` 里至少注册一个工具（否则模型无入口）
- [ ] 工具必须有 `id`、`name`、`description`、`parameters`、`execute`
- [ ] `description` 写清「做什么」+「什么时候用」
- [ ] `parameters` 每个属性都有 `description`
- [ ] `execute` 内**先校验参数**（空值、越界）
- [ ] `execute` 用 try/catch 包住，失败返回 `{content, isError: true}`
- [ ] 所有分支都 `return { content: ... }`
- [ ] 需要联网 → 清单加 `"permissions": ["web_fetch"]`
- [ ] `available()` 是**同步**函数（绝不返回 Promise）
- [ ] 配置用 `cfg()` 在**执行时**读，不在 setup 时快照
- [ ] 用到 `configSchema` 声明过的键才写进 `settings`
- [ ] 提示词片段 `priority` ≤ 99，且内容简短
- [ ] hook 里不发消息、不发请求、不重试
- [ ] 无硬编码密钥（用配置项 + `secret: true`）

### 14.3 涉及 QQ 写操作时

- [ ] **只用 `ctx.onebot.call()` 调**，且必须 try/catch（失败会抛错）
- [ ] 先判断场景（如群管理操作先检查 `ctx.kind === 'group'`）
- [ ] 校验目标 QQ 号是正整数
- [ ] 加自保逻辑（不对自己/管理员动手）
- [ ] 发消息优先用 `ctx.sender`（自带队列/限频/去重），不要绕过它直调 `send_group_msg`
- [ ] 写明"这个操作不可撤销"或给出撤销方式

### 14.4 常见反模式

| ❌ 反模式 | ✅ 正确做法 |
|---|---|
| `id: 'my:tool'` | `id: 'my-tool'` 或 `id: 'my_tool'` |
| `description: '处理数据'` | `description: '把 CSV 转成表格。当用户上传 csv 或说"转表格"时使用。'` |
| `export function available() { return checkAsync(); }` | 同步返回；异步探测用"乐观放行 + 缓存结果" |
| `setup(api) { const c = api.config(); }` | `let cfg = () => ({}); setup 里 cfg = api.config;` |
| `execute() { return doThing(); }` | `async execute(_ctx, args) { ... return {content} }` |
| 直接 `fetch(...)` | 先声明 `web_fetch`，再用 `api.fetch(...)` |
| 在 `setup` 里发消息 | 在 `execute` 里用 `ctx.sender` |
| 绕过 `ctx.sender` 直调 `send_group_msg` | 用 `ctx.sender.sendTextBatch`（有队列/限频/去重） |
| `ctx.onebot.call(...)` 不 try/catch | 包 try/catch（协议端失败会抛错） |
| `prompt` 写 3000 字 | 两三句话，写清触发时机 |
| 工具里 `JSON.parse` 不兜底 | 用 `api.utils.safeJsonParse` 或 try/catch |

---

## 15. 常见失败对照表

| 现象 | 原因 | 解决 |
|---|---|---|
| 「技能」/「插件」页显示「加载失败」 | 清单 JSON 语法错 / 入口 import 失败 | 看命令行报错；用 JSON 校验工具检查清单 |
| 报 `缺少 id` | 清单没写 `id` | 补上 |
| 报 `id 只能包含字母/数字/._-` | id 含空格或中文 | 改英文小写 |
| 模型报 `400 invalid function name` | 工具 id 用了 `:` 或 `.` | 只用 `-` 和 `_` |
| 状态「生效中」但工具跑不通 | `available()` 返回了 Promise | 改成同步 |
| 报「缺少能力 xxx」 | `requires` 的能力没 Skill 提供 | 去掉硬依赖或改用软依赖 |
| 报「未声明 web_fetch 权限」 | 没声明联网权限 | 加 `"permissions": ["web_fetch"]` |
| 报 `fetch failed` | 网络不通 / 对方接口挂了 / 地址错 | 先用浏览器试那个 URL |
| 工具存在但模型不调用 | `description` 太含糊 | 补上触发场景 |
| 用户在设置页看不到配置项 | 只写了 `settings` 没写 `configSchema` | 补 `configSchema` |
| 改了设置不生效 | setup 时把配置快照成变量了 | 改成执行时调 `cfg()` |
| 改文件没反应 | 没开开发模式 | `QQ_AGENT_DEV=1 npm run server` |
| 中文变 `锛?` | 用 PowerShell 读过并写回 | 改用编辑器；绝不要用 PowerShell 写入 |
| 测试报 `已有 QQ Agent 实例在运行` | 测试没隔离数据目录 | 测试前设 `QQ_AGENT_DATA_DIR` 到临时目录，且**在 import 之前**设 |
| 上传市场 409 | id 重名 | 换 id |
| hook 不生效 | Skill 不是 active | 先确认「插件」页状态是"生效中"（钩子属确定性型） |

---

## 16. 完整示例

一个带**参数、配置项、能力、钩子、参数校验、错误兜底**的完整 Skill。

### 16.1 skill.json

```json
{
  "id": "text-stats",
  "name": "文本统计",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "统计一段文本的字数、字数分布与关键词，用于群里的发言分析。",
  "author": "示例",
  "enabledByDefault": true,
  "capabilities": ["text.stats"],
  "requires": [],
  "settings": {
    "topN": 5,
    "withDetail": false
  },
  "configSchema": {
    "topN": {
      "type": "number",
      "label": "关键词个数",
      "description": "统计前几个高频字词，1~20，默认 5",
      "min": 1,
      "max": 20
    },
    "withDetail": {
      "type": "boolean",
      "label": "输出详细信息",
      "description": "开启后会附上字数分布等额外信息"
    }
  },
  "prompt": {
    "sections": [
      {
        "id": "text-stats-note",
        "title": "文本统计",
        "priority": 35,
          "content": "当用户想统计某段文本的字数、词频，或分析群里某人的发言量时，调用 stat_text 工具，把要分析的文本放进 text 参数。不要自己数。"      }
    ]
  }
}
```

### 16.2 index.js

```js
// 保存 api.config，供每次执行时读取最新配置（不要在 setup 时快照）
let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;

  api.registerTool({
    id: 'stat_text',
    name: '文本统计',
    // 这句是给模型看的：写清「做什么」+「什么时候用」
    description: '统计文本的字符数、行数和高频字词。当用户想统计字数、分析词频、比较发言量时使用。注意：中文按单个汉字统计，英文按单词统计。',
    category: 'query',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要统计的文本内容' },
        topN: { type: 'number', description: '要返回的高频字词个数，1~20，不填用设置里的值' }
      },
      required: ['text']
    },
    async execute(_ctx, args) {
      // 1) 参数校验：模型可能给空值
      const text = String(args?.text ?? '').trim();
      if (!text) return { content: '缺少 text 参数：请把要统计的文本放进来', isError: true };

      try {
        const c = cfg();                                  // 2) 执行时读最新配置
        const topN = clamp(Number(args?.topN) || Number(c.topN) || 5, 1, 20);
        const stats = computeStats(text, topN);

        const lines = [
          `字符数：${stats.chars}`,
          `不含空格：${stats.charsNoSpace}`,
          `行数：${stats.lines}`,
          // 注意措辞：中文按字统计，所以叫「高频字词」而不是「高频词」
          `高频字词：${stats.top.map(([w, n]) => `${w}(${n})`).join('、') || '无'}`
        ];
        if (c.withDetail) lines.push(`平均词长：${stats.avgWordLen.toFixed(1)}`);
        log(`统计完成：${stats.chars} 字符`);
        return { content: lines.join('\n') };
      } catch (error) {
        // 3) 失败也返回人话，绝不让异常冒泡
        return { content: `统计失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

// 提供能力：别的 Skill 或核心可以按能力名取用，不需要 import 本文件
export const providers = {
  'text.stats': ({ text = '', topN = 5 } = {}) => computeStats(String(text), clamp(Number(topN) || 5, 1, 20))
};

// 依赖自检：必须同步返回
export function available() { return true; }

// 钩子：只做轻量加工，不发消息、不发请求
export const hooks = {
  'after-tool': ({ toolName, result }) => {
    if (toolName === 'text-stats__stat_text' && result?.isError) log('统计工具返回了错误');
  }
};

// ── 纯函数：无副作用，方便单测 ──
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(n))); }

function computeStats(text, topN) {
  const chars = text.length;
  const charsNoSpace = text.replace(/\s/g, '').length;
  const lines = text.split('\n').length;
  // 中文按字切、英文按词切，够用即可
  const words = (text.match(/[\u4e00-\u9fa5]|[a-zA-Z]+/g) || []).map((w) => w.toLowerCase());
  const freq = new Map();
  for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  const avgWordLen = words.length ? words.reduce((s, w) => s + w.length, 0) / words.length : 0;
  return { chars, charsNoSpace, lines, top, avgWordLen };
}
```

### 16.3 这个示例覆盖了什么

| 要点 | 位置 |
|---|---|
| 参数校验 | `if (!text) return { isError: true }` |
| 参数兜底 + 越界限制 | `clamp(Number(args?.topN) || c.topN, 1, 20)` |
| 执行时读配置 | `const c = cfg()` |
| 配置项声明 | `configSchema` 的 `topN` / `withDetail` |
| 错误兜底 | `try/catch` → `{content, isError}` |
| 提供能力 | `providers['text.stats']` |
| 同步自检 | `available()` |
| 轻量钩子 | `hooks['after-tool']` |
| 纯函数拆分 | `computeStats` 单独抽出，便于测试 |
| 给模型的说明 | 工具 `description` + `prompt.sections` |

### 16.4 自测方式

写完用真实加载器跑一遍（**不污染仓库的 skills/**）：

```js
// test/my-skill-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须在 import 业务模块之前设置，否则会碰到真实的 data/
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-test-'));

const { loadPlugins } = await import('../src/plugin-loader.js');
const { skillManager } = await import('../src/skills/manager.js');
const { getTool } = await import('../src/tool-registry.js');

const res = await loadPlugins({ log: () => {}, roots: { skills: './skills', plugins: './plugins' } });
assert.ok(res.failed.length === 0, `加载失败：${JSON.stringify(res.failed)}`);

const st = skillManager.status('text-stats', {});
assert.equal(st.active, true, `技能未生效：${st.reason}`);

const tool = getTool('text-stats__stat_text');
assert.ok(tool, '工具未注册（检查 registerTool 的 id）');

assert.ok((await tool.execute({}, { text: '你好 你好 世界' })).content.includes('高频字词'));
assert.equal((await tool.execute({}, {})).isError, true, '缺参数应返回错误而不是抛错');
console.log('全部通过 ✅');
```

---

## 附：AI 生成 Skill 的推荐提示词

把下面这段连同本文件一起交给 AI：

```
请按 doc/extend_development/skill-reference.md 的规范，生成一个名为 <id> 的 Skill，功能是：<描述>。

要求：
1. 输出 skills/<id>/skill.json 与 skills/<id>/index.js 两个文件的完整内容
2. 严格遵守第 14 节的硬约束清单（尤其：工具 id 不含 : 和 .、available() 必须同步、
   需要联网必须声明 permissions: ["web_fetch"]、配置在执行时用 cfg() 读）
3. 工具 description 必须写清「做什么」+「什么时候用」
4. execute 内先校验参数，用 try/catch 兜底，失败返回 {content, isError: true}
5. 参数不要过多，超过 5 个就拆成多个工具
6. 如果功能依赖外部 API，把 base URL 做成配置项而不是写死在代码里
7. 需要操作 QQ（发消息/禁言/撤回/查群成员等）时，用 ctx.onebot.call('接口名', {...})
   并包 try/catch；可调用的接口清单见第 10.2.2 节
8. 发消息一律用 ctx.sender，不要直接调 ctx.onebot 的 send_* 接口
9. 先判断该用哪种机制（见 1.7）：
   - 「满足条件一定要发生」→ 用 providers / hooks（核心确定性触发）
   - 「让模型自己判断该不该用」→ 用工具 registerTool
   - 「只是想让说话方式变一变」→ 用 prompt.sections
```

---

## 17. 两型语义与术语

**加载单元统称 Skill，按语义分两型。** 目录就是类型的声明。

代码里的权威定义（`src/skills/manifest.js` 的 `DIR_KIND` + `src/plugin-loader.js` 顶部注释）：

```
plugins/   确定性型（kind = 'plugin'）
           提供**能力**（providers）或**钩子**（hooks）。核心代码按能力名取用，
           满足条件就一定被执行，不经过 LLM，模型想忽略也忽略不掉。
           例：账号池、图片兼容、思考适配、禁言状态、抽帧、语音转文字、回复安全网。

skills/    LLM 型（kind = 'skill'）
           注册**工具**（registerTool）+ 提示词片段。工具进模型的 function 列表，
           用不用、什么时候用由模型自己判断。
           例：计算器、文本工具、天气查询、随机图、表情标注。
```

| | `plugins/`（确定性型） | `skills/`（LLM 型） |
|---|---|---|
| 靠什么生效 | `providers` 能力 / `hooks` 钩子 | `registerTool` 工具 + `prompt.sections` |
| 谁决定何时执行 | **核心代码**（按能力名确定性调用） | **模型**（看工具的 description 自己判断） |
| 会不会进模型的 `tools` 列表 | ❌ | ✅ |
| 会不会进提示词文本 | ❌（除非另配 `prompt.sections`） | 片段会 ✅ |
| 能不能被"忽略" | ❌ 条件满足必然执行 | ✅ 模型可以选择不调用 |
| 放错目录的后果 | 有工具没能力 → 语义混乱（能用） | 有能力没工具 → **模型完全看不到，功能永不触发** |

### 17.1 术语澄清

- **Skill** —— 正式术语，指任何可插拔加载单元（无论哪一型）
- **插件（plugin）** —— 确定性型的叫法，因为它"像插件一样装上就常驻生效"
- 早期版本里 `plugins/` 曾表示"旧格式 `plugin.json` + `register(api)`"，
  `skills/` 表示"新格式"。**这个说法已作废** —— 现在两种清单文件功能等价
  （同一条 `normalizeManifest`），兼容性由加载器统一处理，不再与目录绑定

### 17.2 ⚠️ 别把「机制」和「目录」混为一谈，但这次它们是对齐的

四种机制（工具 / 提示词片段 / 能力 / 钩子）**两型都能用**，区别只在"谁决定何时生效"：

- 「满足条件一定触发」= 能力 `providers` + 钩子 `hooks`（核心确定性调用）→ 放 `plugins/`
- 「由模型决定何时用」= 工具 `registerTool` + 提示词片段 `prompt.sections` → 放 `skills/`

所以选目录的判据只有一句：

> **规则能写死 → 插件（`plugins/`）；要理解人话 → 技能（`skills/`）。**

两型的清晰定义与三问判断法（触发时机能否用 if 描述 / 漏一次的代价 / 参数从哪来）
见 [skill-development.md §0](./skill-development.md#0-先做这个判断)
与 [plugin-development.md §0](./plugin-development.md#0-一句话判断该不该做确定性型)。

### 17.3 仓库现状（2026-09 观测）

| | `plugins/`（10 个） | `skills/`（5 个） |
|---|---|---|
| 注册工具数 | **0** | **4**（text-tools 2、calculator 1、weather-query 1） |
| 提供能力 | 全部 10 个都有 | 2 个（random-image、sticker-annotate，供自己注册的工具取用） |
| 提示词片段 | 部分有 | 部分有 |

32 个工具里 26 个来自核心 `src/tools.js`。也就是说本项目遵循：

> **核心提供工具（模型看到的 API 面），确定性型插件提供能力的实现（背后插拔）。**

这样换掉某个实现（比如抽帧换方案）既不用改核心，也不用改提示词。

> ⚠️ 想让模型直接用上新功能，**只有注册工具这一条路** —— 详细判据与实例见
> [skill-development.md](./skill-development.md) 与 [plugin-development.md](./plugin-development.md)。


