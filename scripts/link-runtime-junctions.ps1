# QQ Agent 任务栏版运行时联接重建
# 用途：dist\win-unpacked\QQ Agent.exe 是可以钉到任务栏的"正式身份"版本，
#       通过 Junction 共享 dev 项目的 data/ 与 snowluma/（数据、登录态完全互通）。
# ⚠️ 每次重新构建 electron-builder（dist 被清掉）后，本脚本要重跑一次。
$root = "C:\Users\Kondius\Desktop\qq-agent"
$unpacked = "$root\dist\win-unpacked"

if (-not (Test-Path "$unpacked\QQ Agent.exe")) {
    Write-Host "dist\win-unpacked 不存在——先跑一次 electron-builder 构建。"
    exit 1
}

# data 联接：exe 旁边的 data → 项目 data
if (Test-Path "$unpacked\data") { Remove-Item "$unpacked\data" -Recurse -Force -Confirm:$false }
New-Item -ItemType Junction -Path "$unpacked\data" -Target "$root\data" | Out-Null
Write-Host "OK  data -> $root\data"

# snowluma 联接：resources\app\snowluma → 项目 snowluma（含登录态 config/data）
if (Test-Path "$unpacked\resources\app\snowluma") { Remove-Item "$unpacked\resources\app\snowluma" -Recurse -Force -Confirm:$false }
New-Item -ItemType Junction -Path "$unpacked\resources\app\snowluma" -Target "$root\snowluma" | Out-Null
Write-Host "OK  snowluma -> $root\snowluma"

Write-Host "完成。把 dist\win-unpacked\QQ Agent.exe 固定到任务栏即可。"
