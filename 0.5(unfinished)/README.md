# QQ Agent 0.5（DSH 架构）

QQ Agent 的 DSH 重写版（薄内核 + 全插件外壳）。行为以规格书为验收依据，当前实现和验收边界记录在下方进度文件中。

## 安装与连接

本版本仍在开发和验收中。需要 Node.js 20 或更新版本，并由用户自行准备提供 OneBot v11 正向 WebSocket 事件和 HTTP API 的外部协议端。

```bash
git clone https://github.com/K0nd1us/QQ-agent.git
cd "QQ-agent/0.5(unfinished)"
npm install
npm run desktop
```

无桌面环境时运行 `npm run server`，再打开 `http://127.0.0.1:3210`。

按协议端自身说明完成安装、启动与登录后，在设置页「OneBot」填写 WebSocket 地址、HTTP API 地址及各自访问令牌。对应配置项为 `onebot.wsUrl`、`onebot.httpUrl`、`onebot.accessToken` 和 `onebot.httpAccessToken`。QQ Agent 不代管外部程序的安装、启动、账号目录或令牌提取；使用许可和客户端版本要求请查阅所选程序的说明。

升级前备份配置和数据，升级后重新填写 OneBot 连接配置。旧版专属运行时配置不自动迁移，已有第三方程序和账号数据不会由本次改动删除。连接后应在测试会话验证所需的收发与媒体行为；自动测试和连接状态不代表真实 QQ 联调已完成。

## 多账号（账号中心）

0.5 现在也有与 0.4 相同的账号中心（一个进程、多个 QQ 号、数据完全隔离）：

```bash
npm run desktop        # 桌面：先打开账号中心（3211），点卡片进入某个号
npm run server:accounts # 无桌面：账号中心 3211，1 号控制台 3210
```

- 原来的单号入口保留：`npm run desktop:single` / `npm run server`。
- 每个号在独立 worker 线程里跑一个完整的 0.5 内核（自己的 data 目录、端口、
  日志、权限、生命周期）；技能/插件代码共用，开关与配置按号独立。
- 新建账号复制 1 号设置模板，但清空 Key/令牌/白名单/屏蔽名单/记忆。
- 细节、入口差异、验证结果与边界见 [多账号说明](docs/multi-account.md)。

## 事实来源

- 行为规格：`../dsh-spec/SPEC.md`（§1–§18，F-001~F-223 + §5/§8/§9 三段式契约）
- 结构图纸：`../dsh-spec/DSH-ARCH.md`
- 2026-10-16 追加式组合规格：[默认实现与追加式组合 v2.1](docs/architecture-composition.md)，取代旧版“固定内核/不可替换内核页”的限制。
- 当前进度：`progress.md`
- 有头验收：`docs/headed-qa-checklist.md`、`docs/headed-qa-results.md`
- 回归证据：`docs/headed-qa-regression-evidence.md`
- 追加式组合验收：[实现与回归证据](docs/composition-regression-evidence.md)，[可复制示例](examples/composition/README.md)。
- 部分重叠贡献：[逐目标替换、方法包装与多层撤销验收](docs/composition-overlap-evidence.md)。
- 决策记录：`../dsh-spec/NEXT-SESSION.md` §3（D-1~D-7）

## 依靠 AI 添加功能

在技能、插件或社区页打开“创作扩展”，直接复制提示词；也可从[文档版提示词](docs/ai-extension-prompt.md)开始。AI 会先用日常话问清并确认需求，再自行读取[开发文档](docs/extension-authoring.md)、判断做成技能还是插件，完成制作、自检并放入对应文件夹。新功能默认禁用，由你在列表中点击启用；无需选择技术类型或自己运行命令，不会自动上传社区。需要 ZIP 时可另行打包。

开发者可查[完整参考](docs/extension-reference.md)，直接复用[完整范例](examples/extensions/README.md)。提供自检、离线执行和社区同格式打包工具：`npm run extension:check -- <目录>`、`npm run extension:test -- <目录> --case <用例文件>`、`npm run extension:pack -- <目录> --out <ZIP路径>`。Windows 安装版可使用 `scripts\extension-dev.cmd`，复用自带运行时。

0.4 扩展迁移先查[逐项能力对照](docs/v04-extension-parity.md)，不要混用旧日志函数、执行参数顺序或 sender。自检、真实 QQ 联调与生产社区发布分别报告结果；本轮过程见[AI 创作验收](docs/ai-extension-validation.md)。

## 工作约定

1. 用户已授权参考 `../develop/` 的公开源码补齐功能；该目录的私有配置、账号、凭据和日志不属于参考范围。
2. 用户已授权同步修订插件化架构规格。修复应附相关验证，区分产品缺陷、未完成的实测和外部条件不足。
3. 本地测试使用独立合成副本；不得将安装校验、模拟接口或自动测试当作真实账号联调通过。
4. 当前 Git 元数据只读，保留现有变更。安装包打包按用户要求延期，完成测试后再统一安排。

## 状态

- 已实现插件宿主、控制台及桌面界面，正在继续修复和本地有头验收。最新完整回归、实际操作记录和剩余条件以 `progress.md` 及上述验收文件为准。
- 外部协议端和 QQ 客户端由用户独立管理；当前版本不提供便携运行时安装、进程管理或登录态迁移。
