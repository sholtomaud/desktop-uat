"""The CLI: scenario loading, the per-scenario subprocess, and the run's report and exit code."""
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from support import SHA
from uat_harness import cli
from uat_harness.models import ScenarioResult
from uat_harness.reporting import schema_json

HARNESS = Path(__file__).resolve().parent.parent


def write_scenario(d: Path, sid: str, tags=("smoke",)):
    (d / f"{sid}.yaml").write_text(yaml.safe_dump({
        "id": sid, "title": sid, "tags": list(tags), "launch": {"executable": "a.exe"},
        "instructions": "i", "criteria": [{"id": "C1", "kind": "visual", "description": "d"}],
    }))


def test_the_committed_scenarios_are_valid():
    assert cli.main(["validate", "--scenarios", str(HARNESS / "scenarios")]) == 0


def test_the_committed_report_schema_matches_the_models(tmp_path):
    """harness/report.schema.json is what consumers code against; it must not drift."""
    assert (HARNESS / "report.schema.json").read_text() == schema_json()
    cli.main(["schema", "--out", str(tmp_path / "s.json")])
    assert (tmp_path / "s.json").read_text() == schema_json()


def test_tags_select_scenarios(tmp_path):
    write_scenario(tmp_path, "a", ["smoke"])
    write_scenario(tmp_path, "b", ["release"])
    write_scenario(tmp_path, "c", ["smoke", "release"])

    ids = lambda tags: [s.id for _, s in cli.load_scenarios(tmp_path, tags)]  # noqa: E731

    assert ids(set()) == ["a", "b", "c"]
    assert ids({"smoke"}) == ["a", "c"]
    assert ids({"nightly"}) == []


def test_duplicate_scenario_ids_are_refused(tmp_path):
    write_scenario(tmp_path, "a")
    (tmp_path / "copy.yml").write_text((tmp_path / "a.yaml").read_text())

    with pytest.raises(SystemExit, match="duplicate"):
        cli.load_scenarios(tmp_path, set())


def test_an_invalid_scenario_fails_validation(tmp_path):
    (tmp_path / "bad.yaml").write_text("id: bad\ntitle: t\n")

    with pytest.raises(Exception):
        cli.main(["validate", "--scenarios", str(tmp_path)])


# ----------------------------------------------------------------- one scenario per process
def spawn(tmp_path, monkeypatch, behaviour):
    write_scenario(tmp_path, "s")
    [(path, sc)] = cli.load_scenarios(tmp_path, set())
    monkeypatch.setattr(cli.subprocess, "run", behaviour)
    return cli._spawn(path, sc, tmp_path / "ctx.json", tmp_path / "out", "/p")


def test_a_scenario_runs_in_its_own_process_with_a_hard_timeout(tmp_path, monkeypatch):
    seen = {}

    def fake_run(cmd, **kw):
        seen.update(cmd=cmd, **kw)
        result = cmd[cmd.index("--result") + 1]
        Path(result).write_text(ScenarioResult(scenario_id="s", title="s", status="PASS", started_at="t",
                                               ended_at="t", duration_seconds=1,
                                               session_user_id="u").model_dump_json())

    r = spawn(tmp_path, monkeypatch, fake_run)

    assert r.status == "PASS"
    assert seen["cmd"][:4] == [sys.executable, "-m", "uat_harness.cli", "scenario"]
    assert seen["timeout"] == 1500 + cli.PROVISION_ALLOWANCE


def test_a_scenario_that_overruns_is_killed_and_reported_as_an_error(tmp_path, monkeypatch):
    def hang(cmd, timeout, **kw):
        raise subprocess.TimeoutExpired(cmd, timeout)

    r = spawn(tmp_path, monkeypatch, hang)

    assert r.status == "ERROR"
    assert "was killed" in r.error


def test_a_scenario_process_that_dies_without_a_result_is_an_error(tmp_path, monkeypatch):
    r = spawn(tmp_path, monkeypatch, lambda cmd, **kw: None)

    assert r.status == "ERROR"
    assert "logs/s.log" in r.error


# ----------------------------------------------------------------- the whole run
@pytest.fixture
def run(tmp_path, cfg, boto, monkeypatch):
    sdir = tmp_path / "scenarios"
    sdir.mkdir()
    for sid in ("a", "b", "c"):
        write_scenario(sdir, sid)
    monkeypatch.setattr(cli.HarnessConfig, "from_ssm", classmethod(lambda c, prefix: cfg))
    import boto3
    monkeypatch.setattr(boto3, "client", boto.client)
    statuses = {}
    workers = []

    def fake_spawn(path, s, ctx_file, out, prefix):
        return ScenarioResult(scenario_id=s.id, title=s.title, status=statuses.get(s.id, "PASS"),
                              started_at="t", ended_at="t", duration_seconds=1, session_user_id="u")
    monkeypatch.setattr(cli, "_spawn", fake_spawn)

    real_pool = cli.ThreadPoolExecutor
    def pool(max_workers):  # noqa: E306
        workers.append(max_workers)
        return real_pool(max_workers=max_workers)
    monkeypatch.setattr(cli, "ThreadPoolExecutor", pool)

    def _run(*extra, **status):
        statuses.update(status)
        out = tmp_path / "reports"
        rc = cli.main(["run", "--ssm-prefix", "/p", "--scenarios", str(sdir), "--build-s3-uri", "s3://b/k",
                       "--build-sha256", SHA, "--build-name", "App.msi", "--run-id", "42-1",
                       "--out", str(out), *extra])
        return rc, out
    _run.workers = workers
    return _run


def test_a_passing_run_exits_zero_and_writes_every_report(run):
    rc, out = run()

    assert rc == 0
    assert {"report.json", "junit.xml", "summary.md", "context.json"} <= {p.name for p in out.iterdir()}


def test_one_failing_scenario_fails_the_run(run):
    rc, out = run(b="FAIL")

    assert rc == 1
    assert '"status": "FAIL"' in (out / "report.json").read_text()


def test_an_errored_scenario_fails_the_run(run):
    assert run(c="ERROR")[0] == 1


def test_no_matching_scenarios_is_its_own_exit_code(run):
    assert run("--tags", "nightly")[0] == 2


def test_the_report_is_mirrored_to_the_evidence_bucket(run, boto):
    run()

    assert sorted(k for _, _, k in boto.s3.uploads) == [
        "runs/42-1/junit.xml", "runs/42-1/report.json", "runs/42-1/summary.md"]
    assert {b for _, b, _ in boto.s3.uploads} == {"evidence"}


def test_parallelism_never_exceeds_the_fleet_capacity(run):
    run("--parallelism", "50")
    run("--parallelism", "1")
    run()

    assert run.workers == [2, 1, 2]


def test_under_github_actions_the_run_prints_annotations(run, capsys, monkeypatch):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")

    run(c="ERROR")

    out = capsys.readouterr().out.splitlines()
    assert "::error title=UAT c ERROR::scenario errored without a message; see logs/c.log" in out


def test_outside_github_actions_no_workflow_commands_are_printed(run, capsys, monkeypatch):
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)

    run(b="FAIL")

    assert "::" not in capsys.readouterr().out
