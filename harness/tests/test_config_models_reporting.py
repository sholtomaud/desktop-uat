"""HarnessConfig discovery, the scenario model's rules, and the three report formats."""
import xml.etree.ElementTree as ET

import pytest
from pydantic import ValidationError

from support import SHA, FakeSsm, scenario
from uat_harness import config as config_mod
from uat_harness.config import HarnessConfig
from uat_harness.models import (BuildRef, CriterionResult, Evidence, Finding, RunReport,
                                ScenarioResult)
from uat_harness.reporting import totals, write_all

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
                           source="agent", observation=kw.pop("observation", "obs"), **kw)


@pytest.fixture
def report():
    r = RunReport(run_id="42-1", git_ref="r", git_sha="s", build=BuildRef(s3_uri="s3://b/k", sha256=SHA, name="App.msi"),
                  model_id="m", started_at="t", ended_at="t", status="FAIL", totals={}, scenarios=[
                      result("ok", "PASS", crit("C1", "PASS")),
                      result("bad", "FAIL", crit("C1", "FAIL", observation="pipe | in\ntext", evidence=["E001"]),
                             crit("C2", "BLOCKED"),
                             findings=[Finding(severity="major", title="crash", description="boom")],
                             evidence=[Evidence(id="E001", label="l", s3_uri="s3://e/E001.png",
                                                local_path="p", captured_at="t")]),
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


def test_the_summary_links_evidence_and_keeps_its_table_intact(report, tmp_path):
    write_all(report, tmp_path)

    md = (tmp_path / "summary.md").read_text()
    assert md.startswith("## Desktop UAT ❌ FAIL")
    assert "[E001](s3://e/E001.png)" in md
    assert "pipe \\| in text" in md
    assert "**major** crash" in md
    for line in md.splitlines():
        if line.startswith("| "):
            assert line.count(" | ") == 3, line


def test_report_json_round_trips(report, tmp_path):
    write_all(report, tmp_path)

    assert RunReport.model_validate_json((tmp_path / "report.json").read_text()) == report
