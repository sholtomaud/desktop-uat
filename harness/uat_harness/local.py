"""Local mode: run scenarios on this Windows machine, with no AWS and no agent.

The FlaUI MCP server runs as a child process over stdio, exactly the server the
WorkSpaces image forwards. The scenario's walkthrough drives the app, and the
harness takes its own screenshots, because outside WorkSpaces nothing else provides
them. Everything else (setup, launch, assertions, evidence, reports) is the same
code path as an agent run: runner.execute.
"""
from __future__ import annotations

import os
import ssl
import subprocess
import tempfile
import threading
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterator, Optional

from .evidence import EvidenceRecorder
from .models import RunMode
from .runner import run_walkthrough
from .session import SCREENSHOT_TOOL, DesktopSession


# ----------------------------------------------------------------- the FlaUI server
def flaui_server_args(allowed_hosts: str, state_root: str, log_root: Optional[str],
                      install_root: Optional[str]) -> list[str]:
    """The guard rails Install-UatImage.ps1 gives the server on the image."""
    args = ["--allowed-hosts", allowed_hosts, "--state-root", state_root]
    if log_root:
        args += ["--log-root", log_root]
    if install_root:
        args += ["--install-root", install_root]
    return args


def flaui_stdio_client(exe: str, args: list[str]):
    from mcp import StdioServerParameters, stdio_client
    from strands.tools.mcp import MCPClient

    return MCPClient(lambda: stdio_client(StdioServerParameters(command=exe, args=args, env=dict(os.environ))),
                     startup_timeout=60)


# ----------------------------------------------------------------- the screen
_CAPTURE_PS = (
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing; "
    "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen; "
    "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; "
    "[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); "
    "$bmp.Save('{out}')"
)


def capture_screen() -> bytes:
    """The whole desktop as PNG, through PowerShell and .NET, so no new dependency."""
    fd, out = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", _CAPTURE_PS.format(out=out)],
                       check=True, capture_output=True, timeout=60)
        return Path(out).read_bytes()
    finally:
        Path(out).unlink(missing_ok=True)


class LocalDesktopSession(DesktopSession):
    """The FlaUI server's tools, plus a `screenshot` tool answered by this machine."""

    def __init__(self, client_factory: Callable[[], Any], capture: Callable[[], bytes]):
        super().__init__(cfg=None, user_id="local")  # type: ignore[arg-type]
        self._client_factory = client_factory
        self._capture = capture

    def __enter__(self) -> "LocalDesktopSession":
        self.client = self._client_factory()
        self.client.__enter__()
        self._tools = self._list_all_tools()
        return self

    def tool_names(self) -> list[str]:
        return super().tool_names() + [SCREENSHOT_TOOL]

    def call(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        if name == SCREENSHOT_TOOL:
            return {"status": "success",
                    "content": [{"image": {"format": "png", "source": {"bytes": self._capture()}}}]}
        return super().call(name, arguments)


# ----------------------------------------------------------------- the build
@contextmanager
def serve_over_https(build: Path, cert: Path, key: Path) -> Iterator[str]:
    """Serve one file from localhost over TLS. install_build only downloads over HTTPS
    from an allow-listed host, and local mode should not weaken that."""
    name = build.name

    class OneFile(SimpleHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path.lstrip("/") != name:
                self.send_error(404)
                return
            super().do_GET()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("localhost", 0), partial(OneFile, directory=str(build.parent)))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(cert), str(key))
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"https://localhost:{server.server_port}/{name}"
    finally:
        server.shutdown()
        server.server_close()


# ----------------------------------------------------------------- the backend
class LocalBackend:
    """runner.Backend for this machine: no bucket, a given build URL, the walkthrough drives."""
    mode: RunMode = "walkthrough"

    def __init__(self, session_factory: Callable[[str], Any], build_url: str):
        self._session_factory = session_factory
        self._build_url = build_url

    def session(self, user_id):
        return self._session_factory(user_id)

    def build_url(self, build):
        return self._build_url

    def recorder(self, session, run_id, scenario_id, local_dir):
        return EvidenceRecorder(session, None, None, f"runs/{run_id}/{scenario_id}", local_dir)

    def session_opened(self, ctx, scenario, user_id):
        pass

    def drive(self, session, recorder, scenario):
        run_walkthrough(session, recorder, scenario)
        return None
