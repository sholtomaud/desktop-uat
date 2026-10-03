"""Run one scenario end to end in its own desktop session."""
from __future__ import annotations

import hashlib
import logging
import re
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import boto3
from botocore.config import Config

from .agent import run_agent
from .config import HarnessConfig
from .evidence import EvidenceRecorder
from .models import (AgentVerdict, Criterion, CriterionResult, RunContext, Scenario,
                     ScenarioResult)
from .session import DesktopSession, ToolError

log = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def session_user_id(run_id: str, scenario_id: str) -> str:
    """CreateStreamingURL UserId: 2-32 chars of [\\w+=,.@-]. Unique per run + scenario."""
    run = re.sub(r"[^0-9A-Za-z-]", "", run_id)[-14:]
    h = hashlib.sha1(scenario_id.encode()).hexdigest()[:8]
    return f"uat-{run}-{h}"[:32]


def presign(cfg: HarnessConfig, s3_uri: str) -> str:
    """Virtual-hosted regional URL so the desktop resolves it via the S3 gateway endpoint."""
    u = urlparse(s3_uri)
    s3 = boto3.client(
        "s3", region_name=cfg.region, endpoint_url=f"https://s3.{cfg.region}.amazonaws.com",
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
    )
    return s3.generate_presigned_url(
        "get_object", Params={"Bucket": u.netloc, "Key": u.path.lstrip("/")}, ExpiresIn=cfg.presign_ttl
    )


def _publish_observer_link(cfg: HarnessConfig, ctx: RunContext, scenario: Scenario, user_id: str) -> None:
    """VIEW_STOP: give humans a way to watch/stop the agent without putting the URL in CI logs."""
    url = boto3.client("appstream", region_name=cfg.region).create_streaming_url(
        StackName=cfg.stack_name, FleetName=cfg.fleet_name, UserId=user_id, Validity=1800
    )["StreamingURL"]
    name = f"{cfg.ssm_prefix}/observe/{session_user_id(ctx.run_id, scenario.id)}"
    boto3.client("ssm", region_name=cfg.region).put_parameter(
        Name=name, Value=url, Type="SecureString", Overwrite=True, Tier="Advanced"
    )
    print(f"::notice title=Observe {scenario.id}::aws ssm get-parameter --with-decryption "
          f"--name {name} --query Parameter.Value --output text", flush=True)


def _run_deterministic(session: DesktopSession, c: Criterion) -> CriterionResult:
    assert c.assertion is not None
    base = dict(criterion_id=c.id, description=c.description, kind="deterministic", source="deterministic")
    try:
        r = session.call_json(c.assertion.tool, c.assertion.arguments)
    except ToolError as e:
        return CriterionResult(**base, status="FAIL", observation=f"assertion tool error: {e}")
    passed = bool(r.get("pass"))
    return CriterionResult(
        **base, status="PASS" if passed else "FAIL",
        observation=str(r.get("message", "")), actual=None if r.get("actual") is None else str(r.get("actual")),
    )


def _merge(scenario: Scenario, verdict: AgentVerdict | None,
           deterministic: dict[str, CriterionResult]) -> list[CriterionResult]:
    by_id = {c.criterion_id: c for c in verdict.criteria} if verdict else {}
    out: list[CriterionResult] = []
    for c in scenario.criteria:
        if c.kind == "deterministic":
            out.append(deterministic[c.id])
            continue
        v = by_id.get(c.id)
        if v is None:
            out.append(CriterionResult(criterion_id=c.id, description=c.description, kind="visual",
                                       status="NOT_RUN", source="harness",
                                       observation="agent produced no accepted verdict for this criterion"))
        else:
            out.append(CriterionResult(criterion_id=c.id, description=c.description, kind="visual",
                                       status=v.status, source="agent", observation=v.observation,
                                       evidence=v.evidence))
    return out


def run_scenario(scenario: Scenario, cfg: HarnessConfig, ctx: RunContext) -> ScenarioResult:
    user_id = session_user_id(ctx.run_id, scenario.id)
    started, t0 = _now(), time.monotonic()
    result = ScenarioResult(scenario_id=scenario.id, title=scenario.title, status="ERROR",
                            started_at=started, ended_at=started, duration_seconds=0,
                            session_user_id=user_id)
    recorder: EvidenceRecorder | None = None
    try:
        with DesktopSession(cfg, user_id) as session:
            if ctx.observe:
                try:
                    _publish_observer_link(cfg, ctx, scenario, user_id)
                except Exception as e:  # observing is best-effort
                    log.warning("could not publish observer link: %s", e)

            recorder = EvidenceRecorder(
                session, boto3.client("s3", region_name=cfg.region), cfg.evidence_bucket,
                f"runs/{ctx.run_id}/{scenario.id}", Path(ctx.out_dir) / "evidence" / scenario.id,
            )

            # Deterministic setup: the LLM is not involved and cannot call these tools.
            install_args = {"url": presign(cfg, ctx.build.s3_uri), "sha256": ctx.build.sha256}
            if scenario.installer_args:
                install_args["installerArgs"] = scenario.installer_args
            session.call_ok("install_build", install_args)
            for step in scenario.setup:
                session.call_ok(step.tool, step.arguments)
            session.call_ok("launch_app", {
                "executablePath": scenario.launch.executable,
                "arguments": scenario.launch.arguments,
                "mainWindowTimeoutSeconds": scenario.launch.main_window_timeout_seconds,
            })
            recorder.capture("app launched")

            verdict = run_agent(session, recorder, scenario, cfg)

            # Exact assertions run after the agent, against the state it left behind.
            det = {c.id: _run_deterministic(session, c) for c in scenario.criteria if c.kind == "deterministic"}
            recorder.capture("final state")

            result.criteria = _merge(scenario, verdict, det)
            if verdict:
                result.findings = verdict.findings
                result.agent_summary = verdict.summary
            ok = all(c.status == "PASS" for c in result.criteria)
            result.status = "PASS" if ok else "FAIL"
    except Exception as e:
        log.error("scenario %s errored: %s", scenario.id, e)
        result.status = "ERROR"
        result.error = f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=5)}"[:8000]
    finally:
        if recorder:
            result.evidence = recorder.items
        result.ended_at = _now()
        result.duration_seconds = round(time.monotonic() - t0, 1)
    return result
