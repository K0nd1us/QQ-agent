# 自定义工具（插件）

给机器人加一个只有你需要的工具，不用改项目源码、不用重新打包。写两个文件、点一下「重新加载」，模型下次运行就能调用它。

> ⚠️ **安全前提**：`handler.js` 由主进程直接以 ESM 执行，**拥有本机完整 Node 能力**——能读写文件、发网络请求、起子进程。这和任何插件系统一样：**代码即权限**。只放你自己写过或信任的插件；不认识的插件先读一遍再放进来。
>
> 不放心时：设置页「自定义工具」里有**总开关**，一键停用全部插件；也可以用 `sanitize-release.mjs` 分发前清掉整个 `tools/` 目录。

## 目录结构

插件放在**数据目录**下（默认是安装目录的 `data/`，可用环境变量 `QQ_AGENT_DATA_DIR` 重定向）：

```
data/tools/
  <插件目录名>/          ← 目录名随便起，仅用于区分
    tool.json            ← 清单：工具叫什么、干什么、参数长什么样
    handler.js           ← 处理函数：真正执行的代码
```

每个插件一个子目录，可以放多个插件。目录名以 `.` 开头的会被忽略。

## `tool.json` 清单

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 工具名。小写字母开头，只含小写字母/数字/下划线，长度 2~64。**不能与内置工具重名**（`send_message`、`web_search` 等） |
| `description` | ✅ | 给模型看的说明——**模型靠它判断什么时候该调用**。写清楚用途、适用场景、以及不该用的场景，长度 ≤4000 字符 |
| `parameters` | ✅ | JSON Schema，`type` 必须是 `object`。模型按这个生成参数 |
| `enabled` | | `false` 时这个插件默认不进工具集（管理页里仍可见）。默认 `true` |
| `timeoutMs` | | 单个工具的执行超时（毫秒）。默认取设置里的 `customTools.timeoutMs`（20000） |
| `requiresVision` | | `true` 时：当前模型不支持图片输入就不暴露这个工具 |
| `requiresSearch` | | `true` 时：联网搜索被关闭就不暴露这个工具 |
| `version` | | 展示用版本号 |
| `author` | | 展示用作者名 |

示例：

```json
{
  "name": "get_weather",
  "description": "查询某个城市的实时天气。群友问「今天热不热」「要带伞吗」这类问题时用，需要联网。不要用来查历史天气。",
  "parameters": {
    "type": "object",
    "properties": {
      "city": { "type": "string", "description": "城市名，如「杭州」" }
    },
    "required": ["city"]
  },
  "timeoutMs": 15000,
  "version": "1.0.0",
  "author": "你的名字"
}
```

## `handler.js` 处理函数

必须导出函数，两种写法都行：

```js
// 写法一：默认导出
export default async function execute(ctx, args, helpers) { ... }

// 写法二：具名导出（两者都存在时，优先 execute）
export async function execute(ctx, args, helpers) { ... }
```

### 参数

| 参数 | 说明 |
|---|---|
| `ctx` | 与内置工具完全一致的运行时上下文（见下） |
| `args` | 模型生成的参数对象，已按 `parameters` 解析 |
| `helpers` | `helpers.ok(payload)` / `helpers.err(message)` 两个快捷构造器 |

### 返回值

以下都可以：

- 字符串 → 直接作为工具结果文本
- `{ content: string, isError?: boolean }` → 完整控制（`helpers.ok` / `helpers.err` 就是这个形状）
- 任意对象 → 自动 JSON 化（便于模型阅读）
- 数组 → 按「多段 content」处理（一般用不到）

返回 `undefined` 视为成功但无内容。抛异常会被捕获成错误结果（模型看到「错误：…」，可以自行纠正重试）。

### `ctx` 可用字段

| 字段 | 说明 |
|---|---|
| `ctx.chatKey` | 当前会话 key，形如 `group:123456` / `private:10001`。**工具天然绑定当前会话**，你无法把消息发到别的群 |
| `ctx.kind` | `'group'` 或 `'private'` |
| `ctx.chatId` | 群号 / 好友 QQ 号（字符串） |
| `ctx.selfId` / `ctx.selfNickname` | 机器人自己的 QQ 号 / 群内昵称 |
| `ctx.botName` | 机器人名字 |
| `ctx.store` | 消息存档（`recent` / `unreadCount` / `findByMid` / `activeMembers` …） |
| `ctx.memory` | 长期记忆（`append` / `query` / `remove`） |
| `ctx.stickers` | 表情库（`find` / `list` …） |
| `ctx.sender` | 发送队列（`sendTextBatch` …）——自己发消息要绕着限频走，优先用内置 `send_message` |
| `ctx.session` | 本次会话记录（`sent` / `feedbacks` / `webSearchCount` …） |
| `ctx.emit` | 向控制台上报事件：`ctx.emit('session-update', ctx.session.id)` |
| `ctx.onebot` | 底层 OneBot 客户端（`call(action, params)`），能调协议端任意接口 |

### 完整示例

```js
// data/tools/example_echo/handler.js
export default async function execute(ctx, args, helpers) {
  const text = String(args.text ?? '');
  if (!text) return helpers.err('text 不能为空');
  return helpers.ok({
    echo: text,
    chat: ctx.chatKey,        // group:456
    at: new Date().toISOString()
  });
}
```

同目录的 `tool.json`：

```json
{
  "name": "example_echo",
  "description": "示例插件：把传入的 text 原样返回，用来验证链路是否打通。",
  "parameters": {
    "type": "object",
    "properties": { "text": { "type": "string", "description": "要回显的内容" } },
    "required": ["text"]
  }
}
```

## 怎么用

1. 打开控制台 → **设置 → 自定义工具** → 点「打开插件目录」（不存在会自动创建）
2. 新建一个子目录，放 `tool.json` + `handler.js`
3. 点「重新加载」（或直接改文件——下次运行会自动感知 mtime 变化）
4. 用「试跑」填一份参数 JSON 验证，不必真的发消息
5. 让群友触发一次，模型就会看到这个工具

## 生效与重载

- **改完即生效**：加载器按清单 + 处理函数的 mtime 判断是否需要重载，不需要重启进程
- 「重新加载」按钮会强制清空缓存并重新扫描（改坏了想回滚、或同一毫秒内改文件时用）
- 加载失败的插件**不会影响其他插件**，也不会让 agent 运行挂掉——错误会显示在面板上

## 校验与限制

加载时会拦住这些情况，并在面板上给出原因：

- 缺少 `tool.json` 或 `handler.js`
- `tool.json` 不是合法 JSON
- `name` 不合法（含大写/连字符/中文等）
- `name` 与**内置工具**重名
- `name` 与**另一个自定义工具**重名（按目录名排序，先加载的赢）
- `description` 为空或超过 4000 字符
- `parameters` 不是对象、或 `type` 不是 `object`
- `handler.js` 语法错误，或没有导出函数

运行时的额外保护：

- 单个工具超时（默认 20s）会被中断等待，返回错误给模型；**注意超时只是不再等它，不会强杀插件内部的异步任务**
- 参数不是合法 JSON 时，模型会收到错误提示，可自行纠正重试

## HTTP 接口

面板用到的接口（都可直接调，方便脚本化管理）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/custom-tools` | 列出插件、错误、内置工具数量、总开关状态 |
| POST | `/api/custom-tools/reload` | 清缓存重新扫描 |
| POST | `/api/custom-tools/global` | `{ enabled: boolean }` 总开关 |
| POST | `/api/custom-tools/toggle` | `{ name, enabled }` 单个启用/禁用 |
| POST | `/api/custom-tools/open-folder` | 在资源管理器中打开插件目录 |
| POST | `/api/custom-tools/scaffold` | 生成示例插件（不覆盖已有文件） |
| POST | `/api/custom-tools/test` | `{ name, args }` 手动试跑一个插件（不经模型） |

## 相关配置

```jsonc
// data/config.json
{
  "customTools": {
    "enabled": true,      // 总开关
    "disabled": [],       // 被单独禁用的工具名
    "timeoutMs": 20000    // 默认执行超时
  }
}
```

## 分发注意

`scripts/sanitize-release.mjs` 会清理数据目录。分享自己的部署副本前请确认 `data/tools/` 下没有不想公开的私有插件（可能含内部地址、Key、业务逻辑）。
