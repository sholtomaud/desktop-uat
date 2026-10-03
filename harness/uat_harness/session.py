"""One agent-access MCP session == one fresh WorkSpaces desktop.

Closing the MCP connection ends the streaming session, so every scenario gets a
clean machine. Connection pattern follows aws-samples/sample-code-for-workspaces-agent-access.
"""
from __future__ import annotations

import base64
import json
import logging
import time
import uuid
from typing import Any

import boto3
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
from strands.tools.mcp import MCPClient

from .config import HarnessConfig

log = logging.getLogger(__name__)

STREAMING_URL_HEADER = "X-Amzn-AgentAccess-Streaming-Session-Url"
SCREENSHOT_TOOL = "screenshot"


class ToolError(RuntimeError):
    pass


class DesktopSession:
    def __init__(self, cfg: HarnessConfig, user_id: str):
        self.cfg = cfg
        self.user_id = user_id
        self.streaming_url: str | None = None
        self.client: MCPClient | None = None
        self._tools: list[Any] = []

    # ------------------------------------------------------------------ lifecycle
    def __enter__(self) -> "DesktopSession":
        appstream = boto3.client("appstream", region_name=self.cfg.region)
        resp = appstream.create_streaming_url(
            StackName=self.cfg.stack_name,
            FleetName=self.cfg.fleet_name,
            UserId=self.user_id,
            Validity=self.cfg.streaming_url_validity,
        )
        self.streaming_url = resp["StreamingURL"]
        url = self.streaming_url

        def factory():
            return aws_iam_streamablehttp_client(
                endpoint=self.cfg.mcp_endpoint,
                aws_service=self.cfg.mcp_service,
                aws_region=self.cfg.region,
                headers={STREAMING_URL_HEADER: url},
            )

        self.client = MCPClient(factory, startup_timeout=180)
        self.client.__enter__()
        self._wait_until_ready()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.client is not None:
            try:
                self.client.__exit__(exc_type, exc, tb)
            except Exception:  # never mask the original error
                log.exception("error closing MCP session")

    def _list_all_tools(self) -> list[Any]:
        assert self.client is not None
        tools: list[Any] = []
        token = None
        while True:
            page = self.client.list_tools_sync(pagination_token=token)
            tools.extend(page)
            token = getattr(page, "pagination_token", None)
            if not token:
                return tools

    def _wait_until_ready(self) -> None:
        """Desktop provisioning is asynchronous; wait until computer-use tools appear."""
        deadline = time.monotonic() + self.cfg.session_ready_timeout
        while True:
            self._tools = self._list_all_tools()
            if any(self._mcp_name(t) == SCREENSHOT_TOOL for t in self._tools):
                log.info("session %s ready with %d tools", self.user_id, len(self._tools))
                return
            if time.monotonic() > deadline:
                names = [self._mcp_name(t) for t in self._tools]
                raise TimeoutError(f"desktop not ready after {self.cfg.session_ready_timeout}s; tools={names}")
            time.sleep(10)

    # ------------------------------------------------------------------ tools
    @staticmethod
    def _mcp_name(tool: Any) -> str:
        mcp_tool = getattr(tool, "mcp_tool", None)
        return getattr(mcp_tool, "name", None) or tool.tool_name

    def tool_names(self) -> list[str]:
        return [self._mcp_name(t) for t in self._tools]

    def resolve(self, name: str) -> str:
        """Forwarded tools may be namespaced (e.g. 'flaui.assert_element'); match on suffix."""
        names = self.tool_names()
        if name in names:
            return name
        matches = [n for n in names if n.endswith(("." + name, "__" + name, "-" + name, "/" + name))]
        if len(matches) == 1:
            return matches[0]
        raise ToolError(f"tool '{name}' not found (or ambiguous: {matches}); available: {names}")

    def call(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        assert self.client is not None
        resolved = self.resolve(name)
        result = self.client.call_tool_sync(
            tool_use_id=f"h-{uuid.uuid4().hex[:12]}", name=resolved, arguments=arguments or {}
        )
        if result.get("status") == "error":
            raise ToolError(f"{resolved} failed: {self.text_of(result)[:2000]}")
        return result

    def call_json(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """Call a FlaUI tool that returns a JSON object as text."""
        text = self.text_of(self.call(name, arguments))
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise ToolError(f"{name} returned non-JSON: {text[:500]}") from e

    def call_ok(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        """Setup calls: a FlaUI tool answering {"ok": false} is a hard failure."""
        r = self.call_json(name, arguments)
        if r.get("ok") is False:
            raise ToolError(f"{name}: {r.get('message', 'failed')}")
        return r

    def agent_tools(self, deny_suffixes: tuple[str, ...]) -> list[Any]:
        """Tools exposed to the LLM. Harness-only tools (install, reset) are withheld."""
        out = []
        for t in self._tools:
            n = self._mcp_name(t)
            if any(n == d or n.endswith(("." + d, "-" + d, "__" + d)) for d in deny_suffixes):
                continue
            # Bedrock tool names must match [a-zA-Z0-9_-]+; forwarded tools can contain dots.
            if "." in t.tool_name and hasattr(t, "_agent_tool_name"):
                t._agent_tool_name = t.tool_name.replace(".", "-")
            out.append(t)
        return out

    @staticmethod
    def text_of(result: dict[str, Any]) -> str:
        return "\n".join(c["text"] for c in result.get("content", []) if isinstance(c, dict) and "text" in c)

    @staticmethod
    def image_of(result: dict[str, Any]) -> bytes:
        for c in result.get("content", []):
            img = c.get("image") if isinstance(c, dict) else None
            if img:
                data = img.get("source", {}).get("bytes")
                if isinstance(data, str):
                    return base64.b64decode(data)
                if isinstance(data, (bytes, bytearray)):
                    return bytes(data)
        raise ToolError("screenshot result contained no image")
