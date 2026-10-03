"""The real FlaUI MCP server against the real example app, on a real Windows desktop.

No fakes on the desktop side. This is what FakeDesktop stands in for elsewhere, so
these tests are also what keeps that fake honest. It runs in CI on windows-latest
(the `windows` job in ci.yml), and is skipped everywhere else.

The server is driven through the harness's own DesktopSession over stdio, the way
the agent-access service forwards it into a WorkSpaces session. Only the transport
differs.

Env (set by the CI job):
  FLAUI_SERVER_ZIP   dist/flaui-mcp-server.zip    (make flaui-zip)
  UAT_DEMO_ZIP       dist/uat-demo-<version>.zip  (make example-build)
  UAT_TLS_CERT/KEY   a localhost certificate the machine trusts, so install_build
                     downloads over real HTTPS from an allow-listed host
"""
from __future__ import annotations

import hashlib
import os
import ssl
import sys
import threading
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or "FLAUI_SERVER_ZIP" not in os.environ,
    reason="needs Windows, the published FlaUI server and the example app (CI windows job)",
)

ROOT = Path(__file__).resolve().parents[2]
VERSION = (ROOT / "example-app" / "VERSION").read_text().strip()
APPDATA_STATE = Path(os.environ.get("APPDATA", "")) / "UatDemo"


# ----------------------------------------------------------------- fixtures
@pytest.fixture(scope="module")
def work(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("flaui-live")


@pytest.fixture(scope="module")
def server_exe(work) -> Path:
    dest = work / "server"
    with zipfile.ZipFile(os.environ["FLAUI_SERVER_ZIP"]) as z:
        z.extractall(dest)
    exe = dest / "FlaUiMcpServer.exe"
    assert exe.exists(), "FlaUiMcpServer.exe must be at the zip root (Install-UatImage.ps1 checks the same)"
    return exe


@pytest.fixture(scope="module")
def build(work):
    """The app zip, served over HTTPS from localhost, as install_build will fetch it."""
    served = work / "served"
    served.mkdir()
    src = Path(os.environ["UAT_DEMO_ZIP"])
    (served / src.name).write_bytes(src.read_bytes())

    server = ThreadingHTTPServer(("localhost", 0), partial(QuietHandler, directory=str(served)))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.environ["UAT_TLS_CERT"], os.environ["UAT_TLS_KEY"])
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield {
        "url": f"https://localhost:{server.server_port}/{src.name}",
        "sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
    }
    server.shutdown()


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@pytest.fixture(scope="module")
def session(server_exe, work):
    from mcp import StdioServerParameters, stdio_client
    from strands.tools.mcp import MCPClient

    from uat_harness.config import HarnessConfig
    from uat_harness.session import DesktopSession

    args = [
        "--allowed-hosts", "localhost",
        "--state-root", r"%APPDATA%\UatDemo",
        "--log-root", str(work / "logs"),
        "--install-root", str(work / "install"),
    ]
    client = MCPClient(lambda: stdio_client(StdioServerParameters(
        command=str(server_exe), args=args, env=dict(os.environ))), startup_timeout=60)
    cfg = HarnessConfig(region="local", ssm_prefix="/local", fleet_name="-", stack_name="-",
                        evidence_bucket="-", builds_bucket="-", mcp_endpoint="stdio", model_id="-",
                        max_concurrent=1)
    s = DesktopSession(cfg, "local")
    s.client = client
    client.__enter__()
    s._tools = s._list_all_tools()  # no computer-use tools here, so no _wait_until_ready
    try:
        yield s
    finally:
        try:
            s.call_json("reset_app_state", {"processName": "UatDemo", "relativePaths": []})
        finally:
            client.__exit__(None, None, None)


@pytest.fixture(scope="module")
def exe(work) -> str:
    return str(work / "install" / "app" / "UatDemo.exe")


# ----------------------------------------------------------------- the server's surface
def test_the_server_offers_every_tool_the_fake_desktop_assumes(session):
    from support import FLAUI  # harness/tests/support.py

    assert set(FLAUI) <= set(session.tool_names())


def test_install_build_refuses_a_host_not_on_the_allow_list(session, build):
    r = session.call_json("install_build", {"url": "https://example.com/App.zip", "sha256": build["sha256"]})

    assert r["ok"] is False and "allowed-hosts" in r["message"]


def test_install_build_refuses_a_build_whose_checksum_does_not_match(session, build):
    r = session.call_json("install_build", {"url": build["url"], "sha256": "0" * 64})

    assert r["ok"] is False and "sha256 mismatch" in r["message"]


def test_install_build_installs_the_zip_over_https(session, build, exe):
    r = session.call_ok("install_build", {"url": build["url"], "sha256": build["sha256"]})

    assert r["data"]["sha256"] == build["sha256"]
    assert Path(exe).exists()


def test_launch_app_refuses_anything_outside_the_launch_roots(session):
    r = session.call_json("launch_app", {"executablePath": r"C:\Windows\System32\notepad.exe"})

    assert r["ok"] is False and "launch-roots" in r["message"]


# ----------------------------------------------------------------- the example scenario's flow
def test_reset_then_launch_shows_the_sign_in_screen(session, exe):
    session.call_ok("reset_app_state", {"processName": "UatDemo", "relativePaths": ["UatDemo"]})

    r = session.call_ok("launch_app", {"executablePath": exe, "arguments": "--uat"})

    assert r["data"]["title"] == f"UAT Demo {VERSION}"
    for automation_id in ("AppLogo", "UsernameBox", "PasswordBox", "SignInButton"):
        a = session.call_json("assert_element", {"automationId": automation_id, "property": "exists",
                                                 "expected": "true"})
        assert a["pass"], (automation_id, a)


def test_the_sign_in_button_is_enabled(session):
    a = session.call_json("assert_element", {"automationId": "SignInButton", "property": "isEnabled",
                                             "expected": "true"})
    assert a["pass"], a


def test_a_wrong_password_is_refused_on_screen(session):
    session.call_ok("set_text", {"automationId": "UsernameBox", "text": "uat.tester"})
    session.call_ok("set_text", {"automationId": "PasswordBox", "text": "wrong"})
    session.call_ok("click_element", {"automationId": "SignInButton"})

    a = session.call_json("assert_element", {"automationId": "SignInError", "property": "name",
                                             "expected": "Incorrect", "comparison": "contains"})
    assert a["pass"], a


def test_signing_in_shows_the_dashboard(session):
    session.call_ok("set_text", {"automationId": "PasswordBox", "text": "Uat-Test-Only-1"})
    session.call_ok("click_element", {"automationId": "SignInButton"})

    a = session.call_json("assert_element", {"automationId": "DisplayName", "property": "name",
                                             "expected": "UAT Tester", "comparison": "contains"})
    assert a["pass"], a


def test_a_failing_assertion_reports_what_it_saw(session):
    """The reply shape the harness reads in runner._run_deterministic, and FakeDesktop imitates."""
    a = session.call_json("assert_window_title", {"expected": "Not this app", "timeoutSeconds": 1})

    assert a["pass"] is False
    assert a["actual"] == f"UAT Demo {VERSION} - UAT Tester"
    assert {"pass", "actual", "expected", "message"} <= set(a)


def test_the_committed_scenario_passes_its_deterministic_criteria(session):
    """harness/scenarios/smoke-launch-and-login.yaml targets this app. Its exact checks hold."""
    from uat_harness.models import Scenario
    from uat_harness.runner import _run_deterministic

    sc = Scenario.model_validate(yaml.safe_load(
        (ROOT / "harness" / "scenarios" / "smoke-launch-and-login.yaml").read_text(encoding="utf-8")))
    det = [c for c in sc.criteria if c.kind == "deterministic"]
    assert det

    results = {c.id: _run_deterministic(session, c) for c in det}

    assert {k: (r.status, r.observation, r.actual) for k, r in results.items() if r.status != "PASS"} == {}


def test_the_reports_tab_exports_a_pdf_to_documents(session):
    session.call_ok("click_element", {"name": "Reports", "controlType": "TabItem"})
    enabled = session.call_json("assert_element", {"automationId": "ExportButton", "property": "isEnabled",
                                                   "expected": "true"})
    assert enabled["pass"], enabled

    session.call_ok("click_element", {"automationId": "ExportButton"})

    a = session.call_json("assert_element", {"automationId": "ExportStatus", "property": "name",
                                             "expected": "Exported Monthly summary", "comparison": "contains"})
    assert a["pass"], a
    pdf = Path(os.environ["USERPROFILE"]) / "Documents" / "Monthly summary.pdf"
    assert pdf.read_bytes().startswith(b"%PDF-1.4")


def test_the_ui_tree_exposes_the_automation_ids(session):
    import json
    tree = json.dumps(session.call_json("dump_ui_tree", {"maxDepth": 3}))

    for automation_id in ("DisplayName", "MainTabs", "ExportButton", "StatusBarConnection"):
        assert f'"id": "{automation_id}"' in tree, automation_id


def test_the_app_log_is_readable_from_the_state_root(session):
    r = session.call_ok("read_log_tail", {"path": r"%APPDATA%\UatDemo\uatdemo.log", "lines": 20})

    lines = "\n".join(r["data"]["lines"])
    assert "signed in as uat.tester" in lines
    assert "exported Monthly summary" in lines


def test_the_app_remembers_the_user_until_reset(session, exe):
    session.call_ok("launch_app", {"executablePath": exe})  # replaces the running instance
    remembered = session.call_json("assert_element", {"automationId": "UsernameBox", "property": "value",
                                                      "expected": "uat.tester"})
    assert remembered["pass"], remembered

    session.call_ok("reset_app_state", {"processName": "UatDemo", "relativePaths": ["UatDemo"]})
    assert not APPDATA_STATE.exists()
    session.call_ok("launch_app", {"executablePath": exe})

    forgotten = session.call_json("assert_element", {"automationId": "UsernameBox", "property": "value",
                                                     "expected": "", "timeoutSeconds": 2})
    assert forgotten["pass"], forgotten


def test_reset_refuses_paths_outside_the_state_root(session):
    r = session.call_json("reset_app_state", {"processName": "UatDemo", "relativePaths": [r"..\..\Windows"]})

    assert r["ok"] is False and "outside --state-root" in r["message"]
