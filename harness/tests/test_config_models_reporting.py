"""HarnessConfig discovery, the scenario model's rules, and the three report formats."""
import xml.etree.ElementTree as ET

import pytest
from pydantic import ValidationError

from support import SHA, FakeSsm, scenario
from uat_harness import config as config_mod
from uat_harness.config import HarnessConfig
from uat_harness.models import (BuildRef, CriterionResult, Evidence, Finding, RunReport,
                                ScenarioResult)
from uat_harness.reporting import totals, workflow_annotations, write_all

PARAMS = {
    "region": "ap-southeast-2", "fleet-name": "f", "stack-name": "s", "evidence-bucket": "e",
    "builds-bucket": "b", "mcp-endpoint": "https://m", "bedrock-model-id": "model-from-ssm",
    "max-concurrent-sessions": "3",
}


# ----------------------------------------------------------------- config
@pytest.fixture
def ssm(monkeypatch):
    fake = FakeSsm(PARAMS)
    monkeypatch.setattr(config_mod.boto3, "client", lambda service, **kw: fake)
    monkeypatch.setenv("AWS_REGION", "ap-southeast-2")
    monkeypatch.delenv("UAT_MODEL_ID", raising=False)
    return fake


def test_config_is_discovered_from_ssm_across_pages(ssm):
    c = HarnessConfig.from_ssm("/desktop-uat/prod")

    assert (c.fleet_name, c.evidence_bucket, c.max_concurrent, c.model_id) == ("f", "e", 3, "model-from-ssm")


def test_the_model_can_be_overridden_for_a_run(ssm, monkeypatch):
    monkeypatch.setenv("UAT_MODEL_ID", "other-model")

    assert HarnessConfig.from_ssm("/p").model_id == "other-model"


def test_a_missing_parameter_says_which_and_why(ssm):
    del ssm.params["builds-bucket"]

    with pytest.raises(RuntimeError, match="/p/builds-bucket missing - is the Desktop stack deployed"):
        HarnessConfig.from_ssm("/p")


def test_no_region_is_an_error(ssm, monkeypatch):
    monkeypatch.delenv("AWS_REGION")
    monkeypatch.delenv("AWS_DEFAULT_REGION", raising=False)

    with pytest.raises(RuntimeError, match="AWS_REGION"):
        HarnessConfig.from_ssm("/p")


# ----------------------------------------------------------------- scenario model
def test_a_deterministic_criterion_needs_an_assertion():
    with pytest.raises(ValidationError, match="deterministic criteria need an assertion"):
        scenario(criteria=[{"id": "C1", "kind": "deterministic", "description": "d"}])


def test_a_visual_criterion_may_not_carry_an_assertion():
    with pytest.raises(ValidationError, match="judged by the agent"):
        scenario(criteria=[{"id": "C1", "kind": "visual", "description": "d", "assertion": {"tool": "t"}}])


def test_criterion_ids_are_unique():
    with pytest.raises(ValidationError, match="duplicate criterion ids"):
        scenario(criteria=[{"id": "C1", "kind": "visual", "description": "a"},
                           {"id": "C1", "kind": "visual", "description": "b"}])


def test_a_scenario_needs_at_least_one_criterion():
    with pytest.raises(ValidationError):
        scenario(criteria=[])


@pytest.mark.parametrize("bad", ["", "-x", "has space", "a/b", "x" * 49])
def test_ids_are_safe_for_s3_keys_and_file_names(bad):
    with pytest.raises(ValidationError):
        scenario(id=bad)


@pytest.mark.parametrize("seconds", [60, 9000])
def test_the_timeout_is_bounded(seconds):
    with pytest.raises(ValidationError):
        scenario(timeout_seconds=seconds)


def test_a_build_sha256_must_be_a_sha256():
    with pytest.raises(ValidationError):
        BuildRef(s3_uri="s3://b/k", sha256="ABC", name="n")


# ----------------------------------------------------------------- reporting
def result(sid, status, *criteria, **kw):
    return ScenarioResult(scenario_id=sid, title=f"title {sid}", status=status, started_at="t", ended_at="t",
                          duration_seconds=12.3, session_user_id="u", criteria=list(criteria), **kw)


def crit(cid, status, **kw):
    return CriterionResult(criterion_id=cid, description=f"desc {cid}", kind="visual", status=status,
                           source=kw.pop("source", "agent"), observation=kw.pop("observation", "obs"), **kw)


@pytest.fixture
def report():
    r = RunReport(run_id="42-1", git_ref="r", git_sha="s", build=BuildRef(s3_uri="s3://b/k", sha256=SHA, name="App.msi"),
                  model_id="m", started_at="t", ended_at="t", status="FAIL", totals={}, scenarios=[
                      result("ok", "PASS", crit("C1", "PASS")),
                      result("bad", "FAIL", crit("C1", "FAIL", observation="pipe | in\ntext", evidence=["E001"]),
                             crit("C2", "BLOCKED"),
                             findings=[Finding(severity="major", title="crash", description="boom")],
                             evidence=[Evidence(id="E001", label="login", s3_uri="s3://ev/runs/42-1/bad/E001-login.png",
                                                local_path="/w/reports/evidence/bad/E001-login.png",
                                                captured_at="t")]),
                      result("boom", "ERROR", error="TimeoutError: desktop not ready"),
                  ])
    r.totals = totals(r)
    return r


def test_totals_count_scenarios_criteria_and_findings(report):
    assert report.totals == {"scenarios": 3, "passed": 1, "failed": 1, "errored": 1, "criteria_pass": 1,
                             "criteria_fail": 1, "criteria_blocked": 1, "criteria_not_run": 0, "findings": 1}


def test_junit_marks_non_passing_criteria_and_errored_scenarios(report, tmp_path):
    write_all(report, tmp_path)

    root = ET.parse(tmp_path / "junit.xml").getroot()
    suites = {s.get("name").split(":")[0]: s for s in root}
    assert suites["ok"].get("failures") == "0"
    assert suites["bad"].get("failures") == "2"
    assert suites["boom"].get("errors") == "1"
    assert suites["boom"].find("testcase/error").text == "TimeoutError: desktop not ready"


def test_the_summary_keeps_its_table_intact(report, tmp_path):
    write_all(report, tmp_path)

    md = (tmp_path / "summary.md").read_text()
    assert md.startswith("## Desktop UAT ❌ FAIL")
    assert "pipe \\| in text" in md
    assert "**major** crash" in md
    for line in md.splitlines():
        if line.startswith("| "):
            assert line.count(" | ") == 3, line


def test_report_json_round_trips(report, tmp_path):
    write_all(report, tmp_path)

    assert RunReport.model_validate_json((tmp_path / "report.json").read_text()) == report


def test_evidence_is_cited_by_its_path_in_the_report_artifact(report, tmp_path):
    """A browser cannot open s3://. The screenshots are in the job artifact under evidence/."""
    write_all(report, tmp_path)

    md = (tmp_path / "summary.md").read_text()
    assert "`E001` `evidence/bad/E001-login.png`" in md
    assert "s3://ev/runs/42-1/bad/E001-login.png" not in md.split("### ")[1]  # not as a link per criterion
    assert "`s3://ev/runs/42-1/`" in md  # the audit copy is named once


def test_a_report_without_evidence_names_no_bucket(tmp_path):
    r = RunReport(run_id="1", git_ref="", git_sha="", build=BuildRef(s3_uri="s3://b/k", sha256=SHA, name="n"),
                  model_id="m", started_at="t", ended_at="t", status="PASS", totals={}, scenarios=[])
    r.totals = totals(r)
    write_all(r, tmp_path)

    assert "s3://" not in (tmp_path / "summary.md").read_text()


# ----------------------------------------------------------------- annotations
def test_every_non_passing_criterion_is_an_error_annotation(report):
    errors = [a for a in workflow_annotations(report) if a.startswith("::error ")]

    assert "::error title=UAT bad C1 FAIL::desc C1: pipe | in%0Atext (agent; evidence E001)" in errors
    assert "::error title=UAT bad C2 BLOCKED::desc C2: obs (agent; no evidence)" in errors
    assert not any("ok" in e.split("::")[1] for e in errors)


def test_an_errored_scenario_is_one_error_annotation(report):
    assert "::error title=UAT boom ERROR::TimeoutError: desktop not ready" in workflow_annotations(report)


@pytest.mark.parametrize("severity, level", [("critical", "warning"), ("major", "warning"),
                                             ("minor", "notice"), ("cosmetic", "notice")])
def test_findings_are_warnings_or_notices_by_severity(report, severity, level):
    report.scenarios[1].findings = [Finding(severity=severity, title="t", description="d", evidence=["E001"])]

    found = [a for a in workflow_annotations(report) if "finding" in a]

    assert found == [f"::{level} title=UAT bad finding ({severity})::t: d (evidence E001)"]


def test_errors_come_first_so_the_per_step_cap_keeps_them():
    """GitHub shows at most 10 annotations of each level per step."""
    r = RunReport(run_id="1", git_ref="", git_sha="", build=BuildRef(s3_uri="s3://b/k", sha256=SHA, name="n"),
                  model_id="m", started_at="t", ended_at="t", status="FAIL", totals={}, scenarios=[
                      result("s", "FAIL", crit("C1", "FAIL"),
                             findings=[Finding(severity="minor", title="t", description="d")])])

    levels = [a.split(" ", 1)[0] for a in workflow_annotations(r)]

    assert levels == ["::error", "::notice"]


def test_annotation_text_cannot_break_out_of_the_workflow_command():
    """Observations come from the LLM. A newline must not start a new ::command::."""
    r = RunReport(run_id="1", git_ref="", git_sha="", build=BuildRef(s3_uri="s3://b/k", sha256=SHA, name="n"),
                  model_id="m", started_at="t", ended_at="t", status="FAIL", totals={}, scenarios=[
                      result("s", "FAIL", crit("C1:x,y", "FAIL", observation="50%\r\n::add-mask::secret"))])

    [line] = workflow_annotations(r)

    assert "\n" not in line and "\r" not in line
    assert line == "::error title=UAT s C1%3Ax%2Cy FAIL::desc C1:x,y: 50%25%0D%0A::add-mask::secret (agent; no evidence)"


def test_a_passing_run_annotates_nothing(report):
    report.scenarios = report.scenarios[:1]

    assert workflow_annotations(report) == []


# ----------------------------------------------------------------- walkthrough mode and report.html
@pytest.fixture
def walkthrough_report(tmp_path):
    shot = tmp_path / "evidence" / "smoke" / "E001-dashboard.png"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(b"\x89PNG walkthrough")
    r = RunReport(run_id="7", git_ref="", git_sha="", build=BuildRef(sha256=SHA, name="uat-demo-1.4.0.zip"),
                  model_id="", mode="walkthrough", started_at="t", ended_at="t", status="PASS", totals={},
                  scenarios=[result("smoke", "PASS",
                                    crit("C1", "NOT_RUN", observation="Not judged <b>in walkthrough</b>",
                                         evidence=["E001"], source="harness"),
                                    evidence=[Evidence(id="E001", label="dashboard & more", s3_uri=None,
                                                       local_path=str(shot), captured_at="t")])])
    r.totals = totals(r)
    return r


def test_a_walkthrough_summary_says_visual_criteria_await_review(walkthrough_report, tmp_path):
    write_all(walkthrough_report, tmp_path)

    md = (tmp_path / "summary.md").read_text()
    assert md.startswith("## Desktop UAT ✅ PASS · walkthrough (no agent)")
    assert "Visual criteria are not judged in walkthrough mode" in md
    assert "s3://" not in md


def test_a_walkthrough_summary_lists_each_screenshot_once_as_a_table(walkthrough_report, tmp_path):
    """Every unjudged visual criterion cites every screenshot; repeating the list per criterion
    buries the summary. The criteria point at one table instead."""
    write_all(walkthrough_report, tmp_path)

    md = (tmp_path / "summary.md").read_text()
    assert md.count("evidence/smoke/E001-dashboard.png") == 1
    assert "| `E001` | dashboard & more | `evidence/smoke/E001-dashboard.png` |" in md
    assert "**C1** (harness) awaits review against the screenshots below" in md


def test_in_walkthrough_mode_unjudged_visual_criteria_are_notices_not_errors(walkthrough_report):
    assert workflow_annotations(walkthrough_report) == [
        "::notice title=UAT smoke C1 awaits review::desc C1: Not judged <b>in walkthrough</b> (harness; evidence E001)"]


def test_report_html_embeds_every_screenshot_and_escapes_text(walkthrough_report, tmp_path):
    write_all(walkthrough_report, tmp_path)

    html = (tmp_path / "report.html").read_text()
    import base64
    encoded = base64.b64encode(b"\x89PNG walkthrough").decode()
    assert f'src="data:image/png;base64,{encoded}"' in html
    assert "dashboard &amp; more" in html
    assert "Not judged &lt;b&gt;in walkthrough&lt;/b&gt;" in html
    assert "<b>in walkthrough</b>" not in html


def test_report_html_survives_a_missing_screenshot(report, tmp_path):
    write_all(report, tmp_path)  # its E001 points at a path that does not exist

    html = (tmp_path / "report.html").read_text()
    assert "E001" in html and "missing" in html


def test_report_html_needs_nothing_from_the_network(walkthrough_report, tmp_path):
    """It is opened from an unzipped artifact, possibly offline."""
    write_all(walkthrough_report, tmp_path)

    html = (tmp_path / "report.html").read_text()
    assert "http://" not in html and "https://" not in html
