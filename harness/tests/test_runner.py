"""run_scenario end to end against the fake desktop: install, setup, launch, agent, assertions."""
import re
from contextlib import contextmanager
from urllib.parse import parse_qs, urlparse

import pytest

from support import SHA, open_session, scenario
from uat_harness import runner
from uat_harness.models import AgentCriterionVerdict, AgentVerdict, Finding


@pytest.fixture
def run(cfg, ctx, desktop, boto, monkeypatch):
    """run_scenario with the desktop, boto3 and the agent replaced."""
    opened = []

    @contextmanager
    def fake_session(c, user_id):
        s = open_session(c, desktop, user_id)
        opened.append(s)
        yield s

    monkeypatch.setattr(runner, "DesktopSession", fake_session)
    monkeypatch.setattr(runner.boto3, "client", boto.client)

    def _run(agent=None, sc=None, **ctx_overrides):
        def default_agent(session, recorder, scenario_, cfg_):
            ev = recorder.capture("sign-in screen")
            return AgentVerdict(summary="looked fine", criteria=[
                AgentCriterionVerdict(criterion_id="C1", status="PASS", observation="ok", evidence=[ev.id])])
        monkeypatch.setattr(runner, "run_agent", agent or default_agent)
        return runner.run_scenario(sc or scenario(), cfg, ctx.model_copy(update=ctx_overrides))

    _run.opened = opened
    return _run


def test_a_scenario_whose_criteria_all_pass_passes(run, desktop):
    result = run()

    assert result.status == "PASS", result.error
    assert [(c.criterion_id, c.status, c.source) for c in result.criteria] == [
        ("C1", "PASS", "agent"), ("C2", "PASS", "deterministic")]
    assert result.agent_summary == "looked fine"


def test_setup_runs_in_order_before_the_agent_and_assertions_after(run, desktop):
    run()

    order = desktop.order()
    assert order.index("install_build") < order.index("reset_app_state") < order.index("launch_app")
    assert order.index("launch_app") < order.index("assert_element")


def test_the_build_is_installed_from_a_presigned_url_with_its_checksum(run, desktop):
    run()

    [args] = desktop.called("install_build")
    assert args["sha256"] == SHA
    assert args["url"].startswith("https://builds.s3.example/artifactory/r/x/App.msi")
    assert args["installerArgs"] == "ALLUSERS=2 MSIINSTALLPERUSER=1"


def test_no_installer_args_means_none_are_sent(run, desktop):
    run(sc=scenario(installer_args=None))

    assert "installerArgs" not in desktop.called("install_build")[0]


def test_the_app_is_launched_as_the_scenario_says(run, desktop):
    run()

    assert desktop.called("launch_app") == [
        {"executablePath": "C:\\App\\App.exe", "arguments": "--uat", "mainWindowTimeoutSeconds": 90}]


def test_evidence_brackets_the_agent_and_is_uploaded(run, boto):
    result = run()

    assert [e.label for e in result.evidence] == ["app launched", "sign-in screen", "final state"]
    assert sorted(boto.s3.objects) == [
        "evidence/runs/1234-1/smoke/E001-app-launched.png",
        "evidence/runs/1234-1/smoke/E002-sign-in-screen.png",
        "evidence/runs/1234-1/smoke/E003-final-state.png",
    ]


def test_a_failing_assertion_fails_the_scenario_and_reports_what_it_saw(run, desktop):
    desktop.on("assert_element", {"pass": False, "message": "name was 'Offline'", "actual": "Offline"})

    result = run()

    assert result.status == "FAIL"
    c2 = result.criteria[1]
    assert (c2.status, c2.observation, c2.actual) == ("FAIL", "name was 'Offline'", "Offline")


def test_an_assertion_tool_that_errors_is_a_failure_not_a_crash(run, desktop):
    desktop.fail("assert_element", "element not found")

    result = run()

    assert result.status == "FAIL"
    assert "assertion tool error" in result.criteria[1].observation


def test_no_agent_verdict_leaves_visual_criteria_not_run_and_fails(run):
    result = run(agent=lambda *a: None)

    assert result.status == "FAIL"
    assert result.criteria[0].status == "NOT_RUN"
    assert result.criteria[0].source == "harness"


def test_a_blocked_visual_criterion_fails_the_scenario(run):
    result = run(agent=lambda *a: AgentVerdict(summary="s", criteria=[
        AgentCriterionVerdict(criterion_id="C1", status="BLOCKED", observation="no login screen")]))

    assert result.status == "FAIL"


def test_findings_are_carried_into_the_result(run):
    finding = Finding(severity="minor", title="typo", description="Sigin")

    result = run(agent=lambda *a: AgentVerdict(summary="s", findings=[finding], criteria=[
        AgentCriterionVerdict(criterion_id="C1", status="BLOCKED", observation="o")]))

    assert result.findings == [finding]


def test_a_failed_install_is_an_error_and_nothing_is_launched(run, desktop):
    desktop.on("install_build", {"ok": False, "message": "msiexec 1603"})

    result = run()

    assert result.status == "ERROR"
    assert "msiexec 1603" in result.error
    assert desktop.called("launch_app") == []


def test_an_agent_crash_is_an_error_but_keeps_the_evidence_so_far(run):
    def crash(session, recorder, *a):
        recorder.capture("before crash")
        raise RuntimeError("bedrock throttled")

    result = run(agent=crash)

    assert result.status == "ERROR"
    assert "RuntimeError: bedrock throttled" in result.error
    assert [e.label for e in result.evidence] == ["app launched", "before crash"]
    assert result.duration_seconds >= 0 and result.ended_at >= result.started_at


def test_observe_publishes_a_secure_link_not_a_log_line(run, boto, capsys):
    run(observe=True)

    [put] = boto.ssm.puts
    assert put["Type"] == "SecureString"
    assert put["Name"].startswith("/desktop-uat/prod/observe/uat-")
    assert put["Value"] not in capsys.readouterr().out


def test_observe_failing_does_not_fail_the_scenario(run, boto, monkeypatch):
    monkeypatch.setattr(boto.ssm, "put_parameter", lambda **kw: (_ for _ in ()).throw(RuntimeError("denied")))

    assert run(observe=True).status == "PASS"


def test_no_observer_link_unless_asked(run, boto):
    run()

    assert boto.ssm.puts == []


@pytest.mark.parametrize("run_id", ["1234-1", "98765432101234-12", "run id with spaces & symbols!", "x"])
def test_session_user_ids_meet_the_appstream_constraint(run_id):
    uid = runner.session_user_id(run_id, "smoke-login")

    assert 2 <= len(uid) <= 32
    assert re.fullmatch(r"[\w+=,.@-]+", uid)


def test_session_user_ids_differ_per_scenario_and_are_stable():
    a = runner.session_user_id("1234-1", "a")

    assert a == runner.session_user_id("1234-1", "a")
    assert a != runner.session_user_id("1234-1", "b")
    assert a != runner.session_user_id("1235-1", "a")


def test_presign_gives_a_virtual_hosted_regional_url(cfg, monkeypatch):
    """The desktop reaches S3 only via the gateway endpoint, which needs the regional host.
    Real botocore: presigning is local signing, no network."""
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")

    url = urlparse(runner.presign(cfg, "s3://builds/artifactory/r/abc/App 1.msi"))

    assert url.hostname == "builds.s3.ap-southeast-2.amazonaws.com"
    assert url.path == "/artifactory/r/abc/App%201.msi"
    assert parse_qs(url.query)["X-Amz-Expires"] == ["900"]
