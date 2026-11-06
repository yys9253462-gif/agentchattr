@echo off
chcp 65001 >nul
REM agentchattr — starts server (if not running) + Kilo wrapper
REM Usage: start_kilo.bat [provider/model]
REM   e.g. start_kilo.bat anthropic/claude-sonnet-4-20250514
REM   Omit the model to use Kilo's configured default.
cd /d "%~dp0.."

REM Auto-create venv and install deps on first run
if not exist ".venv" (
    python -m venv .venv
    .venv\Scripts\pip install -q -r requirements.txt >nul 2>nul
)
call .venv\Scripts\activate.bat

REM Pre-flight: check that kilo CLI is installed
where kilo >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   错误：PATH 中找不到 "kilo"。
    echo   请先安装，再重试。
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

if "%~1"=="" (
    python wrapper.py kilo
) else (
    python wrapper.py kilo -- -m %1
)
if %errorlevel% neq 0 (
    echo.
    echo   智能体意外退出，请查看上方输出。
    pause
)
