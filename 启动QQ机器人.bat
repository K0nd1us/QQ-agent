@echo off
rem QQ Agent launcher (desktop app, no npm window)
rem NOTE: keep this file ASCII-only. cmd parses .bat in GBK on Chinese
rem Windows; UTF-8 Chinese comments swallow the newline and break parsing.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
