"""Walkthrough mode: the harness drives the app itself from the scenario's
`walkthrough:` steps, with no agent and no AWS.

Deterministic criteria are judged exactly as in an agent run. Visual criteria
cannot be judged without the model, so they are reported NOT_RUN and pending
review, citing the screenshots for a person to judge, and they do not fail
the scenario.
"""
from contextlib import contextmanager

import pytest
from pydantic import ValidationError

from support import PNG, FakeDesktop, open_session, scenario
from uat_harness import runner
from uat_harness.local import LocalBackend, LocalDesktopSession
from uat_harness.models import HARNESS_ONLY_TOOLS, RunReport
from uat_harness.session import SCREENSHOT_TOOL

WALK = [
    {"tool": "set_text", "arguments": {"automationId": "UsernameBox", "text": "uat.tester"}},
    {"tool": "click_element", "arguments": {"automationId": "SignInButton"}, "capture": "dashboard"},
    {"tool": "click_element", "arguments": {"name": "Reports"}, "capture": "reports tab"},
]


@pytest.fixture
def run(cfg, ctx, desktop):
    def _run(sc=None, url="https://localhost:8443/App.zip"):
        @contextmanager
        def session(user_id):
            yield open_session(cfg, desktop, user_id)
        return runner.execute(sc or scenario(walkthrough=WALK), ctx, LocalBackend(session, url))
    return _run


# ----------------------------------------------------------------- the model
def test_a_walkthrough_step_may_capture_a_labelled_screenshot():
    sc = scenario(walkthrough=WALK)

    assert [s.capture for s in sc.walkthrough] == [None, "dashboard", "reports tab"]


@pytest.mark.parametrize("tool", sorted(HARNESS_ONLY_TOOLS))
def test_a_walkthrough_cannot_call_harness_only_tools(tool):
    """Install, reset and launch are the setup's job, done before any walkthrough."""
    with pytest.raises(ValidationError, match="harness-only"):
        scenario(walkthrough=[{"tool": tool}])


def test_the_agent_denylist_is_the_harness_only_list():
    from uat_harness.agent import AGENT_DENYLIST

    assert set(AGENT_DENYLIST) == set(HARNESS_ONLY_TOOLS)


def test_reports_default_to_agent_mode():
    assert RunReport.model_fields["mode"].default == "agent"


# ----------------------------------------------------------------- running it
def test_the_walkthrough_runs_in_order_after_launch_and_before_assertions(run, desktop):
    run()

    order = desktop.order()
    launch, walk = order.index("launch_app"), [i for i, n in enumerate(order) if n in ("set_text", "click_element")]
    assert walk and min(walk) > launch
    assert max(walk) < order.index("assert_element")
    assert desktop.called("set_text") == [{"automationId": "UsernameBox", "text": "uat.tester"}]


def test_each_capture_is_evidence_in_order(run):
    result = run()

    assert [(e.id, e.label) for e in result.evidence] == [
        ("E001", "app launched"), ("E002", "dashboard"), ("E003", "reports tab"), ("E004", "final state")]


def test_evidence_stays_local_with_no_bucket(run, ctx):
    result = run()

    assert all(e.s3_uri is None for e in result.evidence)
    assert all(e.local_path.startswith(ctx.out_dir) for e in result.evidence)


def test_visual_criteria_await_review_citing_every_screenshot_and_do_not_fail(run):
    result = run()

    visual = result.criteria[0]
    assert (visual.kind, visual.status, visual.source) == ("visual", "NOT_RUN", "harness")
    assert "walkthrough" in visual.observation and "review" in visual.observation.lower()
    assert visual.evidence == ["E001", "E002", "E003", "E004"]
    assert result.status == "PASS"


def test_deterministic_criteria_are_judged_for_real(run, desktop):
    desktop.on("assert_element", {"pass": False, "message": "name was 'Offline'", "actual": "Offline"})

    result = run()

    assert result.status == "FAIL"
    assert result.criteria[1].actual == "Offline"


def test_the_build_comes_from_the_given_url_not_s3(run, desktop):
    run(url="https://localhost:9999/uat-demo-1.4.0.zip")

    assert desktop.called("install_build")[0]["url"] == "https://localhost:9999/uat-demo-1.4.0.zip"


def test_a_failing_step_is_an_error_with_a_screenshot_of_the_moment(run, desktop):
    desktop.on("click_element", {"ok": False, "message": "element not found"})

    result = run()

    assert result.status == "ERROR"
    assert "click_element: element not found" in result.error
    assert result.evidence[-1].label == "at error"


def test_a_scenario_without_a_walkthrough_still_runs_its_assertions(run, desktop):
    result = run(sc=scenario())

    assert result.status == "PASS"
    assert desktop.called("set_text") == []
    assert [e.label for e in result.evidence] == ["app launched", "final state"]


# ----------------------------------------------------------------- the local session
def test_the_local_session_offers_a_screenshot_tool_beside_the_servers(cfg):
    desktop = FakeDesktop()
    desktop.tools = [t for t in desktop.tools if t.tool_name != SCREENSHOT_TOOL]  # FlaUI has none
    shots = []

    def capture():
        shots.append(1)
        return PNG

    with LocalDesktopSession(lambda: desktop, capture=capture) as s:
        assert SCREENSHOT_TOOL in s.tool_names()
        assert s.image_of(s.call(SCREENSHOT_TOOL)) == PNG
        s.call_ok("launch_app", {})

    assert shots == [1]
    assert desktop.called("launch_app") == [{}]
    assert desktop.exited


def test_the_local_session_closes_the_server_even_when_a_step_raises(cfg):
    desktop = FakeDesktop()

    with pytest.raises(RuntimeError):
        with LocalDesktopSession(lambda: desktop, capture=lambda: PNG):
            raise RuntimeError("boom")

    assert desktop.exited
