"""report.json (schema'd), junit.xml and a Markdown job summary."""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path, PurePath
from xml.etree import ElementTree as ET

from .models import RunReport

ICON = {"PASS": "✅", "FAIL": "❌", "ERROR": "💥", "BLOCKED": "⛔", "NOT_RUN": "⏭️"}


def totals(report: RunReport) -> dict[str, int]:
    c = Counter(s.status for s in report.scenarios)
    crit = Counter(cr.status for s in report.scenarios for cr in s.criteria)
    return {"scenarios": len(report.scenarios), "passed": c["PASS"], "failed": c["FAIL"], "errored": c["ERROR"],
            "criteria_pass": crit["PASS"], "criteria_fail": crit["FAIL"],
            "criteria_blocked": crit["BLOCKED"], "criteria_not_run": crit["NOT_RUN"],
            "findings": sum(len(s.findings) for s in report.scenarios)}


def write_all(report: RunReport, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(report.model_dump_json(indent=2), encoding="utf-8")
    _junit(report, out / "junit.xml")
    (out / "summary.md").write_text(_markdown(report), encoding="utf-8")


def _junit(report: RunReport, path: Path) -> None:
    suites = ET.Element("testsuites", name=f"desktop-uat {report.run_id}")
    for s in report.scenarios:
        fails = sum(1 for c in s.criteria if c.status != "PASS")
        suite = ET.SubElement(suites, "testsuite", name=f"{s.scenario_id}: {s.title}",
                              tests=str(max(1, len(s.criteria))), failures=str(fails),
                              errors="1" if s.status == "ERROR" else "0", time=str(s.duration_seconds))
        if s.status == "ERROR":
            tc = ET.SubElement(suite, "testcase", classname=s.scenario_id, name="session")
            ET.SubElement(tc, "error", message="scenario error").text = s.error or ""
        for c in s.criteria:
            tc = ET.SubElement(suite, "testcase", classname=s.scenario_id, name=f"{c.criterion_id} {c.description}")
            if c.status != "PASS":
                el = ET.SubElement(tc, "failure", message=f"{c.status} ({c.source})")
                el.text = f"{c.observation}\nactual={c.actual}\nevidence={c.evidence}"
    ET.ElementTree(suites).write(path, encoding="utf-8", xml_declaration=True)


def _md_escape(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ")


def _artifact_path(scenario_id: str, local_path: str) -> str:
    """Where a screenshot sits in the report artifact: evidence/<scenario>/<file>."""
    return f"evidence/{scenario_id}/{PurePath(local_path.replace(chr(92), '/')).name}"


def _s3_run_prefix(r: RunReport) -> str | None:
    """s3://<bucket>/runs/<run_id>/, the audit copy of every screenshot, if any were taken."""
    for s in r.scenarios:
        for e in s.evidence:
            bucket = e.s3_uri.removeprefix("s3://").split("/", 1)[0]
            return f"s3://{bucket}/runs/{r.run_id}/"
    return None


def _markdown(r: RunReport) -> str:
    t = r.totals
    lines = [
        f"## Desktop UAT {ICON[r.status]} {r.status}",
        f"Build `{r.build.name}` sha256 `{r.build.sha256[:12]}…` · model `{r.model_id}` · run `{r.run_id}`",
        "",
        f"Scenarios: **{t['passed']}** passed, **{t['failed']}** failed, **{t['errored']}** errored · "
        f"Criteria: {t['criteria_pass']} pass / {t['criteria_fail']} fail / {t['criteria_blocked']} blocked / "
        f"{t['criteria_not_run']} not run · Findings: {t['findings']}",
        "",
        "| Scenario | Status | Duration | Notes |",
        "|---|---|---|---|",
    ]
    for s in r.scenarios:
        note = _md_escape((s.error or s.agent_summary or "")[:160])
        lines.append(f"| {s.scenario_id} | {ICON[s.status]} {s.status} | {s.duration_seconds:.0f}s | {note} |")
    if prefix := _s3_run_prefix(r):
        # s3:// does not open in a browser; the artifact does. Name the bucket copy once, for audit.
        lines += ["", "Screenshots are in this run's report artifact under `evidence/`, "
                      f"and kept for audit in `{prefix}`."]
    for s in r.scenarios:
        bad = [c for c in s.criteria if c.status != "PASS"]
        if not bad and not s.findings:
            continue
        ev = {e.id: _artifact_path(s.scenario_id, e.local_path) for e in s.evidence}
        lines += ["", f"### {s.scenario_id}: {s.title}"]
        for c in bad:
            refs = ", ".join(f"`{e}` `{ev[e]}`" if e in ev else f"`{e}`" for e in c.evidence) or "no evidence"
            lines.append(f"- {ICON[c.status]} **{c.criterion_id}** ({c.source}) {_md_escape(c.observation)} "
                         f"{'· actual: `' + c.actual + '`' if c.actual else ''} · {refs}")
        for f in s.findings:
            lines.append(f"- 🔎 **{f.severity}** {_md_escape(f.title)}: {_md_escape(f.description)[:300]} "
                         f"({', '.join(f.evidence) or 'no evidence'})")
    lines += ["", "> Agent verdicts are advisory. Release sign-off is the `uat-signoff` environment approval."]
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------- GitHub annotations
# Workflow commands (::error::, ::warning::, ::notice::) printed to stdout become
# annotations on the run and on the PR's checks, on github.com and GHES alike.
# GitHub shows at most 10 of each level per step, so errors are emitted first.
FINDING_LEVEL = {"critical": "warning", "major": "warning", "minor": "notice", "cosmetic": "notice"}


def _cmd_data(s: str) -> str:
    """Escape a command's message. Observations come from the LLM: a raw newline would
    end the command and let the rest of the text be read as a new one."""
    return s.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _cmd_prop(s: str) -> str:
    return _cmd_data(s).replace(":", "%3A").replace(",", "%2C")


def _cmd(level: str, title: str, message: str) -> str:
    return f"::{level} title={_cmd_prop(title)}::{_cmd_data(message)}"


def _cites(evidence: list[str]) -> str:
    return f"evidence {', '.join(evidence)}" if evidence else "no evidence"


def workflow_annotations(r: RunReport) -> list[str]:
    errors: list[str] = []
    others: list[str] = []
    for s in r.scenarios:
        if s.status == "ERROR":
            msg = (s.error or f"scenario errored without a message; see logs/{s.scenario_id}.log").split("\n")[0]
            errors.append(_cmd("error", f"UAT {s.scenario_id} ERROR", msg))
        for c in s.criteria:
            if c.status != "PASS":
                errors.append(_cmd("error", f"UAT {s.scenario_id} {c.criterion_id} {c.status}",
                                   f"{c.description}: {c.observation} ({c.source}; {_cites(c.evidence)})"))
        for f in s.findings:
            others.append(_cmd(FINDING_LEVEL[f.severity], f"UAT {s.scenario_id} finding ({f.severity})",
                               f"{f.title}: {f.description} ({_cites(f.evidence)})"))
    return errors + others


def schema_json() -> str:
    return json.dumps(RunReport.model_json_schema(), indent=2)
