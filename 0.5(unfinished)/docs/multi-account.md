# 多账号（账号中心）—— 0.5 移植版

> 状态：0.5 本身仍是**未完成/未验收**版本。本页只说明多账号能力在 0.5 中的入口、
> 边界与验证结果；它不把 0.5 的其他功能宣称为已完成。
>
> 0.4 的完整说明（数据边界、协议端、备份、排查）见
> [`../../../0.4/doc/extend_development/multi-account.md`](../../../0.4/doc/extend_development/multi-account.md)。
> 数据目录、注册表、模板脱敏、端口分配、HUB API 与 0.4 完全一致。

---

## 1. 入口

| 用途 | 命令 | 默认地址 |
|---|---|---|
| 账号中心（桌面） | `npm run desktop`（`package.json` 的 `main` 已指向 `electron/accounts-main.js`） | `http://127.0.0.1:3211/` |
| 账号中心（headless） | `npm run server:accounts` | `http://127.0.0.1:3211/` |
| 1 号账号控制台 | 由账号中心启动 | `http://127.0.0.1:3210/` |
| 原来的单号入口（保留） | `npm run desktop:single` / `npm run server` | 3210 |

原来的 `electron/main.js` 与 `src/server.js` **没有被替换**：0.5 的启动组合代、
控制台令牌桥、桌面生命周期测试都还绑定在它们上面。多账号使用独立入口，
两者互不影响。需要回到单号/启动组合验证时，用 `desktop:single` 或 `server`。

---

## 2. 运行形态

```text
QQ Agent 进程（一个）
├── 账号中心 HUB（3211）
├── worker 线程：1 号（QQ_AGENT_DATA_DIR=data，QQ_AGENT_PORT=3210）
└── worker 线程：2 号（data/accounts/<id>，3212+）
```

- 每个 worker 在 import 0.5 内核前设置 `QQ_AGENT_DATA_DIR` / `QQ_AGENT_PORT`，
  然后 `createApplication({ headless: true, env })`。
- 0.5 的内核本来就是工厂装配，所以不需要像 0.4 那样绕过模块级 `DATA_DIR`；
  但**仍然用 worker 隔离**，保证两个内核的模块单例、定时器、日志、权限与
  生命周期互不共享。
- `overrides/` 启动组合是应用级可信层：所有账号共享同一份 `overrides/`，
  每个内核各自解析一次。若某个覆盖层把“整个应用”替换成单例资源，需要作者
  自行保证多实例可重入；普通插件/技能不受影响。
- 启停、自动重启、单号暂停/恢复、删除回收（`accounts/.trash/`）与 0.4 相同。

---

## 3. 隔离边界

与 0.4 一致：

| 项目 | 1 号 | 其它号 |
|---|---|---|
| 配置 / Key / 白名单 / 人设 / 提醒 | `data/config.json` | `data/accounts/<id>/config.json` |
| 记忆 / 存档 / 会话 / 用量 | `data/…` | `data/accounts/<id>/…` |
| 技能与插件开关/配置 | 各自 `config.skills` | 各自 `config.skills` |
| 技能与插件代码 | `skills/`、`plugins/`、`bundled/` | 同一份 |
| 日志 / 运行状态 | `data/logs/`、`data/account-runtime.json` | 各自目录 |
| 启动组合 `overrides/` | 应用级共享 | 应用级共享 |

新账号创建时复制设置模板并擦除密钥/令牌/Cookie、清空白名单/屏蔽名单/分群人设/
指令禁言；记忆、存档、用量天然为空。

---

## 4. UI

- 账号中心页面复用 0.4 的 `ui/hub/`（深/浅色、账号卡片、今日用量、协议端可达性、
  重复端口/地址告警）。
- 每个账号的 0.5 控制台由 `ui/shell/account-center.js` 在顶栏注入
  「账号：… / ← 账号中心」；单号直接运行时 `/api/account-context` 返回
  `multiAccount:false`，界面不变。
- 新增只读接口 `GET /api/account-context`（0.5 的 `src/console/routes.js`），
  返回当前账号 id/名称与 HUB 地址，不含密钥。

---

## 5. 验证

| 项 | 结果 |
|---|---|
| `node test/accounts-registry-test.mjs` | 9 项通过 |
| `node test/accounts-supervisor-test.mjs` | 真实 0.5 内核 × 2 账号 + 假 OneBot：隔离/启停/HUB/删除全部通过 |
| `node test/174-composed-application-test.mjs` | 通过（原单号入口与组合未被破坏） |
| `node test/09-http-test.mjs` | 37 项通过（新增只读路由不影响原 HTTP/鉴权/静态） |
| `npm run smoke` | 12 项通过（原 `src/server.js` 单号入口仍可用） |

未完成/环境限制：
- `npm test` 全量需要 `playwright-core`、`electron-builder` 等 devDependencies；
  当前环境没有安装，涉及浏览器夹具/安装器的用例会报 `MODULE_NOT_FOUND`，
  与多账号改动无关。
- 0.5 的真实 QQ 联调、安装包、社区发布仍未验收；本页不把这些算作已通过。

---

## 6. 已知边界

1. **协议端仍是一号一套**：QQ 协议端必须为每个号提供独立 OneBot 端口；0.5 的
   transport 解析器对空地址会明确报“OneBot 地址无效”，不会回退到 3001。
2. **控制台令牌**：账号中心按账号配置里的 `server.token` 拼 `?token=`；0.5 的
   控制台鉴权以启动时注入/请求头为主，若你给某个号设置了非空令牌，建议先在
   该号设置页确认能正常打开，再依赖账号中心跳转。默认留空（只监听 127.0.0.1）。
3. **`js-yaml` 兼容**：0.5 依赖 `js-yaml@^4`，本机安装的是 5.x；`src/console/
   provider-catalog.js` 已改为命名空间导入（`import * as yaml`），4/5 均可运行。
4. **启动组合**：`overrides/` 由所有账号共享；要按号使用不同覆盖层，需要把
   `APP_ROOT` 指向不同的程序副本（不是数据目录），这属于部署级选择。
