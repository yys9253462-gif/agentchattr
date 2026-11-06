@echo off
chcp 65001 >nul
REM agentchattr - starts server (if not running) + GitHub Copilot CLI wrapper
REM Usage: start_copilot.bat
REM Requires the copilot CLI on PATH. First launch prompts GitHub login.
cd /d "%~dp0.."

REM Auto-create venv and install deps on first run
if not exist ".venv" (
    python -m venv .venv
    .venv\Scripts\pip install -q -r requirements.txt >nul 2>nul
)
call .venv\Scripts\activate.bat

REM Pre-flight: check that copilot CLI is installed
where copilot >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   错误：PATH 中找不到 "copilot"。
    echo   安装命令：npm install -g @github/copilot
    echo   参见 https://github.com/github/copilot-cli 了解详情。
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

python wrapper.py copilot
if %errorlevel% neq 0 (
    echo.
    echo   智能体意外退出，请查看上方输出。
    pause
)
