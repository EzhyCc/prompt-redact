@echo off
chcp 65001 >nul
rem 提示词脱敏 · 规则调试器 —— 零安装启动器
rem
rem 用 DSH 自带的 Node 跑本地服务，用户不需要装任何东西。
rem 只监听回环地址，所有处理都在本机，不发任何网络请求。
rem 关掉这个窗口，服务就停了。

setlocal enabledelayedexpansion

set "DSH_NODE="

rem 1) DSH 默认安装位置（Electron 版自带 node.exe）
for %%D in (
  "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  "%PROGRAMFILES%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  "%PROGRAMFILES(X86)%\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
) do (
  if exist %%D if not defined DSH_NODE set "DSH_NODE=%%~D"
)

rem 2) DSH 运行时目录（有些版本放在 ~/.dsh/dsh-runtimes 下）
if not defined DSH_NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes" (
  for /d %%R in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if exist "%%R\dependencies\node\bin\node.exe" if not defined DSH_NODE set "DSH_NODE=%%R\dependencies\node\bin\node.exe"
  )
)

set "PORT=5173"
set "SERVE=%~dp0..\tools\serve.js"

if defined DSH_NODE (
  echo 提示词脱敏 · 规则调试器
  echo 使用 DSH 自带的 Node，无需另装环境。
  echo.
  rem 两秒后自动打开浏览器；本窗口保持为服务进程
  start "" cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:%PORT%/"
  "!DSH_NODE!" "!SERVE!" --port %PORT% %*
  goto :done
)

echo 没找到 DSH 自带的 Node，尝试 PATH 上的 node...
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo 找不到可用的 Node。
  echo 请确认 DeepSeek Harness 装在默认位置，或把 node 加进 PATH。
  echo.
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:%PORT%/"
node "!SERVE!" --port %PORT% %*

:done
echo.
echo 服务已停止。
pause
