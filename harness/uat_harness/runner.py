"""Run one scenario end to end in its own desktop session."""
from __future__ import annotations

import hashlib
import logging
import re
import time
import traceback
from contextlib import AbstractContextManager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Protocol
from urllib.parse import urlparse

import boto3
from botocore.config import Config

from .agent import run_agent
from .config import HarnessConfig
from .evidence import EvidenceRecorder
from .models import (AgentVerdict, BuildRef, Criterion, CriterionResult, RunContext, RunMode,
                     Scenario, ScenarioResult)
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


AWAITS_REVIEW = ("Not judged: walkthrough mode has no agent. Review the screenshots cited here "
                 "against the criterion.")


def _merge(scenario: Scenario, verdict: AgentVerdict | None, deterministic: dict[str, CriterionResult],
           mode: RunMode = "agent", evidence_ids: Optional[list[str]] = None) -> list[CriterionResult]:
    by_id = {c.criterion_id: c for c in verdict.criteria} if verdict else {}
    out: list[CriterionResult] = []
    for c in scenario.criteria:
        if c.kind == "deterministic":
            out.append(deterministic[c.id])
            continue
        v = by_id.get(c.id)
        if v is None and mode == "walkthrough":
            out.append(CriterionResult(criterion_id=c.id, description=c.description, kind="visual",
                                       status="NOT_RUN", source="harness", observation=AWAITS_REVIEW,
                                       evidence=list(evidence_ids or [])))
        elif v is None:
            out.append(CriterionResult(criterion_id=c.id, description=c.description, kind="visual",
                                       status="NOT_RUN", source="harness",
                                       observation="agent produced no accepted verdict for this criterion"))
        else:
            out.append(CriterionResult(criterion_id=c.id, description=c.description, kind="visual",
                                       status=v.status, source="agent", observation=v.observation,
                                       evidence=v.evidence))
    return out


def scenario_passed(criteria: list[CriterionResult], mode: RunMode) -> bool:
    """In walkthrough mode an unjudged visual criterion is pending review, not a failure."""
    return all(c.status == "PASS" or (mode == "walkthrough" and c.kind == "visual" and c.status == "NOT_RUN")
               for c in criteria)


def run_walkthrough(session: DesktopSession, recorder: EvidenceRecorder, scenario: Scenario) -> None:
    for step in scenario.walkthrough:
        session.call_ok(step.tool, step.arguments)
        if step.capture:
            recorder.capture(step.capture)


# ----------------------------------------------------------------- where a scenario runs
class Backend(Protocol):
    """What differs between a run on AWS and one on a local Windows machine."""
    mode: RunMode

    def session(self, user_id: str) -> AbstractContextManager[DesktopSession]: ...
    def build_url(self, build: BuildRef) -> str: ...
    def recorder(self, session: DesktopSession, run_id: str, scenario_id: str, local_dir: Path) -> EvidenceRecorder: ...
    def session_opened(self, ctx: RunContext, scenario: Scenario, user_id: str) -> None: ...
    def drive(self, session: DesktopSession, recorder: EvidenceRecorder, scenario: Scenario) -> AgentVerdict | None: ...


class AwsBackend:
    """WorkSpaces agent access, S3 evidence, a presigned build, the Bedrock agent."""
    mode: RunMode = "agent"

    def __init__(self, cfg: HarnessConfig):
        self.cfg = cfg

    def session(self, user_id):
        return DesktopSession(self.cfg, user_id)

    def build_url(self, build):
        return presign(self.cfg, build.s3_uri)

    def recorder(self, session, run_id, scenario_id, local_dir):
        return EvidenceRecorder(session, boto3.client("s3", region_name=self.cfg.region), self.cfg.evidence_bucket,
                                f"runs/{run_id}/{scenario_id}", local_dir)

    def session_opened(self, ctx, scenario, user_id):
        if ctx.observe:
            try:
                _publish_observer_link(self.cfg, ctx, scenario, user_id)
            except Exception as e:  # observing is best-effort
                log.warning("could not publish observer link: %s", e)

    def drive(self, session, recorder, scenario):
        return run_agent(session, recorder, scenario, self.cfg)


def run_scenario(scenario: Scenario, cfg: HarnessConfig, ctx: RunContext) -> ScenarioResult:
    return execute(scenario, ctx, AwsBackend(cfg))


def execute(scenario: Scenario, ctx: RunContext, backend: Backend) -> ScenarioResult:
    user_id = session_user_id(ctx.run_id, scenario.id)
    started, t0 = _now(), time.monotonic()
    result = ScenarioResult(scenario_id=scenario.id, title=scenario.title, status="ERROR",
                            started_at=started, ended_at=started, duration_seconds=0,
                            session_user_id=user_id)
    recorder: EvidenceRecorder | None = None
    try:
        with backend.session(user_id) as session:
            backend.session_opened(ctx, scenario, user_id)
            recorder = backend.recorder(session, ctx.run_id, scenario.id,
                                        Path(ctx.out_dir) / "evidence" / scenario.id)
            try:
                # Deterministic setup: nothing that drives the app can call these tools.
                install_args = {"url": backend.build_url(ctx.build), "sha256": ctx.build.sha256}
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

                verdict = backend.drive(session, recorder, scenario)

                # Exact assertions run afterwards, against the state the app was left in.
                det = {c.id: _run_deterministic(session, c) for c in scenario.criteria if c.kind == "deterministic"}
                recorder.capture("final state")
            except Exception:
                try:  # a picture of the moment it went wrong
                    recorder.capture("at error")
                except Exception:
                    pass
                raise

            result.criteria = _merge(scenario, verdict, det, backend.mode, [e.id for e in recorder.items])
            if verdict:
                result.findings = verdict.findings
                result.agent_summary = verdict.summary
            result.status = "PASS" if scenario_passed(result.criteria, backend.mode) else "FAIL"
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
