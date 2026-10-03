"""CLI: validate scenarios, run a suite (one subprocess per scenario), emit schema."""
from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .config import HarnessConfig
from .models import BuildRef, RunContext, RunReport, Scenario, ScenarioResult
from .reporting import schema_json, totals, write_all

# Generous allowance on top of the scenario timeout for desktop provisioning + install.
PROVISION_ALLOWANCE = 900


def load_scenarios(directory: Path, tags: set[str]) -> list[tuple[Path, Scenario]]:
    out = []
    for f in sorted(directory.glob("*.y*ml")):
        s = Scenario.model_validate(yaml.safe_load(f.read_text(encoding="utf-8")))
        if not tags or tags & set(s.tags):
            out.append((f, s))
    ids = [s.id for _, s in out]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate scenario ids")
    return out


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def cmd_validate(a) -> int:
    scenarios = load_scenarios(Path(a.scenarios), set())
    print(f"{len(scenarios)} scenario(s) valid")
    return 0


def cmd_schema(a) -> int:
    Path(a.out).write_text(schema_json(), encoding="utf-8")
    return 0


def cmd_scenario(a) -> int:
    """Internal: run exactly one scenario in this process (killed by the parent on timeout)."""
    from .runner import run_scenario
    cfg = HarnessConfig.from_ssm(a.ssm_prefix)
    ctx = RunContext.model_validate_json(Path(a.context).read_text())
    scenario = Scenario.model_validate(yaml.safe_load(Path(a.scenario_file).read_text(encoding="utf-8")))
    result = run_scenario(scenario, cfg, ctx)
    Path(a.result).write_text(result.model_dump_json(indent=2), encoding="utf-8")
    return 0


def _spawn(path: Path, s: Scenario, ctx_file: Path, out: Path, prefix: str) -> ScenarioResult:
    result_file = out / "results" / f"{s.id}.json"
    result_file.parent.mkdir(parents=True, exist_ok=True)
    log_file = out / "logs" / f"{s.id}.log"
    log_file.parent.mkdir(parents=True, exist_ok=True)
    started = _now()
    cmd = [sys.executable, "-m", "uat_harness.cli", "scenario", "--scenario-file", str(path),
           "--context", str(ctx_file), "--result", str(result_file), "--ssm-prefix", prefix]
    err = None
    with log_file.open("w") as log:
        try:
            # The session ends when this process dies, so a hung agent cannot hold a desktop.
            subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, timeout=s.timeout_seconds + PROVISION_ALLOWANCE,
                           check=False, env=os.environ.copy())
        except subprocess.TimeoutExpired:
            err = f"scenario exceeded {s.timeout_seconds + PROVISION_ALLOWANCE}s and was killed"
    if err is None and result_file.exists():
        return ScenarioResult.model_validate_json(result_file.read_text())
    return ScenarioResult(scenario_id=s.id, title=s.title, status="ERROR", started_at=started, ended_at=_now(),
                          duration_seconds=0, session_user_id="",
                          error=err or f"no result produced; see logs/{s.id}.log")


def cmd_run(a) -> int:
    cfg = HarnessConfig.from_ssm(a.ssm_prefix)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    tags = {t.strip() for t in a.tags.split(",") if t.strip()}
    scenarios = load_scenarios(Path(a.scenarios), tags)
    if not scenarios:
        print("no scenarios matched", file=sys.stderr)
        return 2

    ctx = RunContext(
        run_id=a.run_id, git_ref=a.git_ref, git_sha=a.git_sha, observe=a.observe, out_dir=str(out.resolve()),
        build=BuildRef(s3_uri=a.build_s3_uri, sha256=a.build_sha256, name=a.build_name,
                       artifactory_uri=a.artifactory_uri or None),
    )
    ctx_file = out / "context.json"
    ctx_file.write_text(ctx.model_dump_json())

    workers = max(1, min(a.parallelism or cfg.max_concurrent, cfg.max_concurrent))
    print(f"running {len(scenarios)} scenario(s), {workers} in parallel, model {cfg.model_id}", flush=True)
    started = _now()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda ps: _spawn(ps[0], ps[1], ctx_file, out, a.ssm_prefix), scenarios))

    report = RunReport(run_id=a.run_id, git_ref=a.git_ref, git_sha=a.git_sha, build=ctx.build,
                       model_id=cfg.model_id, started_at=started, ended_at=_now(),
                       status="PASS" if all(r.status == "PASS" for r in results) else "FAIL",
                       totals={}, scenarios=results)
    report.totals = totals(report)
    write_all(report, out)

    # Mirror the report next to the screenshots for audit.
    import boto3
    s3 = boto3.client("s3", region_name=cfg.region)
    for name in ("report.json", "junit.xml", "summary.md"):
        s3.upload_file(str(out / name), cfg.evidence_bucket, f"runs/{a.run_id}/{name}")

    print(json.dumps(report.totals), flush=True)
    return 0 if report.status == "PASS" else 1


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=os.environ.get("UAT_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser(prog="uat_harness")
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("validate"); v.add_argument("--scenarios", required=True); v.set_defaults(fn=cmd_validate)
    sc = sub.add_parser("schema"); sc.add_argument("--out", required=True); sc.set_defaults(fn=cmd_schema)

    r = sub.add_parser("run")
    r.add_argument("--ssm-prefix", required=True)
    r.add_argument("--scenarios", required=True)
    r.add_argument("--tags", default="")
    r.add_argument("--build-s3-uri", required=True)
    r.add_argument("--build-sha256", required=True)
    r.add_argument("--build-name", required=True)
    r.add_argument("--artifactory-uri", default="")
    r.add_argument("--run-id", required=True)
    r.add_argument("--git-ref", default="")
    r.add_argument("--git-sha", default="")
    r.add_argument("--parallelism", type=int, default=0)
    r.add_argument("--observe", action="store_true")
    r.add_argument("--out", default="reports")
    r.set_defaults(fn=cmd_run)

    one = sub.add_parser("scenario")
    one.add_argument("--ssm-prefix", required=True)
    one.add_argument("--scenario-file", required=True)
    one.add_argument("--context", required=True)
    one.add_argument("--result", required=True)
    one.set_defaults(fn=cmd_scenario)

    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
