# 双 QQ 号实例

本项目支持在同一台 Windows 机器上运行两个 QQ Agent 实例。主实例不设置 PROFILE，第二实例设置 `QQ_AGENT_PROFILE=2`。

## 准备和启动

1. 先启动并配置主实例，确认 `data/config.json` 已存在。
2. 在项目根目录运行：

   ```text
   node scripts/setup-second-instance.mjs
   ```

3. 分别登录两个 QQ 号，并在 SnowLuma 中为它们配置不同的 OneBot 网络端口。
4. 正常启动主实例；双击 `启动QQ机器人2.bat` 启动第二实例。

脚本只在 `data-2/config.json` 不存在时生成它，重复运行不会覆盖已有第二实例配置。若需要重新生成，请先备份并手动删除该文件。也可以用参数覆盖端口，例如 `--console-port 3310 --http-port 3110 --ws-port 3111`。

## 目录和端口

PROFILE 为空时数据目录是 `data/`；PROFILE 为 `2` 时是 `data-2/`。第二实例默认将 OneBot WS、OneBot HTTP 和控制台端口分别在主实例基础上增加 100。`QQ_AGENT_PORT` 可由配置接线用于直接覆盖控制台端口；`QQ_AGENT_DATA_DIR` 仍可直接覆盖数据目录，并优先于 PROFILE 目录约定。

端口示例：主实例控制台 `3210`，第二实例控制台 `3310`；OneBot 的默认 `3010/3011` 对应第二实例的 `3110/3111`。实际端口以配置和启动日志为准。

## 令牌和登录态

第二实例只生成配置文件，不复制主实例的登录态、锁文件、缓存或其它数据文件。配置中的 OneBot 令牌也会清空，因此必须在第二实例里重新填写令牌。这样可以避免两个 QQ 号共享凭据，也避免把主账号的登录状态误当成第二账号。

## instance-lock 的关系

`instance-lock.js` 锁定的是**实际数据目录**：不同 PROFILE 产生不同目录，所以 `data/` 和 `data-2/` 的锁互不冲突，可以同时运行；同一个 PROFILE 第二次启动仍然使用同一目录，仍会被已有锁挡住。`QQ_AGENT_DATA_DIR` 如果让两个进程指向同一路径，也会重新形成冲突，这是预期行为。

## Electron 行为

窗口标题和托盘 tooltip 会显示 `QQ Agent` 或 `QQ Agent #2`，便于区分实例。主 Electron 进程不自动 spawn 第二个核心进程：当前核心启动和停止都绑定 Electron 生命周期，强行用 `ELECTRON_RUN_AS_NODE` 在内部拉起另一份核心会绕过桌面壳的窗口、锁清理和退出流程，无法可靠保证行为。`启动QQ机器人2.bat` 是明确、可控的替代启动方式。
