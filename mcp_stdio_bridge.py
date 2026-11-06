"""stdio ↔ HTTP MCP bridge for desktop clients.

Some desktop apps only speak stdio MCP (Claude Desktop's config file, older
IDE integrations). This script exposes the agentchattr MCP server (already
running on http://127.0.0.1:8200/mcp) as a stdio MCP server, so any stdio-only
client can join the chat room.

Usage (usually put in the client's MCP config, not run by hand):

    python mcp_stdio_bridge.py
    python mcp_stdio_bridge.py --url http://127.0.0.1:8200/mcp

Requires the agentchattr server to be running (`python run.py`) — the bridge
does not start it.
"""

import argparse
import asyncio
import sys

import mcp.types as types
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client
from mcp.server import Server
from mcp.server.stdio import stdio_server

DEFAULT_URL = "http://127.0.0.1:8200/mcp"

server = Server("agentchattr-bridge")
_upstream: ClientSession | None = None


@server.list_tools()
async def _list_tools() -> list[types.Tool]:
    assert _upstream is not None
    result = await _upstream.list_tools()
    # Drop outputSchema: the bridge forwards plain content blocks, and a schema
    # here would make the stdio server validate (and reject) that passthrough.
    return [t.model_copy(update={"outputSchema": None}) for t in result.tools]


@server.call_tool()
async def _call_tool(name: str, arguments: dict) -> list[types.ContentBlock]:
    assert _upstream is not None
    result = await _upstream.call_tool(name, arguments or {})
    return result.content


async def _run(url: str) -> None:
    global _upstream
    async with streamablehttp_client(url) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            _upstream = session
            async with stdio_server() as (i, o):
                await server.run(i, o, server.create_initialization_options())


def main() -> None:
    parser = argparse.ArgumentParser(description="agentchattr stdio ↔ HTTP MCP bridge")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"upstream MCP URL (default: {DEFAULT_URL})")
    args = parser.parse_args()
    try:
        asyncio.run(_run(args.url))
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # surface a readable error on stderr, not a traceback dump
        print(f"agentchattr bridge error: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
