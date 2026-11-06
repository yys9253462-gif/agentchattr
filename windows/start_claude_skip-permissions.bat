@echo off
chcp 65001 >nul
REM agentchattr — starts server (if not running) + Claude wrapper (auto-approve mode)
cd /d "%~dp0.."

REM 首次运行时自动创建虚拟环境并安装依赖
if not exist ".venv\Scripts\python.exe" (
    echo 正在创建虚拟环境...
    python -m venv .venv
)
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, mcp" >nul 2>nul
if errorlevel 1 (
    echo 正在安装依赖，请稍候...
    ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
)
".venv\Scripts\python.exe" -c "import fastapi, uvicorn, mcp" >nul 2>nul
if errorlevel 1 (
    echo.
    echo   错误：依赖安装失败，请检查网络或代理设置后重试。
    echo   可手动执行：.venv\Scripts\python.exe -m pip install -r requirements.txt
    pause
    exit /b 1
)
call .venv\Scripts\activate.bat

REM Pre-flight: check that claude CLI is installed
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   错误：PATH 中找不到 "claude"。
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

python wrapper.py claude --dangerously-skip-permissions
if %errorlevel% neq 0 (
    echo.
    echo   智能体意外退出，请查看上方输出。
    pause
)
