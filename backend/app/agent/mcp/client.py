"""
MCP Client Manager — manages connections to MCP servers and bridges
async MCP SDK calls to the synchronous agent executor.

Uses a dedicated background asyncio event loop so that sync code
can call MCP operations without async/await propagation.
"""
import asyncio
import logging
import threading
from contextlib import AsyncExitStack
from typing import Any, Dict, List, Optional

from app.agent.mcp.config import MCPServerConfig

logger = logging.getLogger(__name__)


class MCPServerConnection:
    """Manages a single MCP server connection (async internals)."""

    def __init__(self, config: MCPServerConfig):
        self.config = config
        self.session = None          # mcp.ClientSession
        self._exit_stack: Optional[AsyncExitStack] = None
        # MCP-protocol-level "tools" — Goku names this concept
        # "capabilities" everywhere outside this transport-layer cache.
        # The SDK methods (``session.list_tools()`` / ``response.tools``)
        # still use the protocol vocabulary; once we get past the SDK
        # boundary the rename is in effect.
        self.capabilities: List[Dict[str, Any]] = []
        self.connected: bool = False

    async def connect(self) -> None:
        """Connect to the MCP server and discover its capabilities."""
        try:
            from mcp import ClientSession
            from mcp.client.stdio import stdio_client, StdioServerParameters
        except ImportError:
            raise ImportError(
                "MCP SDK not installed. Install with: pip install mcp"
            )

        self._exit_stack = AsyncExitStack()
        try:
            if self.config.type == "stdio":
                server_params = StdioServerParameters(
                    command=self.config.command,
                    args=self.config.args,
                    env=self.config.env or None,
                )
                transport = await self._exit_stack.enter_async_context(
                    stdio_client(server_params)
                )
            elif self.config.type == "http":
                # Streamable HTTP — MCP standard transport for remote
                # servers. ``self.config.env`` is sent as HTTP headers, so
                # an injected ``Authorization`` (from a bound
                # server_auth_connection_id) authenticates the connection.
                try:
                    from mcp.client.streamable_http import streamablehttp_client
                except ImportError:
                    raise ImportError(
                        "MCP Streamable HTTP client not available. "
                        "Ensure a recent mcp SDK is installed."
                    )
                if not self.config.url:
                    raise ValueError(
                        f"MCP server '{self.config.name}' has type='http' but no 'url' configured."
                    )
                transport = await self._exit_stack.enter_async_context(
                    streamablehttp_client(url=self.config.url, headers=self.config.env or {})
                )
            else:
                raise ValueError(
                    f"Unsupported MCP transport type: {self.config.type}. "
                    f"Supported: 'stdio', 'http'."
                )

            # Streamable HTTP yields a 3-tuple (read, write, get_session_id);
            # stdio yields a 2-tuple. Take the first two streams either way.
            read_stream, write_stream = transport[0], transport[1]
            self.session = await self._exit_stack.enter_async_context(
                ClientSession(read_stream, write_stream)
            )
            await self.session.initialize()

            # Discover capabilities. ``session.list_tools()`` and
            # ``response.tools`` are SDK / protocol names — kept verbatim
            # on the wire side, then stored under ``self.capabilities``.
            response = await self.session.list_tools()
            self.capabilities = [
                {
                    "name": t.name,
                    "description": getattr(t, "description", "") or "",
                    "inputSchema": getattr(t, "inputSchema", {}) or {},
                }
                for t in response.tools
            ]
            self.connected = True
            logger.info(
                "MCP server '%s' (%s) connected, discovered %d capabilities",
                self.config.name, self.config.type, len(self.capabilities),
            )
        except Exception as e:
            logger.error("Failed to connect MCP server '%s': %s", self.config.name, e)
            await self.disconnect()
            raise

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """Invoke a tool on this MCP server."""
        if not self.session or not self.connected:
            return {"error": f"MCP server '{self.config.name}' not connected"}

        try:
            result = await self.session.call_tool(tool_name, arguments)

            # Convert MCP content array to text
            texts = []
            for item in result.content:
                text = getattr(item, "text", None)
                if text:
                    texts.append(text)

            return {
                "success": not getattr(result, "isError", False),
                "output": "\n".join(texts) if texts else "",
                "mcp_server": self.config.name,
                "mcp_tool": tool_name,
            }
        except Exception as e:
            logger.error(
                "MCP tool call failed (server=%s, tool=%s): %s",
                self.config.name, tool_name, e,
            )
            return {
                "error": f"MCP tool call failed: {str(e)[:300]}",
                "mcp_server": self.config.name,
                "mcp_tool": tool_name,
            }

    async def disconnect(self) -> None:
        """Disconnect from the MCP server."""
        if self._exit_stack:
            try:
                await self._exit_stack.aclose()
            except Exception as e:
                logger.debug("Error during MCP disconnect: %s", e)
        self.session = None
        self.connected = False
        self.capabilities = []


class MCPClientManager:
    """
    Manages all MCP server connections.

    Owns a dedicated asyncio event loop in a background thread to bridge
    the async MCP SDK with the synchronous agent executor.
    """

    def __init__(self):
        self._connections: Dict[str, MCPServerConnection] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._loop_thread: Optional[threading.Thread] = None

    def _get_loop(self) -> asyncio.AbstractEventLoop:
        """Get or create the dedicated background event loop."""
        if self._loop is None or self._loop.is_closed():
            self._loop = asyncio.new_event_loop()
            self._loop_thread = threading.Thread(
                target=self._loop.run_forever, daemon=True, name="mcp-event-loop"
            )
            self._loop_thread.start()
        return self._loop

    def _run_async(self, coro, timeout: float = 60) -> Any:
        """Run an async coroutine from sync code, blocking until done."""
        loop = self._get_loop()
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=timeout)

    # ── Server lifecycle ──────────────────────────────────────────────────

    def connect_server(self, config: MCPServerConfig) -> List[Dict[str, Any]]:
        """Connect to an MCP server and return its discovered capabilities.

        The connection object is always registered in _connections so that
        list_servers() can surface disconnected servers in the UI, even when
        the initial connection attempt fails.
        """
        conn = MCPServerConnection(config)
        # Register first so list_servers() always sees this server, even on failure.
        self._connections[config.name] = conn
        self._run_async(conn.connect())
        return conn.capabilities

    def disconnect_server(self, name: str) -> None:
        """Disconnect a specific MCP server."""
        conn = self._connections.pop(name, None)
        if conn:
            try:
                self._run_async(conn.disconnect(), timeout=10)
            except Exception as e:
                logger.debug("Error disconnecting MCP server '%s': %s", name, e)

    def connect_all_from_config(
        self,
        configs: Dict[str, MCPServerConfig],
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Connect to a set of MCP servers and return their capabilities.

        ``configs`` is REQUIRED. Production callers build it via
        :func:`app.services.mcp_runtime.get_active_runtime_configs`
        (DB rows where ``status='enabled' AND deleted_at IS NULL``).
        The legacy ``workspace/.mcp.json`` fallback was removed: DB is
        the single source of truth for runtime MCP configs. Passing
        ``None`` is a bug and raises ``ValueError`` so the caller fixes
        it instead of silently picking up a stale file.

        Returns ``{server_name: [capability_defs]}``. Failures are logged,
        not raised.
        """
        if configs is None:
            raise ValueError(
                "MCP runtime no longer loads .mcp.json fallback; "
                "DB runtime configs are required. Use "
                "app.services.mcp_runtime.get_active_runtime_configs() to "
                "build the configs dict.")
        results: Dict[str, List[Dict[str, Any]]] = {}
        for name, cfg in configs.items():
            try:
                capabilities = self.connect_server(cfg)
                results[name] = capabilities
                logger.info(
                    "MCP server '%s' ready with %d capabilities", name, len(capabilities)
                )
            except Exception as e:
                logger.error("Failed to connect MCP server '%s': %s", name, e)
                # Server is already in _connections (connected=False) thanks to the
                # register-first pattern in connect_server(). Keep results empty so
                # callers know nothing was discovered.
                results[name] = []
        return results

    # ── Tool invocation ───────────────────────────────────────────────────

    def call_tool(
        self, server_name: str, tool_name: str, arguments: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Call a tool on a specific MCP server (sync).

        Resilient to a dead persistent connection: when a remote endpoint
        flaps (e.g. a transient 502), the streamable-HTTP session can die and
        not auto-recover, so every subsequent call fails until a manual
        toggle/restart. Here we detect a transport-level failure (the
        ``error`` key — distinct from a tool-logic ``success: False``) or an
        already-dead connection, reconnect ONCE from the stored config, and
        retry. Tool-logic failures are NOT retried (no double-execution of
        write tools); only transport errors trigger the reconnect path.
        """
        conn = self._connections.get(server_name)
        if conn is None:
            return {"error": f"MCP server '{server_name}' not connected"}

        if conn.connected:
            result = self._run_async(conn.call_tool(tool_name, arguments))
            if not result.get("error"):
                return result  # success or tool-logic failure — do not retry
            logger.warning(
                "MCP transport error on '%s.%s'; attempting reconnect + retry",
                server_name, tool_name,
            )

        # Reconnect once from the stored config and retry.
        try:
            fresh = MCPServerConnection(conn.config)
            self._run_async(fresh.connect())
            if fresh.connected:
                self._connections[server_name] = fresh
                logger.info("MCP server '%s' reconnected; retrying '%s'", server_name, tool_name)
                return self._run_async(fresh.call_tool(tool_name, arguments))
            logger.warning("MCP server '%s' reconnect failed (endpoint down?)", server_name)
        except Exception as e:
            logger.warning("MCP reconnect+retry failed for '%s': %s", server_name, e)
        return {"error": f"MCP server '{server_name}' not connected"}

    # ── Query ─────────────────────────────────────────────────────────────

    def list_servers(self) -> List[Dict[str, Any]]:
        """Return status of all MCP server connections."""
        return [
            {
                "name": name,
                "type": conn.config.type,
                "connected": conn.connected,
                "capability_count": len(conn.capabilities),
                "capabilities": [c["name"] for c in conn.capabilities],
            }
            for name, conn in self._connections.items()
        ]

    def get_all_capabilities(self) -> Dict[str, List[Dict[str, Any]]]:
        """Return ``{server_name: [capability_defs]}`` for all connected
        servers."""
        return {
            name: conn.capabilities
            for name, conn in self._connections.items()
            if conn.connected
        }

    # ── Shutdown ──────────────────────────────────────────────────────────

    def disconnect_all(self) -> None:
        """Disconnect all MCP servers."""
        for name in list(self._connections.keys()):
            self.disconnect_server(name)

    def shutdown(self) -> None:
        """Clean shutdown: disconnect all servers and stop event loop."""
        self.disconnect_all()
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._loop = None


# ── Singleton ─────────────────────────────────────────────────────────────────

_global_mcp_manager: Optional[MCPClientManager] = None


def get_mcp_manager() -> MCPClientManager:
    """Get or create the global MCP client manager."""
    global _global_mcp_manager
    if _global_mcp_manager is None:
        _global_mcp_manager = MCPClientManager()
    return _global_mcp_manager
