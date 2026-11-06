@echo off
chcp 65001 >nul
REM agentchattr — starts the server only
cd /d "%~dp0.."

REM Auto-create venv and install deps on first run
if not exist ".venv" (
    python -m venv .venv
    .venv\Scripts\pip install -q -r requirements.txt >nul 2>nul
)
call .venv\Scripts\activate.bat

python run.py
echo.
echo === 服务器已退出，退出码 %ERRORLEVEL% ===
pause
