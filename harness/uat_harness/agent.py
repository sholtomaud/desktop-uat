"""LLM-driven visual/exploratory testing with a forced structured verdict."""
from __future__ import annotations

import json
import logging
from importlib import resources
from typing import Optional

from botocore.config import Config
from pydantic import ValidationError
from strands import Agent, tool
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.models.bedrock import BedrockModel

from .config import HarnessConfig
from .evidence import EvidenceRecorder
from .models import AgentVerdict, Scenario
from .session import DesktopSession

log = logging.getLogger(__name__)

# Harness-only tools the LLM must never call.
AGENT_DENYLIST = ("install_build", "reset_app_state", "launch_app")

VERDICT_SCHEMA_HINT = json.dumps({
    "summary": "2-5 sentences on what you tested and the overall impression",
    "criteria": [{"criterion_id": "C1", "status": "PASS|FAIL|BLOCKED",
                  "observation": "what you actually saw", "evidence": ["E002"]}],
    "findings": [{"severity": "critical|major|minor|cosmetic", "title": "short",
                  "description": "steps + what happened", "evidence": ["E003"]}],
}, indent=1)


def _system_prompt() -> str:
    return resources.files(__package__).joinpath("prompts/system.md").read_text(encoding="utf-8")


def _task_prompt(s: Scenario) -> str:
    visual = [c for c in s.criteria if c.kind == "visual"]
    deterministic = [c for c in s.criteria if c.kind == "deterministic"]
    lines = [f"# Scenario {s.id}: {s.title}", "", "## Instructions", s.instructions.strip(), ""]
    lines.append("## Acceptance criteria you must judge (visual)")
    lines += [f"- {c.id}: {c.description}" for c in visual] or ["- (none - exploration only)"]
    if deterministic:
        lines += ["", "## Checked separately by automation (do not spend effort verifying)"]
        lines += [f"- {c.id}: {c.description}" for c in deterministic]
    lines += ["", "## Exploration", "Report additional findings." if s.explore else "Do not explore beyond the instructions."]
    return "\n".join(lines)


def run_agent(session: DesktopSession, recorder: EvidenceRecorder, scenario: Scenario,
              cfg: HarnessConfig) -> Optional[AgentVerdict]:
    visual_ids = {c.id for c in scenario.criteria if c.kind == "visual"}
    accepted: dict[str, AgentVerdict] = {}

    @tool
    def capture_evidence(label: str) -> str:
        """Take a screenshot of the desktop and store it as test evidence.

        Args:
            label: Short description of what this screenshot proves, e.g. "dashboard after login".

        Returns:
            The evidence id (e.g. E004) to cite in submit_verdict.
        """
        ev = recorder.capture(label)
        return f"{ev.id} stored: {ev.label}"

    @tool
    def submit_verdict(verdict_json: str) -> str:
        """Submit the final structured test verdict. Call exactly once, at the end.

        Args:
            verdict_json: A JSON object with keys summary, criteria and findings, e.g.
                {"summary": "...", "criteria": [{"criterion_id": "C1", "status": "PASS",
                "observation": "...", "evidence": ["E002"]}], "findings": [{"severity": "minor",
                "title": "...", "description": "...", "evidence": ["E003"]}]}.
                Status is PASS, FAIL or BLOCKED. Every listed visual criterion must appear once.

        Returns:
            ACCEPTED, or REJECTED with the problems to fix.
        """
        try:
            v = AgentVerdict.model_validate_json(verdict_json)
        except ValidationError as e:
            return f"REJECTED: invalid JSON/schema: {e}. Expected shape: {VERDICT_SCHEMA_HINT}"
        problems = []
        got = [c.criterion_id for c in v.criteria]
        if missing := visual_ids - set(got):
            problems.append(f"missing criteria {sorted(missing)}")
        if unknown := set(got) - visual_ids:
            problems.append(f"unknown criteria {sorted(unknown)} (only judge visual criteria)")
        if len(got) != len(set(got)):
            problems.append("duplicate criterion ids")
        known = recorder.ids()
        for c in v.criteria:
            if c.status in ("PASS", "FAIL") and not c.evidence:
                problems.append(f"{c.criterion_id}: {c.status} requires evidence")
            if bad := set(c.evidence) - known:
                problems.append(f"{c.criterion_id}: unknown evidence ids {sorted(bad)}")
        for f in v.findings:
            if bad := set(f.evidence) - known:
                problems.append(f"finding '{f.title}': unknown evidence ids {sorted(bad)}")
        if problems:
            return "REJECTED: " + "; ".join(problems)
        accepted["v"] = v
        return "ACCEPTED. Stop now."

    model = BedrockModel(
        model_id=cfg.model_id,
        region_name=cfg.region,
        temperature=0.0,
        max_tokens=4096,
        boto_client_config=Config(retries={"max_attempts": 8, "mode": "adaptive"}, read_timeout=300),
    )
    agent = Agent(
        model=model,
        system_prompt=_system_prompt(),
        tools=session.agent_tools(AGENT_DENYLIST) + [capture_evidence, submit_verdict],
        conversation_manager=SlidingWindowConversationManager(window_size=40),
        callback_handler=None,
    )

    agent(_task_prompt(scenario))
    for _ in range(2):
        if "v" in accepted:
            break
        log.warning("agent ended without an accepted verdict; nudging")
        agent("You have not submitted an accepted verdict. Call submit_verdict now. "
              "Use BLOCKED for anything you could not verify, citing evidence where you have it.")
    return accepted.get("v")
