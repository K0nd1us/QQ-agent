#!/bin/bash
# macOS 双击启动器：Finder 里双击本文件即可启动 QQ Agent。
# 作用：切到项目目录、补全 PATH、清掉 ELECTRON_RUN_AS_NODE（否则 Electron
# 会以纯 Node 模式运行，表现为"双击没反应/启动即退出"）。
set -e
cd "$(dirname "$0")/.." || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
unset ELECTRON_RUN_AS_NODE

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js 20+（https://nodejs.org/ 或 brew install node）"
  read -r -p "按回车退出…" _
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖…"
  npm install
fi

echo "启动 QQ Agent…（关闭本终端窗口不会退出，退出请用托盘菜单）"
exec npm start
