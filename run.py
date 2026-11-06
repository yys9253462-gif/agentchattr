"""Entry point — starts MCP server (port 8200) + web UI (port 8300)."""

import argparse
import asyncio
import secrets
import sys
import threading
import time
import logging
from pathlib import Path

# Ensure the project directory is on the import path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

# 控制台编码兜底：终端用 GBK 等无法表示全部中文时不要因为 print 崩溃
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass


def _parse_args():
    parser = argparse.ArgumentParser(
        description="Start agentchattr (web UI + MCP server).",
        epilog="Flags override config.toml for this invocation. The same flags "
               "are also accepted by wrapper.py and wrapper_api.py so a launcher "
               "can isolate per-project instances by passing matching values to "
               "each process.",
    )
    parser.add_argument("--data-dir",      default=None, help="Override server.data_dir (path)")
    parser.add_argument("--port",          default=None, help="Override server.port (int)")
    parser.add_argument("--mcp-http-port", default=None, help="Override mcp.http_port (int)")
    parser.add_argument("--mcp-sse-port",  default=None, help="Override mcp.sse_port (int)")
    parser.add_argument("--upload-dir",    default=None, help="Override images.upload_dir (path)")
    parser.add_argument("--allow-network", action="store_true",
                        help="Allow binding to non-localhost hosts (with confirmation).")
    return parser.parse_args()


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    # Parse flags for --help support; the actual env propagation happens via
    # the shared config_loader.apply_cli_overrides helper so run.py and the
    # wrappers use identical extraction logic.
    _parse_args()

    from config_loader import apply_cli_overrides, load_config
    apply_cli_overrides()

    config_path = ROOT / "config.toml"
    if not config_path.exists():
        print(f"错误：找不到 {config_path}")
        sys.exit(1)

    config = load_config(ROOT)

    # --- Security: generate a random session token (in-memory only) ---
    session_token = secrets.token_hex(32)

    # Configure the FastAPI app (creates shared store)
    from app import app, configure, set_event_loop, store as _store_ref
    configure(config, session_token=session_token)

    # Share stores with the MCP bridge
    from app import store, rules, summaries, jobs, room_settings, registry, router as app_router, agents as app_agents, session_engine, session_store
    import mcp_bridge
    mcp_bridge.store = store
    mcp_bridge.rules = rules
    mcp_bridge.summaries = summaries
    mcp_bridge.jobs = jobs
    mcp_bridge.room_settings = room_settings
    mcp_bridge.registry = registry
    mcp_bridge.config = config
    mcp_bridge.router = app_router
    mcp_bridge.agents = app_agents

    # Enable cursor and role persistence across restarts
    data_dir = ROOT / config.get("server", {}).get("data_dir", "./data")
    mcp_bridge._CURSORS_FILE = data_dir / "mcp_cursors.json"
    mcp_bridge._load_cursors()
    mcp_bridge._ROLES_FILE = data_dir / "roles.json"
    mcp_bridge._load_roles()

    # Start MCP servers in background threads
    http_port = config.get("mcp", {}).get("http_port", 8200)
    sse_port = config.get("mcp", {}).get("sse_port", 8201)
    mcp_bridge.mcp_http.settings.port = http_port
    mcp_bridge.mcp_sse.settings.port = sse_port

    threading.Thread(target=mcp_bridge.run_http_server, daemon=True).start()
    threading.Thread(target=mcp_bridge.run_sse_server, daemon=True).start()
    time.sleep(0.5)
    logging.getLogger(__name__).info("MCP streamable-http on port %d, SSE on port %d", http_port, sse_port)

    # Mount static files
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import HTMLResponse

    static_dir = ROOT / "static"

    @app.get("/")
    async def index():
        # Read index.html fresh each request so changes take effect without restart.
        # Inject the session token into the HTML so the browser client can use it.
        # This is safe: same-origin policy prevents cross-origin pages from reading
        # the response body, so only the user's own browser tab gets the token.
        html = (static_dir / "index.html").read_text("utf-8")
        injected = html.replace(
            "</head>",
            f'<script>window.__SESSION_TOKEN__="{session_token}";</script>\n</head>',
        )
        return HTMLResponse(injected, headers={"Cache-Control": "no-store"})

    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    # Capture the event loop for the store→WebSocket bridge
    @app.on_event("startup")
    async def on_startup():
        set_event_loop(asyncio.get_running_loop())
        # Resume any sessions that were active before restart
        if session_engine:
            session_engine.resume_active_sessions()

    # Run web server
    import uvicorn
    host = config.get("server", {}).get("host", "127.0.0.1")
    port = config.get("server", {}).get("port", 8300)

    # --- Security: warn if binding to a non-localhost address ---
    if host not in ("127.0.0.1", "localhost", "::1"):
        print(f"\n  !! 安全警告：正在绑定到 {host} !!")
        print("  这会把 agentchattr 暴露给局域网。")
        print()
        print("  风险：")
        print("  - 没有 TLS：流量（包括会话令牌）以明文传输")
        print("  - 同一网络中的任何人都能嗅探令牌并获得完全访问权限")
        print("  - 拿到令牌的人可以 @智能体 并触发工具执行")
        print("  - 如果智能体开启了自动批准，这等于远程代码执行")
        print()
        print("  只在可信的家庭网络中使用，切勿在公共/共享 WiFi 上使用。")
        if "--allow-network" not in sys.argv:
            print("  如仍要启动请加 --allow-network，或把 host 改为 127.0.0.1。\n")
            sys.exit(1)
        else:
            print()
            try:
                confirm = input("  Type YES to accept these risks and start: ").strip()
            except (EOFError, KeyboardInterrupt):
                confirm = ""
            if confirm != "YES":
                print("  已取消。\n")
                sys.exit(1)

    print(f"\n  agentchattr")
    print(f"  网页界面:  http://{host}:{port}")
    print(f"  MCP HTTP: http://{host}:{http_port}/mcp  (Claude, Codex)")
    print(f"  MCP SSE:  http://{host}:{sse_port}/sse   (Gemini)")
    print(f"  数据目录:  {data_dir}")
    print(f"  @提及智能体时会自动触发")
    print(f"\n  会话令牌：{session_token}\n")

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()

