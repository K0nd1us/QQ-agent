# Skill 架构

> 📖 **不会写代码？** 先看 [零基础 Skill 开发指南](./skill-guide-for-beginners.md) ——
> 用大白话从"机器人怎么干活"讲起，手把手做出第一个 Skill。
> 本文档是配套的技术参考，写给有编程基础的人。
>
> 🔍 要查**完整 API 表面**（api 对象、ctx 全量字段、能力清单、钩子载荷、硬约束清单），
> 见 [Skill 完整参考（单文件）](./skill-reference.md)。

> ## 📌 先确认你该读哪一份
>
> | 你要做的东西 | 放哪 | 开发文档 |
> |---|---|---|
> | **LLM 型** —— 注册工具，模型决定何时用 | `skills/` | **[skill-development.md](./skill-development.md)** |
> | **确定性型** —— 提供能力/钩子，满足条件必然触发 | `plugins/` | **[plugin-development.md](./plugin-development.md)** |
>
> 本文是**配套参考**，不是入口文档。两型的完整开发流程（目录、文件、热重载、上架、自检、排查）
> 都在上面那两份里。


## 一句话

Skill = 可插拔能力模块。核心模块通过**能力名**（capability）依赖它，不通过 Skill 名字；
开关只有一处（`config.skills[id].enabled`），所有模块从 `SkillManager` 读。

## 目录结构

```
skills/<id>/
  skill.json     清单：能力、依赖、配置项、提示词片段
  index.js       入口：setup(api)，可选 hooks / providers / activate / deactivate / dispose
plugins/<id>/    确定性型：提供能力(providers)/钩子(hooks)，满足条件必然执行（plugin.json）
```

`skills/` 和 `plugins/` 都会被扫描。旧插件自动获得 `skillId`、开关联动和能力依赖。

## skill.json 字段

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识。缺省时回退目录名；只允许字母/数字/`._-` |
| `name` | 显示名 |
| `version` | 版本 |
| `apiVersion` | Skill API 版本（当前 1）。高于支持值会报警告 |
| `category` | `model` / `message` / `knowledge` / `media` / `utility` |
| `description` | 一句话说明（设置页展示） |
| `enabledByDefault` | 用户没配置过时的默认开关（默认 `true`） |
| `capabilities` | 本 Skill **提供**的能力名 |
| `requires` | 本 Skill **依赖**的能力名（写自己的会被自动移除） |
| `settings` | 该 Skill 的默认配置值 |
| `configSchema` | 配置项声明（设置页据此渲染；也是写入白名单） |
| `prompt.sections` | 追加到系统提示词的片段，见下 |
| `deprecated` | 标记弃用（仍加载，UI 提示） |

### prompt.sections

```json
{ "prompt": { "sections": [
  { "id": "xxx", "title": "小节标题", "priority": 80, "content": "规则正文" }
] } }
```

- `priority` 会被**强制压到 99 以内**。核心安全规则优先级恒为 100+，
  Skill **不可能**覆盖安全规则、工具协议这类约束。
- 片段一律排在核心系统提示词之后。

## index.js 的导出

```js
export function setup(api) {}          // 注册入口（等价于旧插件的 register）
export function activate(ctx) {}       // 开启时（读取监听/定时器在这里建立）
export function deactivate(ctx) {}     // 关闭时（必须清干净，否则会留幽灵行为）
export function dispose() {}           // 卸载时（工具会被自动回收）
export function available(ctx) {}      // 依赖自检：返回 false 或 { ok:false, reason }
export function promptSections(ctx) {} // 动态提示词片段
export const hooks = {}                // 见下
export const providers = {}            // 能力实现：{ 'cap.name': fn }
```

> ⚠️ **`available()` 必须是同步函数。**
> 可用性判定（`isActive` / `getToolAvailability`）走的是同步调用链，
> 返回 Promise 会被当成"可用"——因为 Promise 是 truthy。
> 需要做异步探测（比如 `spawn` 一下 ffmpeg 看装没装）时，
> 用"首次乐观放行 + 后台探测 + 缓存结果"的写法，见 `skills/video-frames/index.js`。
> 否则会出现"明明缺依赖，设置页却显示生效中"——正是这套架构要消灭的不一致。


### setup(api) 能拿到什么

| API | 用途 |
|---|---|
| `api.registerTool(def)` | 注册工具，自动加 `skillId` 前缀与来源标记 |
| `api.config()` | 读本 Skill 的配置（已合并 `settings` 默认值） |
| `api.isSkillActive(id, ctx)` | 查询别的 Skill 是否生效 |
| `api.log/warn/error` | 带 Skill 前缀的日志 |
| `api.fetch` | 只有声明了 `permissions: ["web_fetch"]` 才拿得到 |
| `api.utils` | `sleep` / `safeJsonParse` |

## hooks

| hook | 时机 | 能做什么 |
|---|---|---|
| `before-context` | 组装提示词之前 | 加工触发消息、补充上下文 |
| `before-llm-messages` | 消息即将发给模型 | 原地修改 `context.messages` |
| `after-response` | 收到模型响应 | 加工响应、记录信息 |
| `before-tool` | 执行工具之前 | 返回 `{ block:true, reason }` 可**否决**这次调用 |
| `after-tool` | 执行工具之后 | 统计、加工结果 |

hook 规则：
- 错误隔离：一个 Skill 抛错只记日志，不影响其它 Skill 和主流程
- 超时跳过：默认 5 秒（`skillManager.hookTimeoutMs`）
- **不能**自己发请求、自己重试、自己发消息

## 能力（capability）

核心模块按能力名取提供者：

```js
skillManager.hasCapability('llm.request-params')
skillManager.getCapabilityProviders('llm.request-params', ctx)
skillManager.explainCapability('llm.request-params', ctx)  // 不可用时给出原因
```

已用的标准能力名：

| 能力 | 提供者返回 | 消费方 |
|---|---|---|
| `llm.request-params` | `{ body, omitTemperature? }` | `src/llm.js` 改写请求体 |
| `llm.response` | `{ result }` | `src/llm.js` 加工响应 |
| `llm.usage` | `{ [字段]: 数值 }` | `src/llm.js` 附加统计 |
| `llm.retry-advisor` | `{ body, reason }` 或 `null` | `src/llm.js` 决定是否降级重试 |
| `tool.guard` | `true` / `false` / `{ok:false,reason}` | `tool-registry` 运行期否决 |
| `message.speaker-format` | 字符串标签 | 发言链路 |
| `message.inline-at-normalize` | 规范化后的文本 | 发言链路 |

## 状态模型（四层，可解释）

```
loaded     代码是否加载成功
enabled    用户开关（config.skills[id].enabled）
available  依赖是否满足（requires 能力 + Skill 自己的 available()）
active     最终是否生效 = loaded && enabled && available
```

`GET /api/skills` 返回每项的 `code` + `reason`，UI 直接展示，不需要自己推断。

原因码：

| code | 含义 |
|---|---|
| `skill-not-found` | 没有这个 Skill |
| `skill-not-loaded` | 加载失败 |
| `skill-disabled` | 用户关闭 |
| `skill-unavailable` | 依赖不满足（缺 Key / 缺二进制 / 模型不支持） |
| `capability-missing` | 缺少被依赖的能力 |
| `skill-timeout` | hook 执行超时 |

## 工具可用性：唯一口径

`tool-registry.getToolAvailability(toolId, ctx)` 按顺序判断，**上游不通过就不看下游**，
所以 `reason` 一定指向真正的原因：

```
1. tools.enabled === false          → tools-disabled
2. 所属 Skill 未生效                 → skill-disabled / skill-not-loaded / capability-missing
3. requires 声明的能力不可用          → capability-missing
4. 分类开关关闭                      → category-disabled
5. 单工具 overrides 关闭             → tool-disabled
6. requiresVision / requiresSearch   → no-vision / no-search
7. Skill 的 tool.guard 否决          → skill-guard
```

模块**不允许**再自己写一份判断（那正是"两个开关打架"的来源）。

## 配置迁移

旧字段会在 `loadConfig()` 时自动收拢进 `config.skills`，并清掉旧键：

| 旧字段 | 新位置 |
|---|---|
| `api.thinking` | `skills.thinking.enabled` |
| `tools.knowledgeEnabled` | `skills['knowledge-base'].enabled` |
| `tools.videoEnabled` | `skills['video-understanding'].enabled` |
| `tools.stickerAnnotate` | `skills['sticker-annotation'].enabled` |

规则：迁移幂等；**已有新配置时不覆盖**（用户可能已在新 UI 改过）。
新增迁移只需往 `src/config.js` 的 `LEGACY_SKILL_MIGRATIONS` 加一行。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/skills` | 全部 Skill 状态 + 摘要 + 能力列表 |
| POST | `/api/skills/:id` | `{ enabled }` 切开关（会跑 activate/deactivate）；`{ settings }` 改配置（只接受 manifest 声明的键） |
| GET | `/api/skills/capabilities` | 每个能力的可用性与原因 |
| GET | `/api/tools/availability` | 每个工具的可用性与原因 |

## 加一个新 Skill

### 0. 用脚手架生成骨架（推荐）

```bash
npm run new:skill my-skill -- --name "我的技能" --category media --desc "一句话说明"
# 生成到 plugins/（确定性型）： npm run new:skill my-skill -- --legacy
```

生成 `skills/<id>/{skill.json,index.js,README.md}`，**开箱即生效**：一个工具 + 一个能力 +
一处提示词片段 + 同步 `available()` + 配置项。换成真实实现即可。

脚手架会先校验 `id`（字母/数字/`._-`）与 `category`（白名单），
并在目标已存在时拒绝覆盖（要覆盖加 `--force`）。

### 1. 手写（不用脚手架时）

1. `mkdir skills/my-skill`
2. 写 `skill.json`（至少 `id` / `name` / `version`）
3. 写 `index.js`：

```js
let cfg = () => ({});
export function setup(api) {
  cfg = api.config;
  api.registerTool({ id: 'hello', name: '打招呼', execute: async () => ({ content: 'hi' }) });
}
export const providers = {
  'my.capability': (args) => { /* ... */ }
};
```

4. 打开设置页 → 技能（Skill），确认状态是"生效中"
5. 开发模式下（`QQ_AGENT_DEV=1`）保存文件即热重载

### 工具 id 的硬规则（写错会 400）

`registerTool({ id })` 里的 id 最终会变成发给模型的 **OpenAI function name**，所以：

- 自动加前缀：`<skillId>__<toolId>`（双下划线分隔），你在 `execute` 里只写短名。
- 只允许 `[a-zA-Z0-9_-]`，其它字符会被替换成 `_`。
- 总长 ≤ 64：skillId 截断到 24、toolId 截断到 38。
  ⚠️ 别用 `:` 或 `.` 拼 id —— 严格端点（DeepSeek / OpenAI 官方）会以
  `400 invalid function name` 拒掉**整个请求**，而不是只忽略这个工具。
- 与其它 Skill sanitize 后撞名时，后加载者覆盖先加载者，控制台会打告警。

### configSchema 支持的类型

设置页表单**完全按 manifest 渲染**，前端不硬编码字段名：

| type | 渲染 | 备注 |
|---|---|---|
| `boolean` | 复选框 | 整行可点 |
| `number` | 数字输入 | 配合 `min` / `max` / `step` |
| `enum` | 下拉 | 需要 `options: [...]` |
| `string` | 文本框 | `multiline: true` 或描述较长时占整行 |
| `internal` | 不渲染 | 列表/对象类字段；弹窗里只提示"去哪改" |

附加：`label` / `description`（提示语）/ `default` / `secret: true`（密码框，**留空 = 不修改**）。

### 提示词片段

`prompt.sections[].priority` 会被强制压到 99 以内 —— 核心安全规则恒为 100+，
Skill **不可能**覆盖安全约束、工具协议。片段一律排在核心提示词之后。

### 打包上传到 Skill 市场

zip 里带上 `skill.json` 与源码即可（目录层级不限，解压时保留结构）：

```
my-skill.zip
└── my-skill/
    ├── skill.json
    ├── index.js
    └── lib/helper.js
```

服务端校验：仅 zip、≤ 8MB、解压后 ≤ 32MB、≤ 100 个文件、禁 `exe/dll/bat/cmd/ps1/vbs/sh`、
禁绝对路径与 `..`（含 `\` 变体）；`id` 必须合法且不与他人重名（重名返回 409）。

**`category` 必须用加载器认可的值**：`model` / `message` / `knowledge` / `media` / `utility`。
写别的会被加载器静默降级成 `utility` 并记一条 problem；市场侧也按同一套映射收敛
（旧插件的 `system` / `web` 等会归到 `utility`）。

> `plugins/<id>/plugin.json` 同样支持：`register(api)` 等价于 `setup(api)`，
> 但 `plugin.json` 里的 `tools[]` 只是**说明性元数据**，工具必须在入口里 `registerTool` 注册，
> 否则加载器会警告"清单里有工具但入口没注册"。

### 完整可复制模板

```js
// skills/my-skill/index.js
let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;                  // settings 默认值已合并
  log = api.log;
  api.registerTool({
    id: 'hello',                     // → my-skill__hello
    name: '打招呼',
    description: '按配置返回一句问候语',   // 这句是给模型看的，决定它会不会调用
    category: 'utility',
    parameters: {
      type: 'object',
      properties: { who: { type: 'string', description: '对方称呼' } },
      required: []
    },
    async execute(_ctx, args) {
      const { greeting, loud } = cfg();
      const text = `${greeting}，${String(args?.who ?? '陌生人')}`;
      return { content: loud ? text.toUpperCase() : text };
    }
  });
}

// 能力实现：核心按能力名取用，不 import 本文件
export const providers = {
  'my.greet': ({ who = '陌生人' } = {}) => ({ greeting: cfg().greeting, who })
};

// 依赖自检：必须同步！返回 false / { ok:false, reason } 会让 UI 显示原因
export function available() { return true; }

export const hooks = {
  'after-tool': ({ toolId }) => log(`工具跑完了：${toolId}`)
};
```

需要网络时在清单加 `"permissions": ["web_fetch"]`，才能用 `api.fetch`；
软依赖用 `api.capability('某能力')`（缺了自动降级），硬依赖才写进 `requires`。

## 开发者全流程（从零到上架）

| 阶段 | 做什么 | 怎么验证 |
|---|---|---|
| ① 生成 | `npm run new:skill <id> -- --name "..." --category media` | 目录出现 `skill.json` / `index.js` / `README.md` |
| ② 实现 | 改 `execute()`；需要网络就加 `permissions: ["web_fetch"]` | — |
| ③ 热调 | `QQ_AGENT_DEV=1 npm run server`（保存即重载，500ms 防抖） | 日志出现「检测到变化 → 重新扫描 → 热重载完成」 |
| ④ 看状态 | 控制台 → 「技能」页（LLM 型）/「插件」页（确定性型）；再开模型目录页看工具 | 状态要显示**生效中**；工具 `开发工具` 要可用 |
| ⑤ 查原因 | `GET /api/skills`、`GET /api/tools/availability` | 不可用时给出 `code` + `reason`，不用猜 |
| ⑥ 自测 | `npm run test:skill`；想加断言就照 `test/skill-test.mjs` 用 `loadPlugins({roots})` 指到临时目录 | 36 项全绿 |
| ⑦ 上架 | 压 zip（含清单+源码）→ Skill 市场「上传 Skill ZIP」 | 列表出现、能下载解压；重名会 409 |

**调试要点**：

- 热重载只监听 `skills/` 与 `plugins/`，改完 500ms 内重扫；重载后会重跑 `activate` 并刷新工具定义，
  所以不需要重启进程。
- 生产环境（没设 `QQ_AGENT_DEV=1`）**没有**热重载，改完要重启。
- 加载失败不会拖垮启动：单个 Skill 的 problem 只记录并让它下线，`GET /api/skills` 能看到原因。
- 清单文件带 BOM 会被自动剥离（Windows 记事本/PowerShell 容易写 BOM，不会因此加载失败）。
- 工具默认可用（除非 `defaultEnabled: false`），但仍要过 7 道可用性判定：
  全局开关 → 所属 Skill 生效 → `requires` 能力 → 分类开关 → 单工具 override → 视觉/搜索依赖 → `tool.guard`。

## 内置 Skill

| id | 默认 | 作用 | 提供的能力 |
|---|---|---|---|
| `speaker-identity` | 开 | 稳定 QQ 身份标注、正文 @ 规范化、截断 JSON 参数修补 | `message.speaker-format`、`message.inline-at-normalize` |
| `thinking-adapters` | 开 | 各厂商思考参数方言识别与翻译、思考内容/token 提取 | `llm.request-params`、`llm.response`、`llm.usage`、`llm.retry-advisor`、`model.thinking-detect` |
| `video-frames` | 开 | ffmpeg 多帧抽帧（与原生视频输入二选一） | `video.frames`、`video.frames.available` |
| `owner-identity` | 关 | 只按 QQ 号认定主人；主人专属人设与〔主人〕标注 | `message.owner-check` |
| `ban-state` | 开 | 记住被禁言的群，跳过白跑的运行 | `chat.ban-state` |
| `account-pool` | 关 | 多端点按实测延迟加权分配，限流自动冷却 | `llm.endpoint-pick`、`llm.endpoint-feedback`、`llm.endpoint-snapshot` |
| `speech-to-text` | 关 | 本地 whisper.cpp 把语音转文字 | `media.transcribe` |
| `sticker-annotate` | 关 | 视觉模型给表情包补描述与标签 | `sticker.annotate`、`sticker.annotate-batch` |
| `random-image` | 关 | 二次元随机图（保留 R18 过滤） | `image.random` |
| `media-download` | 关 | B站 / 抖音视频下载 | `media.download.bilibili`、`media.download.douyin` |

### 默认开关的取舍

默认**开**的都是"零额外成本、纯逻辑、失败可静默降级"的：
身份标注、思考适配、抽帧（没 ffmpeg 自动报依赖未满足）、禁言跳过。

默认**关**的都是"有额外成本或依赖外部环境"的：
主人识别（要填号码才生效）、账号池（要配多端点）、语音识别（要装 whisper + 模型）、
表情标注（要花视觉模型调用）、随机图与视频下载（第三方接口易失效、且涉及内容分级）。

这个分界线的意义：**装上就有用的默认开，需要先配置的默认关** ——
而不是让用户开箱就踩一堆"不可用"的提示。

## 测试

```bash
npm run test:skill     # 21 项：架构 + 端到端（含真实请求体断言）
npm test               # 全量
```

`test/skill-test.mjs` 覆盖的关键承诺：
- 关闭 Skill → 能力与工具**同时**失效（证明没有影子开关）
- 依赖缺失时给出点名到能力的 reason
- hook 抛错/超时被隔离
- **端到端**：Skill 真的改变了发出去的 HTTP 请求体；关闭后立即恢复
- 网关拒绝思考参数时**恰好**多打一次，且不与参数相关的 400 不触发重试
