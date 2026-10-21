# qq-presence —— 在线状态守卫

QQ 的在线状态是**服务器侧**的：进程被杀掉后，状态会一直挂在「请勿打扰」或「在线」上。
这个插件负责两个时机：

| 时机 | 动作 |
|---|---|
| 关闭前（核心的 `before-shutdown` 钩子，**优雅退出**才触发） | `api.setPresence('dnd')` 把 QQ 设成「请勿打扰」 |
| 上线时（`activate()` 起后台重试循环） | 读本地记账；若上次是**我们设的** DND，就改回「在线」 |

### 为什么必须记账

协议端只有 `set_online_status`、**没有** `get_online_status`（`1404 unknown action`），当前状态读不回来 ——
所以"上次是不是我设的请勿打扰"只能自己记（核心写进 `data/presence.json`，并在 `data/presence.log` 留审计）。
**用户手动设的状态不会被它动。**

### 强杀那条路

`taskkill /F`、`Stop-Process -Force` 不会执行任何 JS，插件不可能感知那次关闭 ——
那种场景需要停止脚本/关机脚本**自己先调** `POST /api/presence`（`{ "status": "dnd" }`）。

### 依赖

核心的 `src/presence.js`、`POST/GET /api/presence`、`before-shutdown` 钩子，
以及 `api.setPresence` / `api.getPresence` / `api.restorePresenceIfDnd`（清单里声明 `permissions: ["presence_control"]`）。
