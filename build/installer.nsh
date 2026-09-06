; ── QQ Agent 自定义安装页：旧版本数据迁移（可选）──
; 本 include 在 electron-builder 主脚本早期被插入，nsDialogs/LogicLib 可能尚未加载，自己引（有防重复保护）
!include nsDialogs.nsh
!include LogicLib.nsh
!include MUI2.nsh
; 流程（对应 Kondius 的需求单）：
;   1. 用户双击安装包 → 2. 询问电脑上是否已有旧版 QQ Agent
;   3. 没有 → 只选安装位置，正常安装
;   4. 有 → 选旧版所在文件夹 + 选安装位置，装完自动把旧版用户数据迁到新位置
; 数据目录约定：应用根目录/data（见 electron/main.js resolveDataDir，exe 旁边）。
; asar 已关闭（开源式分发，文件平铺可改），程序文件在 resources/app/ 下。
; ⚠️ 本 include 对安装包和卸载器各编译一遍；页面函数在卸载器里无人引用，
; NSIS「警告即错误」会把 warning 6010 炸成构建失败——页面相关代码只给安装器。
!ifndef BUILD_UNINSTALLER

Var OldDataDir

Function OnOldDirChange
  ${NSD_GetText} $1 $OldDataDir
FunctionEnd

Function OnBrowseOldDir
  nsDialogs::SelectFolderDialog "选择旧版 QQ Agent 所在的文件夹（里面有 assets、electron、node_modules 等）" "$PROGRAMFILES"
  Pop $0
  ${If} $0 != ""
    ${NSD_SetText} $1 $0
    StrCpy $OldDataDir $0
  ${EndIf}
FunctionEnd

Function AskOldVersionPage
  !insertmacro MUI_HEADER_TEXT "旧版本数据迁移" "没有旧版本的话，直接点「下一步」即可。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 40u "如果你的电脑上已经有旧版本的 QQ Agent（比如压缩包版或更早的安装版），在下面选择它所在的文件夹：$\r$\n$\r$\n安装完成后，会自动把旧版里的用户数据（配置 / 记忆 / 聊天记录 / 表情包 / 登录状态）迁移到新安装位置，无缝接管。$\r$\n$\r$\n没有旧版本的话，直接点「下一步」。"
  Pop $0

  ${NSD_CreateDirRequest} 0 72u 78% 14u "$OldDataDir"
  Pop $1
  ${NSD_OnChange} $1 OnOldDirChange

  ${NSD_CreateButton} 80% 72u 20% 14u "浏览…"
  Pop $2
  ${NSD_OnClick} $2 OnBrowseOldDir

  nsDialogs::Show
FunctionEnd

; ⚠️ electron-builder 只提供 customWelcomePage（目录页之前）和 customPageAfterChangeDir
; （目录页之后）两个页面钩子。Kondius 要求询问在"选定安装位置"前面 → 用 welcome 钩子，
; 迁移页会排在欢迎页之后、安装模式/目录页之前。

!macro customWelcomePage
  Page custom AskOldVersionPage
!macroend

!endif ; BUILD_UNINSTALLER

!macro customInstall
  ; 用户数据整体迁移：config / 记忆 / 聊天记录 / 表情包 / 遥测 ID 全在 data/ 里
  ${If} $OldDataDir != ""
  ${AndIf} ${FileExists} "$OldDataDir\data\*.*"
    CreateDirectory "$INSTDIR\data"
    CopyFiles /SILENT "$OldDataDir\data\*.*" "$INSTDIR\data"
    DetailPrint "已迁移旧版本用户数据：$OldDataDir\data"
  ${EndIf}
  ; SnowLuma 登录态 + OneBot 令牌一并带走，免重新扫码
  ${If} $OldDataDir != ""
  ${AndIf} ${FileExists} "$OldDataDir\snowluma\config\*.*"
    CreateDirectory "$INSTDIR\resources\app\snowluma\config"
    CopyFiles /SILENT "$OldDataDir\snowluma\config\*.*" "$INSTDIR\resources\app\snowluma\config"
    DetailPrint "已迁移 SnowLuma 登录状态"
  ${EndIf}
!macroend
