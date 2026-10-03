"""Scenario definitions and the structured verdict/report schema."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator

ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$"
CriterionStatus = Literal["PASS", "FAIL", "BLOCKED", "NOT_RUN"]
# Who drove the app: the LLM agent (on AWS), or the scenario's own walkthrough (no agent).
RunMode = Literal["agent", "walkthrough"]

# Setup tools: the harness calls these before anything drives the app. The agent is
# never given them, and a walkthrough may not call them.
HARNESS_ONLY_TOOLS = ("install_build", "reset_app_state", "launch_app")


# ----------------------------------------------------------------- scenario input
class ToolCall(BaseModel):
    """A call to a forwarded MCP tool (e.g. FlaUI) made by the harness, not the LLM."""
    tool: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class WalkStep(ToolCall):
    """One deterministic step of a walkthrough; `capture` takes a labelled screenshot after it."""
    capture: Optional[str] = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def _not_setup(self) -> "WalkStep":
        if self.tool in HARNESS_ONLY_TOOLS:
            raise ValueError(f"walkthrough step '{self.tool}' is harness-only; put it in setup or launch")
        return self


class Criterion(BaseModel):
    id: str = Field(pattern=ID_PATTERN)
    description: str
    kind: Literal["visual", "deterministic"]
    assertion: Optional[ToolCall] = None

    @model_validator(mode="after")
    def _assertion_matches_kind(self) -> "Criterion":
        if self.kind == "deterministic" and self.assertion is None:
            raise ValueError(f"criterion {self.id}: deterministic criteria need an assertion")
        if self.kind == "visual" and self.assertion is not None:
            raise ValueError(f"criterion {self.id}: visual criteria are judged by the agent; remove assertion")
        return self


class LaunchSpec(BaseModel):
    executable: str
    arguments: str = ""
    main_window_timeout_seconds: int = Field(default=90, ge=5, le=600)


class Scenario(BaseModel):
    id: str = Field(pattern=ID_PATTERN)
    title: str
    tags: list[str] = Field(default_factory=list)
    timeout_seconds: int = Field(default=1500, ge=120, le=7200)
    installer_args: Optional[str] = None
    setup: list[ToolCall] = Field(default_factory=list)
    launch: LaunchSpec
    instructions: str
    criteria: list[Criterion] = Field(min_length=1)
    explore: bool = True  # beta testing: also report issues outside the criteria
    # Drives the app when there is no agent (`uat_harness local`). An agent run ignores it.
    walkthrough: list[WalkStep] = Field(default_factory=list)

    @model_validator(mode="after")
    def _unique_ids(self) -> "Scenario":
        ids = [c.id for c in self.criteria]
        if len(ids) != len(set(ids)):
            raise ValueError(f"scenario {self.id}: duplicate criterion ids")
        return self


# ----------------------------------------------------------------- agent output
class Finding(BaseModel):
    severity: Literal["critical", "major", "minor", "cosmetic"]
    title: str
    description: str
    evidence: list[str] = Field(default_factory=list)


class AgentCriterionVerdict(BaseModel):
    criterion_id: str
    status: Literal["PASS", "FAIL", "BLOCKED"]
    observation: str = Field(min_length=1)
    evidence: list[str] = Field(default_factory=list)


class AgentVerdict(BaseModel):
    summary: str
    criteria: list[AgentCriterionVerdict]
    findings: list[Finding] = Field(default_factory=list)


# ----------------------------------------------------------------- report
class Evidence(BaseModel):
    id: str
    label: str
    s3_uri: Optional[str] = None  # None when there is no evidence bucket (local mode)
    local_path: str
    captured_at: str


class CriterionResult(BaseModel):
    criterion_id: str
    description: str
    kind: Literal["visual", "deterministic"]
    status: CriterionStatus
    source: Literal["agent", "deterministic", "harness"]
    observation: str
    evidence: list[str] = Field(default_factory=list)
    actual: Optional[str] = None


class ScenarioResult(BaseModel):
    scenario_id: str
    title: str
    status: Literal["PASS", "FAIL", "ERROR"]
    started_at: str
    ended_at: str
    duration_seconds: float
    session_user_id: str
    criteria: list[CriterionResult] = Field(default_factory=list)
    findings: list[Finding] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)
    agent_summary: str = ""
    error: Optional[str] = None


class BuildRef(BaseModel):
    s3_uri: Optional[str] = None      # the staged copy, on AWS
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    name: str
    artifactory_uri: Optional[str] = None
    source_url: Optional[str] = None  # where install_build fetched it, in local mode


class RunContext(BaseModel):
    """Passed from the orchestrator to each scenario subprocess."""
    run_id: str
    git_ref: str = ""
    git_sha: str = ""
    build: BuildRef
    observe: bool = False
    out_dir: str


class RunReport(BaseModel):
    schema_version: Literal["1.0"] = "1.0"
    run_id: str
    git_ref: str
    git_sha: str
    build: BuildRef
    model_id: str
    mode: RunMode = "agent"
    started_at: str
    ended_at: str
    status: Literal["PASS", "FAIL"]
    totals: dict[str, int]
    scenarios: list[ScenarioResult]
