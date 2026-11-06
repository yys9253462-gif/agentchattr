"""Shared config loader — merges config.toml + config.local.toml.

Used by run.py, wrapper.py, and wrapper_api.py so the server and all
wrappers see the same agent definitions.

Per-invocation overrides: the following environment variables, if set,
override values from config.toml. This lets dotfiles/launcher layers run
isolated instances per project without editing the repo's config file.

  AGENTCHATTR_DATA_DIR        → server.data_dir
  AGENTCHATTR_PORT            → server.port           (int)
  AGENTCHATTR_MCP_HTTP_PORT   → mcp.http_port         (int)
  AGENTCHATTR_MCP_SSE_PORT    → mcp.sse_port          (int)
  AGENTCHATTR_UPLOAD_DIR      → images.upload_dir

Relative paths in env var overrides resolve against the current working
directory (where the user invoked the command from), not agentchattr's
install directory.
"""

import os
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).parent


# Mapping: env var name → (config section, key, is_int)
_ENV_OVERRIDES = [
    ("AGENTCHATTR_DATA_DIR",      "server", "data_dir",   False),
    ("AGENTCHATTR_PORT",          "server", "port",       True),
    ("AGENTCHATTR_MCP_HTTP_PORT", "mcp",    "http_port",  True),
    ("AGENTCHATTR_MCP_SSE_PORT",  "mcp",    "sse_port",   True),
    ("AGENTCHATTR_UPLOAD_DIR",    "images", "upload_dir", False),
]

# Mapping: CLI flag → env var (for apply_cli_overrides)
CLI_OVERRIDE_FLAGS = [
    ("--data-dir",      "AGENTCHATTR_DATA_DIR"),
    ("--port",          "AGENTCHATTR_PORT"),
    ("--mcp-http-port", "AGENTCHATTR_MCP_HTTP_PORT"),
    ("--mcp-sse-port",  "AGENTCHATTR_MCP_SSE_PORT"),
    ("--upload-dir",    "AGENTCHATTR_UPLOAD_DIR"),
]


def apply_cli_overrides(argv: list[str] | None = None) -> None:
    """Scan argv for --data-dir/--port/etc and set matching env vars in-place.

    Called by run.py, wrapper.py, and wrapper_api.py BEFORE load_config() so
    all entry points respect the same overrides when launched with the same
    flags. No effect if a flag isn't present. Supports both `--flag value`
    and `--flag=value` forms.

    Arguments after a literal `--` are treated as pass-through (e.g. for the
    agent CLI in wrapper.py) and are NOT scanned — `python wrapper.py claude
    -- --port 9999` sets `--port 9999` on the agent, not on agentchattr.
    """
    if argv is None:
        argv = sys.argv

    # Truncate at pass-through separator so agent CLI args don't leak in.
    try:
        end = argv.index("--")
        scan = argv[:end]
    except ValueError:
        scan = argv

    for flag, env in CLI_OVERRIDE_FLAGS:
        # Iterate in order; first match wins (ignore later duplicates).
        for i, arg in enumerate(scan):
            if arg == flag and i + 1 < len(scan):
                os.environ[env] = scan[i + 1]
                break
            if arg.startswith(flag + "="):
                os.environ[env] = arg.split("=", 1)[1]
                break


def _apply_env_overrides(config: dict) -> None:
    """Apply AGENTCHATTR_* env vars to the config dict in-place."""
    for env_var, section, key, is_int in _ENV_OVERRIDES:
        raw = os.environ.get(env_var)
        if raw is None or raw == "":
            continue
        if is_int:
            try:
                value = int(raw)
            except ValueError:
                print(f"  Warning: {env_var}={raw!r} is not a valid integer, ignoring")
                continue
        else:
            # Path values: resolve relative paths against current working dir,
            # not against agentchattr's install directory.
            p = Path(raw)
            if not p.is_absolute():
                p = (Path.cwd() / p).resolve()
            value = str(p)
        config.setdefault(section, {})[key] = value


def load_config(root: Path | None = None) -> dict:
    """Load config.toml and merge config.local.toml if it exists.

    config.local.toml is gitignored and intended for user-specific agents
    (e.g. local LLM endpoints) that shouldn't be committed.
    Only the [agents] section is merged — local entries are added alongside
    (not replacing) the agents defined in config.toml.

    AGENTCHATTR_* environment variables override values from config.toml
    (see module docstring for the list).
    """
    root = root or ROOT
    config_path = root / "config.toml"

    with open(config_path, "rb") as f:
        config = tomllib.load(f)

    local_path = root / "config.local.toml"
    if local_path.exists():
        with open(local_path, "rb") as f:
            local = tomllib.load(f)

        # Merge [agents] section — local agents are added ONLY if they don't already exist.
        # This protects the "holy trinity" (claude, codex, gemini) from being overridden.
        local_agents = local.get("agents", {})
        config_agents = config.setdefault("agents", {})
        for name, agent_cfg in local_agents.items():
            if name not in config_agents:
                config_agents[name] = agent_cfg
            else:
                print(f"  Warning: Ignoring local agent '{name}' (already defined in config.toml)")

    _apply_env_overrides(config)

    return config


# --- 自定义 CLI 智能体（网页端配置，存到 config.local.toml） ---

_LOCAL_HEADER = (
    "# config.local.toml — 本地自定义配置（已被 .gitignore 忽略）\n"
    "# 通过网页左侧「CLI 智能体」面板添加的条目会写在这里。\n"
    "# 手工编辑也完全可以，重启服务后生效。\n"
)


def local_config_path(root: Path | None = None) -> Path:
    return (root or ROOT) / "config.local.toml"


def read_local_agents(root: Path | None = None) -> dict:
    """读取 config.local.toml 里的 [agents.*]，文件不存在就返回空字典。"""
    path = local_config_path(root)
    if not path.exists():
        return {}
    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except Exception:
        return {}
    return dict(data.get("agents", {}))


def _toml_str(value: str) -> str:
    escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def write_local_agents(agents: dict, root: Path | None = None) -> None:
    """把自定义 [agents.*] 整体写回 config.local.toml（保留文件其余部分之外的内容会丢失）。"""
    path = local_config_path(root)

    # 保留文件里可能存在的非 agents 段落
    other_sections: dict = {}
    if path.exists():
        try:
            with open(path, "rb") as f:
                data = tomllib.load(f)
            other_sections = {k: v for k, v in data.items() if k != "agents"}
        except Exception:
            other_sections = {}

    lines: list[str] = [_LOCAL_HEADER]
    for name, cfg in agents.items():
        lines.append(f"\n[agents.{name}]")
        for key, value in cfg.items():
            if isinstance(value, bool):
                lines.append(f"{key} = {'true' if value else 'false'}")
            elif isinstance(value, (int, float)):
                lines.append(f"{key} = {value}")
            else:
                lines.append(f"{key} = {_toml_str(value)}")

    for section, values in other_sections.items():
        if not isinstance(values, dict):
            continue
        lines.append(f"\n[{section}]")
        for key, value in values.items():
            if isinstance(value, dict):
                continue
            if isinstance(value, bool):
                lines.append(f"{key} = {'true' if value else 'false'}")
            elif isinstance(value, (int, float)):
                lines.append(f"{key} = {value}")
            else:
                lines.append(f"{key} = {_toml_str(value)}")

    path.write_text("\n".join(lines).rstrip() + "\n", "utf-8")
