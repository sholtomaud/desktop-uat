"""run_agent: the verdict rules the harness enforces on the LLM.

The Bedrock agent loop is replaced by a scripted one that calls the same tools
the model would — capture_evidence and submit_verdict — so what is tested is the
harness's side: what it accepts, what it rejects, and when it gives up.
"""
import json

import pytest

from support import open_session, scenario
from uat_harness import agent as agent_mod
from uat_harness.evidence import EvidenceRecorder
from support import FakeS3


class ScriptedAgent:
    """Stands in for strands.Agent. Each call to the agent runs the next turn."""
    instances: list["ScriptedAgent"] = []

    def __init__(self, turns, **kw):
        self.turns = list(turns)
        self.tools = {t.tool_name: t for t in kw["tools"]}
        self.prompts: list[str] = []
        self.replies: list[str] = []
        self.system_prompt = kw["system_prompt"]
        ScriptedAgent.instances.append(self)

    def __call__(self, prompt):
        self.prompts.append(prompt)
        if self.turns:
            self.turns.pop(0)(self)

    def capture(self, label="shot") -> str:
        return self.tools["capture_evidence"](label=label).split()[0]

    def submit(self, verdict) -> str:
        reply = self.tools["submit_verdict"](verdict_json=verdict if isinstance(verdict, str) else json.dumps(verdict))
        self.replies.append(reply)
        return reply


@pytest.fixture
def run(cfg, desktop, tmp_path, monkeypatch):
    ScriptedAgent.instances.clear()
    monkeypatch.setattr(agent_mod, "BedrockModel", lambda **kw: object())

    def _run(*turns, sc=None):
        monkeypatch.setattr(agent_mod, "Agent", lambda **kw: ScriptedAgent(turns, **kw))
        session = open_session(cfg, desktop)
        rec = EvidenceRecorder(session, FakeS3(), "evidence", "runs/x", tmp_path / "ev")
        verdict = agent_mod.run_agent(session, rec, sc or scenario(), cfg)
        return verdict, ScriptedAgent.instances[-1]

    return _run


def passing(evidence_id):
    return {"summary": "fine", "criteria": [
        {"criterion_id": "C1", "status": "PASS", "observation": "saw it", "evidence": [evidence_id]}]}


def test_an_evidenced_verdict_is_accepted(run):
    verdict, agent = run(lambda a: a.submit(passing(a.capture())))

    assert verdict is not None and verdict.criteria[0].status == "PASS"
    assert agent.replies == ["ACCEPTED. Stop now."]
    assert len(agent.prompts) == 1  # no nudge needed


def test_the_agent_is_told_what_to_judge_and_what_not_to(run):
    _, agent = run(lambda a: a.submit(passing(a.capture())))

    task = agent.prompts[0]
    assert "- C1: Sign-in screen renders." in task
    judge, automated = task.split("Checked separately by automation")
    assert "C2" not in judge and "C2" in automated


def test_the_agent_is_not_given_harness_only_tools(run):
    _, agent = run(lambda a: a.submit(passing(a.capture())))

    assert not any(n.endswith(d) for n in agent.tools for d in agent_mod.AGENT_DENYLIST)
    assert {"capture_evidence", "submit_verdict", "screenshot"} <= set(agent.tools)


@pytest.mark.parametrize("verdict, problem", [
    ("not json", "invalid JSON/schema"),
    ({"summary": "s", "criteria": []}, "missing criteria ['C1']"),
    ({"summary": "s", "criteria": [
        {"criterion_id": "C1", "status": "BLOCKED", "observation": "o"},
        {"criterion_id": "C2", "status": "PASS", "observation": "o", "evidence": ["E001"]}]},
     "unknown criteria ['C2']"),  # deterministic criteria are not the agent's to judge
    ({"summary": "s", "criteria": [
        {"criterion_id": "C1", "status": "BLOCKED", "observation": "o"},
        {"criterion_id": "C1", "status": "BLOCKED", "observation": "o"}]}, "duplicate criterion ids"),
    ({"summary": "s", "criteria": [
        {"criterion_id": "C1", "status": "PASS", "observation": "o"}]}, "C1: PASS requires evidence"),
    ({"summary": "s", "criteria": [
        {"criterion_id": "C1", "status": "FAIL", "observation": "o"}]}, "C1: FAIL requires evidence"),
    ({"summary": "s", "criteria": [
        {"criterion_id": "C1", "status": "PASS", "observation": "o", "evidence": ["E999"]}]},
     "unknown evidence ids ['E999']"),
    ({"summary": "s", "criteria": [{"criterion_id": "C1", "status": "BLOCKED", "observation": "o"}],
      "findings": [{"severity": "minor", "title": "typo", "description": "d", "evidence": ["E404"]}]},
     "finding 'typo': unknown evidence ids ['E404']"),
    ({"summary": "s", "criteria": [{"criterion_id": "C1", "status": "PASS", "observation": "",
                                    "evidence": ["E001"]}]}, "invalid JSON/schema"),
])
def test_a_verdict_breaking_the_rules_is_rejected_with_the_reason(run, verdict, problem):
    v, agent = run(lambda a: (a.capture(), a.submit(verdict)))

    assert v is None
    assert agent.replies[0].startswith("REJECTED")
    assert problem in agent.replies[0]


def test_blocked_needs_no_evidence(run):
    verdict, _ = run(lambda a: a.submit({"summary": "s", "criteria": [
        {"criterion_id": "C1", "status": "BLOCKED", "observation": "login never appeared"}]}))

    assert verdict is not None and verdict.criteria[0].status == "BLOCKED"


def test_an_agent_that_stops_without_a_verdict_is_nudged(run):
    verdict, agent = run(lambda a: None, lambda a: a.submit(passing(a.capture())))

    assert verdict is not None
    assert len(agent.prompts) == 2
    assert "submit_verdict" in agent.prompts[1]


def test_an_agent_that_never_submits_gets_two_nudges_then_no_verdict(run):
    verdict, agent = run(lambda a: None, lambda a: None, lambda a: None, lambda a: None)

    assert verdict is None
    assert len(agent.prompts) == 3


def test_a_rejected_verdict_can_be_corrected(run):
    verdict, agent = run(
        lambda a: a.submit({"summary": "s", "criteria": [{"criterion_id": "C1", "status": "PASS",
                                                           "observation": "o"}]}),
        lambda a: a.submit(passing(a.capture())),
    )

    assert verdict is not None
    assert [r.split(":")[0] for r in agent.replies] == ["REJECTED", "ACCEPTED. Stop now."]


def test_exploration_only_scenario_lists_no_visual_criteria(run):
    sc = scenario(criteria=[{"id": "C2", "kind": "deterministic", "description": "d",
                             "assertion": {"tool": "assert_element"}}])

    verdict, agent = run(lambda a: a.submit({"summary": "s", "criteria": []}), sc=sc)

    assert "(none - exploration only)" in agent.prompts[0]
    assert verdict is not None


def test_the_system_prompt_ships_with_the_package(run):
    _, agent = run(lambda a: None)

    assert agent.system_prompt.strip()
