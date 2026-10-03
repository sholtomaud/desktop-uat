"""DesktopSession: tool discovery, name resolution, and the harness's call contracts."""
import pytest

from support import PNG, FakeDesktop, b64, open_session
from uat_harness.agent import AGENT_DENYLIST
from uat_harness.session import DesktopSession, ToolError


def test_lists_tools_across_every_page(cfg, desktop):
    s = open_session(cfg, desktop)

    assert len(s.tool_names()) == len(desktop.tools) > desktop.page_size


@pytest.mark.parametrize("namespace", ["", "flaui.", "flaui__", "flaui-", "flaui/"])
def test_resolves_a_forwarded_tool_whatever_its_namespace(cfg, namespace):
    s = open_session(cfg, FakeDesktop(namespace=namespace))

    assert s.resolve("assert_element") == namespace + "assert_element"


def test_an_unknown_tool_names_what_is_available(cfg, desktop):
    s = open_session(cfg, desktop)

    with pytest.raises(ToolError, match="not found.*available"):
        s.resolve("click_button")


def test_an_ambiguous_suffix_is_refused_rather_than_guessed(cfg, desktop):
    desktop.tools += FakeDesktop(namespace="other.").tools[-1:]  # a second *.dump_ui_tree
    s = open_session(cfg, desktop)

    with pytest.raises(ToolError, match="ambiguous"):
        s.resolve("dump_ui_tree")


def test_an_error_result_raises(cfg, desktop):
    desktop.fail("launch_app", "process exited with code 3")
    s = open_session(cfg, desktop)

    with pytest.raises(ToolError, match="process exited with code 3"):
        s.call("launch_app")


def test_call_json_rejects_text_that_is_not_json(cfg, desktop):
    desktop.handlers["dump_ui_tree"] = lambda a: {"status": "success", "content": [{"text": "<tree/>"}]}
    s = open_session(cfg, desktop)

    with pytest.raises(ToolError, match="non-JSON"):
        s.call_json("dump_ui_tree")


def test_call_ok_turns_ok_false_into_a_failure(cfg, desktop):
    desktop.on("install_build", {"ok": False, "message": "sha256 mismatch"})
    s = open_session(cfg, desktop)

    with pytest.raises(ToolError, match="install_build: sha256 mismatch"):
        s.call_ok("install_build", {})


def test_the_agent_never_sees_harness_only_tools(cfg, desktop):
    s = open_session(cfg, desktop)

    names = [t.tool_spec["name"] for t in s.agent_tools(AGENT_DENYLIST)]

    for denied in AGENT_DENYLIST:
        assert not any(n.endswith(denied) for n in names), denied
    assert "screenshot" in names


def test_agent_facing_names_are_valid_bedrock_tool_names(cfg, desktop):
    s = open_session(cfg, desktop)

    tools = s.agent_tools(AGENT_DENYLIST)

    import re
    for t in tools:
        assert re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", t.tool_spec["name"]), t.tool_spec["name"]
    # ...while the server is still called by its own name
    assert any(t.mcp_tool.name == "flaui.assert_element" for t in tools)


def test_text_of_joins_text_blocks_and_skips_others():
    r = {"content": [{"text": "a"}, {"image": {}}, {"text": "b"}]}

    assert DesktopSession.text_of(r) == "a\nb"


@pytest.mark.parametrize("data", [PNG, bytearray(PNG), b64(PNG)])
def test_image_of_accepts_bytes_or_base64(data):
    r = {"content": [{"text": "x"}, {"image": {"source": {"bytes": data}}}]}

    assert DesktopSession.image_of(r) == PNG


def test_image_of_without_an_image_raises():
    with pytest.raises(ToolError):
        DesktopSession.image_of({"content": [{"text": "no screenshot"}]})


def test_waits_until_the_desktop_offers_a_screenshot_tool(cfg, desktop, monkeypatch):
    """Provisioning is asynchronous: the first listings come back without computer-use tools."""
    import uat_harness.session as session_mod
    full = desktop.tools
    listings = iter([[], full[4:], full])
    desktop.list_tools_sync = lambda pagination_token=None: next(listings)
    monkeypatch.setattr(session_mod.time, "sleep", lambda s: None)
    s = DesktopSession(cfg, "u")
    s.client = desktop

    s._wait_until_ready()

    assert "screenshot" in s.tool_names()


def test_gives_up_on_a_desktop_that_never_becomes_ready(cfg, desktop, monkeypatch):
    import dataclasses
    import uat_harness.session as session_mod
    desktop.tools = desktop.tools[4:]  # no computer-use tools, ever
    monkeypatch.setattr(session_mod.time, "sleep", lambda s: None)
    s = DesktopSession(dataclasses.replace(cfg, session_ready_timeout=0), "u")
    s.client = desktop

    with pytest.raises(TimeoutError, match="not ready"):
        s._wait_until_ready()
