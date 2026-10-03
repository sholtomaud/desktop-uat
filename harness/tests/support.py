"""A fake WorkSpaces desktop for the harness: what the agent-access MCP endpoint
would answer, with the FlaUI tools forwarded from inside the session.

The harness code under test is real — DesktopSession, EvidenceRecorder, the
runner, the agent's verdict tools. What is replaced is the MCP connection, boto3
and the Bedrock agent loop: the parts that need an AWS account.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Callable

import pytest
from mcp.types import Tool as McpTool
from strands.tools.mcp.mcp_agent_tool import MCPAgentTool

from uat_harness.config import HarnessConfig
from uat_harness.models import BuildRef, RunContext, Scenario
from uat_harness.session import DesktopSession

PNG = b"\x89PNG\r\n\x1a\n" + b"fake-image-data"
SHA = "a" * 64

# Computer-use tools come from the service unprefixed; forwarded FlaUI tools are
# namespaced. The harness resolves both by suffix, so the fake does the same.
COMPUTER_USE = ["screenshot", "left_click", "type_text", "key"]
FLAUI = ["install_build", "reset_app_state", "launch_app", "assert_element", "assert_window_title",
         "dump_ui_tree"]


class Page(list):
    """strands returns a list with an optional pagination_token attribute."""
    def __init__(self, items, token=None):
        super().__init__(items)
        self.pagination_token = token


class FakeDesktop:
    """Stands in for strands' MCPClient. Handlers answer tool calls by MCP name."""

    def __init__(self, namespace: str = "flaui."):
        names = COMPUTER_USE + [namespace + n for n in FLAUI]
        self.tools = [MCPAgentTool(McpTool(name=n, inputSchema={"type": "object"}), self) for n in names]
        self.calls: list[tuple[str, dict]] = []
        self.handlers: dict[str, Callable[[dict], dict]] = {
            "screenshot": lambda a: {"status": "success",
                                     "content": [{"image": {"format": "png", "source": {"bytes": PNG}}}]},
        }
        for n in ("install_build", "reset_app_state", "launch_app"):
            self.on(n, {"ok": True})
        self.on("assert_element", {"pass": True, "message": "ok", "actual": "Connected"})
        self.on("assert_window_title", {"pass": True, "message": "ok", "actual": "YourApp 1.4.0"})
        self.page_size = 3

    def on(self, suffix: str, answer: dict | Callable[[dict], dict]) -> None:
        """Answer a tool with a JSON object as text, like the FlaUI server does."""
        fn = answer if callable(answer) else (lambda a, _ans=answer: _ans)
        self.handlers[suffix] = lambda a: {"status": "success", "content": [{"text": json.dumps(fn(a))}]}

    def fail(self, suffix: str, text: str) -> None:
        self.handlers[suffix] = lambda a: {"status": "error", "content": [{"text": text}]}

    # --- the MCPClient surface DesktopSession uses
    def list_tools_sync(self, pagination_token=None):
        start = int(pagination_token or 0)
        end = start + self.page_size
        return Page(self.tools[start:end], str(end) if end < len(self.tools) else None)

    def call_tool_sync(self, tool_use_id: str, name: str, arguments: dict):
        self.calls.append((name, arguments))
        suffix = name.rsplit(".", 1)[-1]
        if suffix not in self.handlers:
            return {"status": "error", "content": [{"text": f"unknown tool {name}"}]}
        return self.handlers[suffix](arguments)

    def called(self, suffix: str) -> list[dict]:
        return [a for n, a in self.calls if n.rsplit(".", 1)[-1] == suffix]

    def order(self) -> list[str]:
        return [n.rsplit(".", 1)[-1] for n, _ in self.calls]


def open_session(cfg: HarnessConfig, desktop: FakeDesktop, user_id: str = "uat-test") -> DesktopSession:
    """A DesktopSession wired to the fake, as __enter__ would leave it."""
    s = DesktopSession(cfg, user_id)
    s.client = desktop  # type: ignore[assignment]
    s._tools = s._list_all_tools()
    return s


class FakeS3:
    def __init__(self):
        self.objects: dict[str, dict[str, Any]] = {}
        self.uploads: list[tuple[str, str, str]] = []

    def put_object(self, Bucket, Key, Body, ContentType):  # noqa: N803 (boto3's casing)
        self.objects[f"{Bucket}/{Key}"] = {"body": Body, "content_type": ContentType}

    def upload_file(self, filename, bucket, key):
        self.uploads.append((filename, bucket, key))

    def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
        return f"https://{Params['Bucket']}.s3.example/{Params['Key']}?X-Amz-Expires={ExpiresIn}"


class FakeAppStream:
    def __init__(self):
        self.urls: list[dict] = []

    def create_streaming_url(self, **kw):
        self.urls.append(kw)
        return {"StreamingURL": f"https://stream.example/{kw['UserId']}"}


class FakeSsm:
    def __init__(self, params: dict[str, str] | None = None):
        self.params = dict(params or {})
        self.puts: list[dict] = []

    def put_parameter(self, **kw):
        self.puts.append(kw)

    def get_paginator(self, name):
        assert name == "get_parameters_by_path"
        params = self.params

        class P:
            def paginate(self, Path, Recursive):  # noqa: N803
                items = [{"Name": f"{Path}/{k}", "Value": v} for k, v in params.items()]
                yield {"Parameters": items[:3]}
                yield {"Parameters": items[3:]}
        return P()


class FakeBoto:
    """Replaces boto3.client in a module under test."""
    def __init__(self):
        self.s3 = FakeS3()
        self.appstream = FakeAppStream()
        self.ssm = FakeSsm()

    def client(self, service, **kw):
        return {"s3": self.s3, "appstream": self.appstream, "ssm": self.ssm}[service]


@pytest.fixture
def cfg() -> HarnessConfig:
    return HarnessConfig(
        region="ap-southeast-2", ssm_prefix="/desktop-uat/prod", fleet_name="fleet", stack_name="stack",
        evidence_bucket="evidence", builds_bucket="builds",
        mcp_endpoint="https://agentaccess-mcp.ap-southeast-2.api.aws/mcp",
        model_id="test-model", max_concurrent=2,
    )


@pytest.fixture
def desktop() -> FakeDesktop:
    return FakeDesktop()


@pytest.fixture
def boto() -> FakeBoto:
    return FakeBoto()


@pytest.fixture
def ctx(tmp_path: Path) -> RunContext:
    return RunContext(run_id="1234-1", git_ref="refs/heads/main", git_sha="abc", out_dir=str(tmp_path / "reports"),
                      build=BuildRef(s3_uri="s3://builds/artifactory/r/x/App.msi", sha256=SHA, name="App.msi"))


def scenario(**overrides) -> Scenario:
    data = {
        "id": "smoke", "title": "Smoke", "tags": ["smoke"],
        "installer_args": "ALLUSERS=2 MSIINSTALLPERUSER=1",
        "setup": [{"tool": "reset_app_state", "arguments": {"processName": "YourApp"}}],
        "launch": {"executable": "C:\\App\\App.exe", "arguments": "--uat"},
        "instructions": "Sign in.",
        "criteria": [
            {"id": "C1", "kind": "visual", "description": "Sign-in screen renders."},
            {"id": "C2", "kind": "deterministic", "description": "Connected.",
             "assertion": {"tool": "assert_element", "arguments": {"automationId": "Status"}}},
        ],
    }
    data.update(overrides)
    return Scenario.model_validate(data)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()
