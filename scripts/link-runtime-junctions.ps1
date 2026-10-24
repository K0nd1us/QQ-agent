# QQ Agent 任务栏版运行时联接重建
# 用途：dist\win-unpacked\QQ Agent.exe 是可以钉到任务栏的"正式身份"版本，
#       通过 Junction 共享 dev 项目的 data/ 与 snowluma/（数据、登录态完全互通）。
# ⚠️ 每次重新构建 electron-builder（dist 被清掉）后，本脚本要重跑一次。
#
# 改动说明：
#   1) 项目根用 $PSScriptRoot 推导，不再写死作者本机路径
#      （旧版写死 "C:\Users\Kondius\Desktop\qq-agent"，别人跑会指向不存在/别的目录）。
#   2) 删除旧联接时**只删链接本身**，绝不递归进目标。
#      旧版用 `Remove-Item -Recurse -Force`：在 Windows PowerShell 5.1 下，
#      对 Junction 用 -Recurse 会连**链接目标目录的内容**一起删掉 ——
#      也就是可能误删项目里的 data/（聊天记录、记忆、配置）。
$root = Split-Path -Parent $PSScriptRoot
$unpacked = Join-Path $root 'dist\win-unpacked'

if (-not (Test-Path (Join-Path $unpacked 'QQ Agent.exe'))) {
    Write-Host "dist\win-unpacked 不存在——先跑一次 electron-builder 构建。" -ForegroundColor Yellow
    Write-Host "（推导出的项目根：$root）"
    exit 1
}

function Remove-LinkOnly {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
        $target = $item.Target
        # 只删联接本身（第二个参数 $false = 不递归）。绝不能对联接用 -Recurse。
        [System.IO.Directory]::Delete($Path, $false)
        Write-Host "  已移除旧联接：$Path（原指向 $target；目标内容未受影响）"
    }
    else {
        Write-Host "  ⚠ $Path 不是联接而是真实目录，已保留（不删除）。" -ForegroundColor Yellow
        Write-Host "    如果确认要清掉它，请手动处理：Remove-Item -LiteralPath '$Path' -Recurse" -ForegroundColor Yellow
    }
}

function New-Junction {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Target)

    if (-not (Test-Path -LiteralPath $Target)) {
        Write-Host "  跳过：目标不存在 $Target" -ForegroundColor Yellow
        return
    }
    New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
    Write-Host "OK  $Path -> $Target"
}

Write-Host "项目根：$root"

# data 联接：exe 旁边的 data → 项目 data
Remove-LinkOnly -Path (Join-Path $unpacked 'data')
New-Junction -Path (Join-Path $unpacked 'data') -Target (Join-Path $root 'data')

# snowluma 联接：resources\app\snowluma → 项目 snowluma（含登录态 config/data）
$slLink = Join-Path $unpacked 'resources\app\snowluma'
Remove-LinkOnly -Path $slLink
New-Junction -Path $slLink -Target (Join-Path $root 'snowluma')

Write-Host "完成。把 dist\win-unpacked\QQ Agent.exe 固定到任务栏即可。"
