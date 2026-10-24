# 零基础 Skill 开发指南

> ## 📌 先确认你该读哪一份
>
> | 你要做的东西 | 放哪 | 开发文档 |
> |---|---|---|
> | **LLM 型** —— 注册工具，模型决定何时用 | `skills/` | **[skill-development.md](./skill-development.md)** |
> | **确定性型** —— 提供能力/钩子，满足条件必然触发 | `plugins/` | **[plugin-development.md](./plugin-development.md)** |
>
> 本文是**配套参考**，不是入口文档。两型的完整开发流程（目录、文件、热重载、上架、自检、排查）
> 都在上面那两份里。


> 这份文档写给**完全不会写代码**的人。
> 你只需要会三件事：新建文件夹、复制粘贴、改里面的文字。
> 全程不需要理解编程，照着做就行。
>
> 📌 需要**查具体字段/方法/变量**时，用 [Skill 完整参考（单文件）](./skill-reference.md) ——
> 那份是查询手册（也可以整份丢给 AI 让它直接生成代码）；本文是循序渐进的教学。

---

## 目录

- [第一章 先搞懂机器人是怎么干活的](#第一章-先搞懂机器人是怎么干活的)
- [第二章 三条命令做出第一个 Skill](#第二章-三条命令做出第一个-skill)
- [第三章 说明书怎么写（skill.json）](#第三章-说明书怎么写skilljson)
- [第四章 干活的部分怎么写（index.js）](#第四章-干活的部分怎么写indexjs)
- [第五章 完整实例：从零做一个天气 Skill](#第五章-完整实例从零做一个天气-skill)
- [第六章 让机器人知道该用它（提示词）](#第六章-让机器人知道该用它提示词)
- [第七章 给用户留几个开关（配置项）](#第七章-给用户留几个开关配置项)
- [第八章 进阶：能力和钩子](#第八章-进阶能力和钩子)
- [第九章 能做什么、不能做什么](#第九章-能做什么不能做什么)
- [第十章 出错了怎么查](#第十章-出错了怎么查)
- [第十一章 测试与上架](#第十一章-测试与上架)
- [附录 名词对照表](#附录-名词对照表)

---

## 第一章 先搞懂机器人是怎么干活的

这一章不写代码，但**看懂了后面全都顺**。花五分钟。

### 1.1 机器人本身不会思考

QQ Agent 自己是个"跑腿的"，真正动脑子的是一个 AI 模型（比如 DeepSeek）。它们的配合是这样：

```
群友发了一句：「今天北京天气咋样？」
        ↓
①  程序把这句话 + 一份「说明书」一起交给 AI 模型
        ↓
②  模型看完说明书，说：「我要用 get_weather 这个工具，参数是 北京」
        ↓
③  程序去执行 get_weather（真的去查天气）
        ↓
④  把查到的结果交回给模型
        ↓
⑤  模型把结果组织成人话：「北京今天晴，25 度」
        ↓
⑥  程序把这句话发到群里
```

**关键点**：模型只会"说要做什么"，真正动手的是**工具**。

### 1.2 一个比喻

把 AI 模型想象成一个**被锁在房间里的人**：

- 他极其聪明，什么都懂，知道该查天气、该算数、该翻译
- 但他在房间里，**碰不到任何东西**，上不了网、看不了文件
- 墙上有一些**洞**，每个洞对应一个"工具"
- 他喊"我要用 3 号洞"，你就把 3 号洞外面拿到的东西塞进去
- 他拿到东西，再开口说话

**Skill 就是给墙上多开一个洞，并且告诉这个人："这有个洞，能拿天气信息，需要填城市名。"**

### 1.3 Skill 里装了两样东西

一个 Skill 就是一个文件夹，里面最重要的两个文件：

| 文件 | 它是什么 | 比喻 |
|---|---|---|
| `skill.json` | 说明书 | 贴在洞旁边的标签：这个洞叫什么、能拿什么、怎么用 |
| `index.js` | 干活的代码 | 洞外面的那只手，真的去取东西 |

除此之外还有一个 `README.md`，只是给自己看的备注，程序不读它。

### 1.4 你能给机器人加的三样东西

| 想做的事 | 对应概念 | 在哪个文件写 |
|---|---|---|
| 让机器人多一个新动作（查天气、算数、翻译…） | **工具**（tool） | `index.js` |
| 让机器人多懂一条规矩（"回答要简短"、"别用感叹号"…） | **提示词片段**（prompt section） | `skill.json` |
| 让机器人多一项绝活，供**别的** Skill 借用 | **能力**（capability） | 两个文件都要写 |

新手 99% 的情况只需要第一样：**加一个工具**。后两个是进阶内容，第八章再讲。

---

## 第二章 三条命令做出第一个 Skill

### 2.1 准备工作

确认你已经能正常运行这个项目（能打开控制台页面、机器人能回话）。
如果还没有，先去看项目根目录的 `README.md`，把环境跑起来再回来。

### 2.2 第一步：生成骨架

打开命令行（在项目文件夹里），输入这一条，回车：

```bash
npm run new:skill my-first-skill -- --name "我的第一个技能" --category utility --desc "用来练手的技能"
```

**这条命令在说什么**（不用背，理解就行）：

| 部分 | 意思 |
|---|---|
| `my-first-skill` | 技能的英文代号，只能用小写字母、数字、`-` `_` `.` |
| `--name "我的第一个技能"` | 显示给人看的中文名，随便起 |
| `--category utility` | 归类到哪一类，只能填五个值之一（见 3.1） |
| `--desc "..."` | 一句话介绍，会显示在设置页 |

回车后会看到这样的输出：

```
✅ 已生成：skills\my-first-skill
   格式：LLM 型（skills/ + skill.json + setup）
   分类：utility
   工具：my-first-skill__run
```

**成功了。** 现在去项目文件夹里找 `skills\my-first-skill\`，里面会有三个文件。

> 如果要做成**确定性型插件**（放进 `plugins\` 文件夹、满足条件必然触发），加 `--legacy` 参数，
> 并读 [plugin-development.md](./plugin-development.md)。选哪一型见该文档第 0 节。

### 2.3 第二步：启动开发模式

```bash
QQ_AGENT_DEV=1 npm run server
```

Windows 的命令行如果上面这条不管用，用这条：

```
set QQ_AGENT_DEV=1 && npm run server
```

这一步的作用：**你改完文件保存，程序会自动重新加载，不用重启**。
（如果不加 `QQ_AGENT_DEV=1`，改完必须重启才生效。）

启动后命令行里会出现：

```
[skill] 热重载已启用（监听 skills + plugins）
```

### 2.4 第三步：确认它活了

打开控制台页面 → 顶部找到 **技能** 页签 → 应该能看到「我的第一个技能」，
状态显示 **生效中**。

> ℹ️ 顶部有两个挨着的页签：**「技能」** 和 **「插件」**。
> 本指南教的是**技能**（LLM 型，放在 `skills/`），它的功能由模型决定什么时候调用。
> 旁边那个「插件」页签装的是另一种东西（**确定性型**，放在 `plugins/`，满足条件一定会执行）——
> 两页互不混入，所以在「技能」页找不到插件是正常的，去「插件」页看。

再去 **模型目录** 页（或者叫工具页），能看到一个工具叫 `my-first-skill__run`。

> 这个名字的规律：`技能代号__工具代号`，中间是**两个下划线**。
> 这是程序自动拼的，你写的时候只写 `run` 就行。

### 2.5 现在它已经能用了

回到 QQ 群，@ 机器人说一句话，它就有可能调用这个工具。
不过骨架里的工具是"把你说的话原样返回"，没什么实际用处 —— 接下来我们改成真东西。

---

## 第三章 说明书怎么写（`skill.json`）

用记事本或任何编辑器打开 `skills\my-first-skill\skill.json`。

⚠️ **重要提醒**：这个文件必须是 **UTF-8 编码**。
Windows 记事本另存为的时候，编码选 `UTF-8`。
（程序会自动处理一种叫 BOM 的小毛病，但养成好习惯更省事。）

### 3.1 完整字段表

骨架长这样（我加了注释，真实的文件里没有注释）：

```json
{
  "id": "my-first-skill",
  "name": "我的第一个技能",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "用来练手的技能",
  "author": "Your Name",
  "enabledByDefault": true,
  "capabilities": ["my_first_skill.run"],
  "requires": [],
  "settings": { "prefix": "结果", "verbose": false },
  "configSchema": {
    "prefix": { "type": "string", "label": "输出前缀", "description": "默认「结果」" },
    "verbose": { "type": "boolean", "label": "详细输出" }
  },
  "prompt": {
    "sections": [
      {
        "id": "my_first_skill-note",
        "title": "我的第一个技能",
        "priority": 40,
        "content": "需要的时候调用 run 工具。"
      }
    ]
  }
}
```

每个字段是干嘛的：

| 字段 | 必填 | 大白话解释 | 写错会怎样 |
|---|---|---|---|
| `id` | **是** | 技能的唯一代号，不能和别人重名 | 不合法就加载不了 |
| `name` | **是** | 显示给人看的中文名 | 没写就用 id 顶替 |
| `version` | **是** | 版本号，随便写但要像 `1.0.0` | 没写就是 `0.0.0` |
| `apiVersion` | 否 | 固定写 `1`，这是给未来升级留的 | 写大于 1 会提示不兼容 |
| `category` | 否 | 归类，**只能填五个值之一**（见下） | 填别的会被偷偷改成 `utility` |
| `description` | 否 | 一句话说明，显示在设置页 | 空着不好看 |
| `author` | 否 | 作者名 | 空着 |
| `enabledByDefault` | 否 | 装上后默认开还是关。默认 `true`（开） | — |
| `capabilities` | 否 | 这个技能**能提供**什么能力（进阶，第八章） | — |
| `requires` | 否 | 这个技能**依赖**什么能力（进阶，第八章） | 依赖不满足时技能会变"不可用" |
| `settings` | 否 | 各项设置的**默认值** | — |
| `configSchema` | 否 | 设置项长什么样（第七章） | 没写用户在设置页看不到任何可调项 |
| `prompt.sections` | 否 | 写给模型看的规矩（第六章） | 不写，模型可能不知道啥时候用你的工具 |

### 3.2 `category` 只能填这五个

| 填什么 | 中文意思 | 什么时候用 |
|---|---|---|
| `utility` | 工具类 | 算数、转换、小助手 —— **拿不准就填这个** |
| `media` | 媒体类 | 处理图片、视频、语音 |
| `message` | 消息类 | 影响机器人怎么说话、怎么称呼人 |
| `model` | 模型类 | 影响请求怎么发给 AI 模型 |
| `knowledge` | 知识类 | 知识库、记忆相关 |

**填了别的会怎样？** 程序不会报错，而是**偷偷把它改成 `utility`**，并在日志里写一行警告。
所以你自己写的时候别写 `productivity` 这种看起来合理但不在表里的词。

### 3.3 `id` 的命名规矩

- 只能用：小写字母、数字、`-`、`_`、`.`
- 必须以字母或数字开头
- 举例：✅ `weather-query`、`my_skill_2` ❌ `Weather Query`（有空格和大写）、`天气`（中文）

### 3.4 改完要做什么

保存文件 → 因为开着开发模式，程序会自动重新加载 → 回到控制台技能页确认状态还是"生效中"。

如果状态变成"加载失败"，跳到[第十章](#第十章-出错了怎么查)对照排查。

---

## 第四章 干活的部分怎么写（`index.js`）

打开 `skills\my-first-skill\index.js`。这一章我们把骨架拆开讲。

### 4.1 整体结构

文件长这样（先看个大概，别怕）：

```js
let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;

  api.registerTool({
    id: 'run',
    name: '我的第一个技能',
    description: '这里写工具是干什么的',
    category: 'system',
    parameters: { ... },
    async execute(_ctx, toolArgs) {
      // 真正干活的代码
      return { content: '结果' };
    }
  });
}
```

你需要改的只有**三个地方**（后面用 🔧 标出来），其余照抄。

**先解释几个必须知道的词**：

| 词 | 大白话 |
|---|---|
| `setup(api)` | 程序的"进门打招呼"环节，技能被加载时会喊一次。你在里面登记工具。 |
| `api.registerTool({...})` | "我要登记一个工具"，括号里描述这个工具 |
| `parameters` | 这个工具需要用户提供哪些信息（比如查天气需要"城市"） |
| `execute(...)` | 真正干活的代码，写在里面 |
| `return` | "把结果交出去" |

### 4.2 第一部分：登记工具

```js
api.registerTool({
  id: 'run',                    // ← 工具代号，只用小写字母和 -
  name: '我的第一个技能',          // ← 显示名
  description: '把输入原样返回',    // ← 🔧 给模型看的说明（非常重要！）
  category: 'system',
  parameters: { ... },           // ← 需要什么参数
  async execute(_ctx, toolArgs) { ... }
});
```

**`description` 是全场最重要的一个字段。**

因为模型就是靠这句话决定"要不要用这个工具"。写得含糊，模型就不会用；写得清楚，它才会在合适的时机调用。

| 写法 | 效果 |
|---|---|
| ❌ `处理数据` | 模型不知道啥时候该用，基本不会调用 |
| ❌ `一个工具` | 同上 |
| ✅ `查询指定城市的实时天气，返回温度和天气状况。当用户问天气、气温、要不要带伞时使用。` | 模型一看就懂 |

### 4.3 第二部分：告诉它要什么参数

`parameters` 用的是固定格式（叫 JSON Schema，不用记名字，照格式填）：

```js
parameters: {
  type: 'object',
  properties: {
    city: {
      type: 'string',                    // 类型：string 文字 / number 数字 / boolean 是或否
      description: '城市名，例如 北京'      // 说明，模型靠它知道该填什么
    },
    days: {
      type: 'number',
      description: '要查未来几天，不填默认 1'
    }
  },
  required: ['city']                     // 哪些是必填的
}
```

**要点**：

- 每个参数都要写 `description`，模型才能填对。
- `required` 里列的是必填项。没列进去的，模型可能不填，你要在代码里准备默认值。
- 参数名建议用英文小写（`city`、`days`），因为最后会变成程序里的名字。

### 4.4 第三部分：干活

```js
async execute(_ctx, toolArgs) {
  const city = String(toolArgs?.city ?? '').trim();

  // 1) 先检查参数对不对
  if (!city) return { content: '缺少城市名', isError: true };

  // 2) 干活，用 try 包起来防止出错崩溃
  try {
    const result = 做点什么(city);
    return { content: result };          // 成功
  } catch (error) {
    return { content: `失败了：${error.message}`, isError: true };
  }
}
```

**三条铁律**：

1. **先检查参数**。用户（其实是模型）可能传空值，不检查就会报错。
2. **用 `try { } catch { }` 包住**。万一出错，要返回一句人话，而不是让整个机器人卡死。
3. **必须 `return`**。返回的格式只有两种：

| 情况 | 怎么写 |
|---|---|
| 成功 | `return { content: '要给模型看的结果' };` |
| 失败 | `return { content: '出错说明', isError: true };` |

> `content` 里放的是**给模型看的资料**，不是直接发给群友的话。
> 模型看完之后，会自己组织成一句自然的回复。

### 4.5 一个真实的例子

把骨架的 `execute` 换成这个，就变成了一个真正能用的"掷骰子"工具：

```js
async execute(_ctx, toolArgs) {
  const count = Math.min(10, Math.max(1, Number(toolArgs?.count) || 1));
  const results = [];
  for (let i = 0; i < count; i++) {
    results.push(1 + Math.floor(Math.random() * 6));
  }
  return { content: `掷了 ${count} 个骰子，点数分别是：${results.join('、')}，总和 ${results.reduce((a, b) => a + b, 0)}` };
}
```

对应地把 `parameters` 改成：

```js
parameters: {
  type: 'object',
  properties: {
    count: { type: 'number', description: '掷几个骰子，1 到 10，不填默认 1 个' }
  },
  required: []
}
```

再把 `description` 改成：`掷骰子随机得到点数。当用户说"掷骰子""来个随机数""摇个点数"时使用。`

保存 → 去群里发一句「@机器人 掷三个骰子」→ 它应该会调用这个工具并报点数。

**恭喜，你已经会写 Skill 了。** 剩下的章节都是锦上添花。

### 4.6 `execute` 还能拿到什么（`_ctx`）

第一个参数 `_ctx`（骨架里用下划线开头，表示"暂时不用"）里装着**当前这次对话的全部信息**。
需要的时候把下划线去掉就能用：

| 里面的东西 | 是什么 | 能拿来干嘛 |
|---|---|---|
| `ctx.chatKey` | 当前是哪个群/哪个私聊 | 区分场景 |
| `ctx.kind` | 是群还是私聊 | 分情况处理 |
| `ctx.chatId` | 群号或 QQ 号 | 显示用 |
| `ctx.botName` | 机器人自己的名字 | 自我介绍 |
| `ctx.selfId` | 机器人自己的 QQ 号 | 判断"是不是我" |
| `ctx.store` | 消息存档 | 读聊天记录 |
| `ctx.memory` | 长期记忆（对群友的印象） | 读/写印象 |
| `ctx.stickers` | 表情包库 | 找表情 |
| `ctx.sender` | 发送器 | **主动发消息**（进阶用法） |
| `ctx.reminders` | 定时提醒 | 定个闹钟 |
| `ctx.onebot` | 和 QQ 通信的接口 | 禁言、撤回、踢人等群管理（进阶） |
| `ctx.emit` | 往控制台推事件 | 让界面实时刷新 |

新手常用的是 `ctx.chatKey` 和 `ctx.kind`。其它的等你需要了再查。

---

## 第五章 完整实例：从零做一个天气 Skill

跟着走一遍，把前面学的串起来。

### 5.1 生成骨架

```bash
npm run new:skill weather-query -- --name "天气查询" --category utility --desc "查询指定城市的实时天气"
```

### 5.2 改说明书

打开 `skills\weather-query\skill.json`，把这几处改掉：

```json
{
  "id": "weather-query",
  "name": "天气查询",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "utility",
  "description": "查询指定城市的实时天气，支持国内外城市",
  "author": "你的名字",
  "enabledByDefault": true,
  "permissions": ["web_fetch"],
  "prompt": {
    "sections": [
      {
        "id": "weather-note",
        "title": "天气查询",
        "priority": 40,
        "content": "用户问天气、气温、要不要带伞、穿什么衣服时，调用 get_weather 工具，city 参数从用户的话里提取城市名。查完之后用自然的语气转述，不要照抄数据格式。"
      }
    ]
  }
}
```

⚠️ **注意多了一行 `"permissions": ["web_fetch"]`**。

这是**联网许可证**。程序默认不允许 Skill 上网（防止有人偷偷传数据出去）。
你要联网查天气，就必须声明这个权限，否则代码里根本拿不到 `api.fetch`（一调用就报错"未声明 web_fetch 权限"）。

> 骨架上没有这一行，需要自己加，位置放在 `"author"` 后面就行。

### 5.3 改操作手册

打开 `skills\weather-query\index.js`，整个替换成：

```js
// 天气查询：通过 wttr.in 免费接口查实时天气
let log = () => {};

export function setup(api) {
  log = api.log;

  api.registerTool({
    id: 'get_weather',
    name: '查询天气',
    description: '查询指定城市的实时天气，返回温度、天气状况、湿度。当用户问天气、气温、要不要带伞时使用。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，中英文都可以，例如 北京 或 Beijing' }
      },
      required: ['city']
    },
    async execute(_ctx, toolArgs) {
      const city = String(toolArgs?.city ?? '').trim();
      if (!city) return { content: '缺少城市名', isError: true };

      try {
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        const res = await api.fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`接口返回 ${res.status}`);
        const data = await res.json();

        const now = data.current_condition?.[0];
        if (!now) throw new Error('没查到这座城市');

        return {
          content: [
            `城市：${city}`,
            `温度：${now.temp_C}°C`,
            `天气：${now.weatherDesc?.[0]?.value ?? '未知'}`,
            `湿度：${now.humidity}%`
          ].join('\n')
        };
      } catch (error) {
        return { content: `查天气失败：${error.message}`, isError: true };
      }
    }
  });
}
```

> ⚠️ 注意：`api` 在 `execute` 里也能用（因为它是 `setup(api)` 的参数，写在里面的函数能"看见"它）。
> 但只有声明了 `web_fetch` 权限才真的能用。

### 5.4 保存并验证

1. 保存文件（开发模式下会自动重新加载）
2. 命令行里应该出现「检测到变化…重新扫描…热重载完成」
3. 打开控制台 → 技能页 → 「天气查询」状态是**生效中**
4. 去群里发：「@机器人 今天北京天气怎么样？」
5. 机器人应该回一段自然的话，比如「北京今天晴，25 度，湿度 40%，挺舒服的～」

### 5.5 如果没成功

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 技能页显示"依赖未就绪" | 少了 `permissions` | 检查 `"permissions": ["web_fetch"]` 有没有写 |
| 技能页显示"加载失败" | 代码有语法错误 | 看命令行里的报错，通常会说第几行 |
| 状态正常但机器人不用它 | `description` 写得太含糊 | 把触发场景写具体（1.4 节那个对比表） |
| 机器人说"查天气失败" | 网络问题或城市名查不到 | 属于正常失败，工具已经返回了人话提示 |

---

## 第六章 让机器人知道该用它（提示词）

### 6.1 为什么需要这个

模型同时面对几十个工具，它怎么知道什么时候该用你的？

靠两个地方：
1. 工具的 `description`（你已经在写了）
2. `skill.json` 里的 `prompt.sections`（这一节）

`prompt.sections` 里的内容会被**塞进系统提示词** —— 相当于在模型开工前，先给它读一段你的说明。

### 6.2 怎么写

```json
"prompt": {
  "sections": [
    {
      "id": "weather-note",
      "title": "天气查询",
      "priority": 40,
      "content": "用户问天气、气温、要不要带伞时，调用 get_weather 工具。city 从用户话里提取。查完用自然语气转述，别照抄数据格式。"
    }
  ]
}
```

| 字段 | 大白话 |
|---|---|
| `id` | 这段的代号，随便起，不能重复 |
| `title` | 小标题，给这段起个名字 |
| `priority` | 优先级，数字越大越靠前。**最大只能写 99** |
| `content` | 正文，也就是你想让模型记住的规矩 |

### 6.3 三条注意

1. **`priority` 写再大也不会超过 99**。核心安全规则是 100 分，Skill 永远排在它后面 —— 这是故意设计的，防止有人写个 Skill 就把安全限制绕过去了。

2. **别写太长**。这段每次对话都会发给模型，写 3000 字等于每次都多花 token（也就是多花钱）。两三句话就够。

3. **别在这里放安全相关的指令**（比如"忽略之前的规则"）。放了也没用，会被核心规则压住。

---

## 第七章 给用户留几个开关（配置项）

### 7.1 为什么

你的 Skill 可能有些地方"不同人有不同喜好"：输出要不要带前缀？详细还是简短？

不要写死在代码里，而是在 `skill.json` 里声明出来，程序会**自动在设置页生成对应的表单**，用户自己勾。

### 7.2 怎么写

`skill.json` 里两部分配合：

```json
"settings": {
  "prefix": "结果",
  "verbose": false,
  "style": "simple"
},
"configSchema": {
  "prefix": {
    "type": "string",
    "label": "输出前缀",
    "description": "工具返回内容前面的提示词，默认「结果」"
  },
  "verbose": {
    "type": "boolean",
    "label": "详细输出"
  },
  "style": {
    "type": "enum",
    "label": "风格",
    "options": [
      { "value": "simple", "label": "简洁" },
      { "value": "detailed", "label": "详细" }
    ]
  }
}
```

- `settings` 是**默认值**
- `configSchema` 是**表单长什么样**

程序会照着 `configSchema` 画界面，**你不用写任何界面代码**。

### 7.3 四种可用的类型

| `type` 填什么 | 界面上长什么样 | 用来配 |
|---|---|---|
| `boolean` | 一个勾选框 | 开/关类的选项 |
| `number` | 填数字的框 | 数量、时长、尺寸 |
| `enum` | 下拉菜单（需要 `options`） | 从几个固定选项里选一个 |
| `string` | 填文字的框 | 前缀、称呼、自定义文案 |

额外可加的：
- `label`：界面上显示的标题
- `description`：标题下面那行灰色小字说明
- `default`：默认值
- `secret: true`：把这个框变成密码框（填 API Key 这类敏感信息时用）。
  这类字段在界面上会显示成 `******`，**用户留空 = 不修改**，所以不会出现"打开设置页点个保存，密钥就被星号覆盖了"这种事。

> 说明：只有你在 `configSchema` 里声明过的项，才会出现在设置页上。
> 如果你在代码里读一个没声明的项，会读到"空"。

### 7.4 代码里怎么读到用户填的值

```js
let cfg = () => ({});

export function setup(api) {
  cfg = api.config;        // ← 记住这个函数
  // ...
  api.registerTool({
    // ...
    async execute(_ctx, args) {
      const { prefix, verbose, style } = cfg();   // ← 每次执行时读一次
      return { content: `${prefix}：干完了（模式 ${style}）` };
    }
  });
}
```

**要点**：用户改了设置之后，下一次执行就会读到新值，**不需要重启**。

---

## 第八章 进阶：能力和钩子

> 这一章可以先跳过。等你有"想改机器人本身的行为"的需求时再回来看。

### 8.1 能力（capability）—— 让别的 Skill 用你的东西

假设你写了个"语音转文字"的 Skill。别人可能想用它，但不该直接抄你的代码。

**做法**：你声明一个"能力名"，别人按名字来取。

你这边（提供方）：

```json
"capabilities": ["media.transcribe"]
```

```js
export const providers = {
  'media.transcribe': async ({ filePath } = {}) => {
    return { text: '转出来的文字' };
  }
};
```

别人那边（使用方）有两种方式：

| 方式 | 写法 | 区别 |
|---|---|---|
| 硬依赖 | `skill.json` 里写 `"requires": ["media.transcribe"]` | 你没装/没开，他的技能就显示"不可用" |
| 软依赖 | 代码里 `api.capability('media.transcribe')` | 有你他就增强，没你他也能跑 |

**选择原则**：锦上添花的用软依赖，缺了就没法工作的才用硬依赖。

### 8.2 钩子（hooks）—— 改机器人的行为

钩子能让你在特定时刻插手：

| 钩子名 | 什么时候触发 | 能干什么 |
|---|---|---|
| `before-context` | 组装提示词之前 | 补充上下文 |
| `before-llm-messages` | 消息快要发给模型时 | 修改要发出去的内容 |
| `after-response` | 收到模型回复后 | 加工回复、记点东西 |
| `before-tool` | 某个工具要执行前 | **可以否决这次调用** |
| `after-tool` | 某个工具执行完后 | 统计、加工结果 |

写法：

```js
export const hooks = {
  'after-tool': ({ toolId }) => { log(`工具跑完了：${toolId}`); }
};
```

**四条规矩**：

1. 钩子里出错**不会影响别人** —— 程序只记一条日志，继续跑。
2. 钩子超过 5 秒会被强制跳过。
3. **钩子里不能自己发消息、不能自己重试、不能自己发网络请求。**
4. 钩子只该做"轻量加工"，重活请在工具里干。

### 8.3 自检函数 `available()`

如果你想让程序知道"我这台机器上缺个东西，所以我现在不能用"：

```js
export function available() {
  // 有 ffmpeg 才能用
  if (!装了ffmpeg()) return { ok: false, reason: '没找到 ffmpeg，抽帧需要它' };
  return true;
}
```

⚠️ **这个函数必须"立刻"给出答案，不能等。**

什么叫不能等？就是不能写 `await`、不能做"检查网络"这种要花时间的事。
因为程序在判断"你能不能用时"是**不等结果的** —— 你只要返回一个"还没完成的承诺"，它就会当成"能用"，结果界面显示"生效中"但实际跑不通，非常难查。

那如果我确实要花时间检查（比如试试 ffmpeg 在不在）怎么办？

**用"先放行 + 后台偷偷检查 + 记住结果"的写法**，具体参考项目里的 `skills/video-frames/index.js`。

---

## 第九章 能做什么、不能做什么

### 9.1 能做

在**工具执行的时候**（也就是 `execute` 里），你能拿到完整的环境：

| 想做 | 用什么 |
|---|---|
| 读聊天记录 | `ctx.store` |
| 读写对群友的印象 | `ctx.memory` |
| 找表情包 | `ctx.stickers` |
| 主动发消息（文字/图片/表情包/戳一戳） | `ctx.sender` |
| 定个提醒 | `ctx.reminders` |
| 查群资料、群成员资料 | `ctx.onebot.getGroupInfo` / `ctx.onebot.getGroupMemberInfo` |
| 撤回消息、禁言、踢人 | `ctx.onebot.call('接口名', {...})` —— 直接调 QQ 接口，**用之前想清楚后果** |
| 让控制台界面刷新 | `ctx.emit` |

发消息的例子（`execute` 里）：

```js
await ctx.sender.sendTextBatch(ctx.chatKey, ['大家好'], { atUserId: null });
```

### 9.2 不能做（或不该做）

| 不能 | 原因 |
|---|---|
| 在 `setup(api)` 里操作 QQ | 那时候只给你登记工具的权力，拿不到 QQ 接口 |
| 在钩子里发消息、重试、发网络请求 | 钩子是"轻量加工"，重活会拖慢所有人的对话 |
| 覆盖核心安全规则 | 提示词优先级被强制压在 99 以下，写了也没用 |
| 绕过 `web_fetch` 权限偷偷联网 | 不声明权限，`api.fetch` 一调用就报错 |
| 用 `:` 或 `.` 拼工具 id | 会让发给 AI 模型的请求被拒（整个请求失败，不只是你的工具） |
| 让 `available()` 返回等待中的结果 | 界面会显示假的"生效中" |

### 9.3 工具 id 的三条硬规矩

1. 程序会**自动加前缀**：你写 `run`，实际变成 `技能代号__run`。你只写短名。
2. 只能用**字母、数字、`-`、`_`**。其它字符会被替换成 `_`。
3. **别用 `:` 或 `.` 拼接**。这是最常见的坑 —— 模型那边的接口不接受这种名字，会**直接拒掉整次请求**（不是你一个工具失效，是这次对话整个失败）。

---

## 第十章 出错了怎么查

### 10.1 三个查错的地方

| 去哪看 | 能看到什么 |
|---|---|
| 命令行窗口 | 加载日志、报错信息、热重载记录 —— **最先看这里** |
| 控制台 → 技能页 | 每个技能的状态和"为什么不能用" |
| 控制台 → 模型目录页 | 每个工具的可用状态 |

### 10.2 状态含义对照表

技能页上的状态是这么算出来的：

```
加载成功？ → 用户开了？ → 依赖齐了？ → 三个都满足 = 生效中
```

| 状态/提示 | 意思 | 怎么办 |
|---|---|---|
| 生效中 | 一切正常 | — |
| 已关闭 | 用户自己关掉了 | 在设置页打开 |
| 依赖未就绪 | 缺东西（缺权限、缺 ffmpeg、缺别的技能） | 看后面的原因说明 |
| 加载失败 | 代码或说明书有错 | 看命令行的报错 |
| 找不到 | 没这个技能 | 检查文件夹名和 `id` |

### 10.3 常见错误速查

| 报错/现象 | 原因 | 怎么修 |
|---|---|---|
| `Unexpected token` | `skill.json` 里少了逗号、多打了逗号，或者引号没配对 | 用在线 JSON 校验工具检查一下 |
| `缺少 id` | `skill.json` 里没写 `id` | 补上 |
| `id 只能包含字母/数字/._-` | id 里有空格或中文 | 改成英文小写 |
| `invalid function name`（模型报 400） | 工具 id 里用了 `:` 或 `.` | 只用 `-` 和 `_` |
| 界面显示"生效中"但工具跑不通 | `available()` 返回了要等待的结果 | 改成同步返回 |
| 改完文件没反应 | 没开开发模式 | 用 `QQ_AGENT_DEV=1 npm run server` 重启 |
| 返回内容里有 `fetch failed` | 网络不通，或对方接口挂了/地址写错 | 先用浏览器打开那个网址试试通不通 |
| 返回内容里有 `未声明 web_fetch 权限` | 忘了声明联网许可 | 在 `skill.json` 里加 `"permissions": ["web_fetch"]` |
| 中文变成乱码 `锛?` | 用 PowerShell 读写过文件 | 见 10.4 |
| 一切都对但模型不用它 | `description` 不够具体 | 加上"当用户说……时使用" |

### 10.4 中文变乱码（Windows 用户特别注意）

**绝不要用 PowerShell 读写项目里的文件。**

Windows PowerShell 5.1 读文件时，如果文件没有特殊标记，会按系统老编码（中文系统上是 GBK）理解，
而我们的文件是 UTF-8 —— 结果中文全变乱码，而且**再存回去就永久损坏了，救不回来**。

表现：`：` 变成 `锛?`。

**正确做法**：用记事本、VS Code 之类的编辑器打开改，另存时选 UTF-8。
只想看内容不修改的话，随便看没问题。

### 10.5 别忘了跑自检

改完 Skill 之后，跑这两条命令，能揪出很多"不报错但功能失灵"的问题：

```bash
npm run test:skill     # 检查技能机制（钩子/能力/开关）
npm run test:audit     # 检查所有工具和技能是否自相矛盾
```

`test:audit` 特别有用，它会检查这些**不报错但很坑**的情况：

- 声明了能力，代码里却没实现（调用方拿到空的东西，静默失效）
- 实现了能力，说明书里却没声明（用户看不出它能提供什么）
- 一个能力被两个技能抢着提供（谁能用取决于加载顺序，很不稳定）
- 工具依赖的能力没有任何技能提供（这个工具永远用不了）
- 参数格式写错了
- `available()` 返回了等待中的结果

---

## 第十一章 测试与上架

### 11.1 自己先试

1. **开发模式跑起来**：`QQ_AGENT_DEV=1 npm run server`
2. **技能页确认"生效中"**
3. **群里真机试**：正常说一句话、说得含糊一点、故意不给参数、看它会不会崩
4. **跑自检**：`npm run test:skill`

### 11.2 上架到 Skill 市场

把你的技能文件夹压缩成 zip：

```
weather-query.zip
└── weather-query/
    ├── skill.json
    ├── index.js
    └── README.md
```

然后打开 <https://www.kondius.cn/qq-agent/skill-market/> → 点「上传 Skill ZIP」→ 选文件。

**上传的硬性要求**：

| 要求 | 说明 |
|---|---|
| 必须是 zip | 别的压缩格式不行 |
| 不超过 8 MB | |
| 解压后不超过 32 MB | |
| 文件数不超过 100 个 | |
| 不能有可执行文件 | `.exe` `.dll` `.bat` `.cmd` `.ps1` `.vbs` `.sh` 一律拒绝 |
| 不能有危险路径 | 包含 `..` 或绝对路径的会被拒 |
| `id` 不能重名 | 重名会返回"已存在"，换个 id |

上传成功后，市场列表里就能看到你的技能，别人可以下载。

> 安全提醒：Skill 会在别人的机器人里运行。上传前请检查一遍代码里有没有
> 你自己的 API Key、密码、或者不该公开的东西 —— **不要把这些写进 Skill**。

### 11.3 别人怎么用你的 Skill

1. 从市场下载 zip
2. 解压到自己的 `skills/` 目录
3. 重启（或用开发模式）
4. 在技能页确认状态、按需要调设置

---

## 附录 名词对照表

| 你看到的名词 | 大白话 |
|---|---|
| Skill / 技能 | 给机器人加的一个能力包（一个文件夹） |
| 插件 / plugin | 老叫法，现在叫 Skill。老的还能用 |
| 工具 / tool | Skill 提供的一个具体动作 |
| 能力 / capability | Skill 提供的"绝活"，给别的 Skill 借用 |
| 钩子 / hook | 在特定时刻插手改行为 |
| 清单 / manifest | 就是 `skill.json` 这个说明书 |
| 模型 / model | 真正动脑子的 AI（DeepSeek、GPT 等） |
| 提示词 / prompt | 给模型看的说明和规矩 |
| 上下文 / ctx | 当前这次对话的全部信息 |
| 热重载 | 改完文件自动生效，不用重启 |
| 参数 / parameters | 工具需要用户提供哪些信息 |
| 状态 | 技能现在能不能用 |

---

## 遇到问题怎么办

1. **先看命令行窗口的报错**，通常写得很清楚
2. **对照 [10.3 常见错误速查](#103-常见错误速查)**
3. **跑 `npm run test:audit`**
4. 还搞不定，去群里问，记得把**命令行里的报错原文**贴出来 —— 光说"不生效"没法查

祝你玩得开心 🎉
