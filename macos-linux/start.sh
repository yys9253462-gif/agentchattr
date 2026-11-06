#!/usr/bin/env sh
# agentchattr - starts the server only
cd "$(dirname "$0")/.."

PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
else
    echo "需要 Python 3，但 PATH 中找不到。"
    exit 1
fi

ensure_venv() {
    if [ -d ".venv" ] && [ ! -x ".venv/bin/python" ]; then
        echo "正在为当前平台重建 .venv..."
        rm -rf .venv
    fi

    if [ ! -x ".venv/bin/python" ]; then
        echo "正在创建虚拟环境..."
        "$PYTHON_BIN" -m venv .venv || {
            echo "错误：无法用 $PYTHON_BIN 创建 .venv。"
            exit 1
        }
        .venv/bin/python -m pip install -q -r requirements.txt || {
            echo "错误：Python 依赖安装失败。"
            exit 1
        }
    fi
}

ensure_venv

.venv/bin/python run.py
code=$?
echo ""
echo "=== 服务器已退出，退出码 $code ==="
exit "$code"
