@echo off
chcp 65001 >nul
REM agentchattr — starts server (if not running) + Antigravity (agy) wrapper
cd /d "%~dp0.."

REM Pin agy's version — it self-updates and will otherwise drift out from under you
set AGY_CLI_DISABLE_AUTO_UPDATE=1

REM agy installs to %LOCALAPPDATA%\agy\bin and adds it to the *persistent* User
REM PATH — but a window opened before that install (e.g. Explorer double-click)
REM inherits a stale PATH and won't find agy. Prepend it so this always works.
if exist "%LOCALAPPDATA%\agy\bin\agy.exe" set "PATH=%LOCALAPPDATA%\agy\bin;%PATH%"

REM Auto-create venv and install deps on first run
if not exist ".venv" (
    python -m venv .venv
    .venv\Scripts\pip install -q -r requirements.txt >nul 2>nul
)
call .venv\Scripts\activate.bat

REM Pre-flight: check that the agy CLI is installed
where agy >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   错误：PATH 中找不到 "agy" ^(Antigravity CLI^)。
    echo   请先安装，再重试。
    echo   注意：在这里使用前，先不带参数运行一次 "agy" 完成登录。
    echo.
    pause
    exit /b 1
)

REM Start server if not already running, then wait for it
python -c "import socket; socket.create_connection(('127.0.0.1', 8300), 1)" >nul 2>&1
if %errorlevel% neq 0 (
    start "agentchattr server" cmd /c "python run.py"
)
:wait_server
python -c "import socket; socket.create_connection(('127.0.0.1', 8300), 1)" >nul 2>&1
if %errorlevel% neq 0 (
    timeout /t 1 /nobreak >nul
    goto :wait_server
)

python wrapper.py antigravity

REM Always pause on exit so the window never vanishes silently — lets you read
REM any error above whether the wrapper crashed or exited cleanly.
echo.
echo   Antigravity 包装器已退出，请查看上方输出。
pause
