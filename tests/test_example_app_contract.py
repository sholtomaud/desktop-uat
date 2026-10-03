"""The worked scenario and the example app must describe the same application.

tests/windows/test_flaui_live.py proves this on Windows. This catches the same
drift on every `make check`, by reading the sources: a renamed AutomationId, a
renamed .exe, or a launch path that does not match where install_build puts a zip.
"""
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
MAIN_CPP = (ROOT / "example-app" / "src" / "main.cpp").read_text()
APP_TOOLS = (ROOT / "image" / "flaui-mcp-server" / "Tools" / "AppTools.cs").read_text()
SCENARIO = yaml.safe_load((ROOT / "harness" / "scenarios" / "smoke-launch-and-login.yaml").read_text())

# make(..., IDC_X, L"AutomationId", ...): the string argument after the control ID.
ANNOTATED = set(re.findall(r'IDC_[A-Z_]+,\s*L"([A-Za-z]+)"', MAIN_CPP))


def automation_ids_in(node) -> set[str]:
    if isinstance(node, dict):
        found = {node["automationId"]} if "automationId" in node else set()
        return found.union(*(automation_ids_in(v) for v in node.values()))
    if isinstance(node, list):
        return set().union(*(automation_ids_in(v) for v in node))
    return set()


def test_the_regex_finds_the_annotations():
    assert {"SignInButton", "StatusBarConnection", "DisplayName"} <= ANNOTATED


def test_every_automation_id_the_scenario_uses_is_one_the_app_sets():
    used = automation_ids_in(SCENARIO["criteria"])

    assert used and used <= ANNOTATED, used - ANNOTATED


def test_the_scenario_launches_the_exe_the_zip_contains():
    makefile = (ROOT / "example-app" / "Makefile").read_text()

    assert "$(BUILD)/UatDemo.exe" in makefile
    assert SCENARIO["launch"]["executable"].endswith(r"\app\UatDemo.exe")


def test_a_zip_is_extracted_where_the_scenario_launches_from():
    """install_build extracts a .zip to <install root>\\app (AppTools.cs)."""
    assert 'Path.Combine(opts.InstallRoot, "app")' in APP_TOOLS
    assert SCENARIO["launch"]["executable"].startswith("%LOCALAPPDATA%\\UatInstall\\")


def test_reset_kills_the_right_process_and_clears_the_app_state():
    [reset] = [s for s in SCENARIO["setup"] if s["tool"] == "reset_app_state"]

    assert reset["arguments"]["processName"] == "UatDemo"
    assert reset["arguments"]["relativePaths"] == ["UatDemo"]
    assert 'state_dir() { return known_folder(FOLDERID_RoamingAppData) / L"UatDemo"; }' in MAIN_CPP


def test_the_scenario_signs_in_with_the_account_the_app_accepts():
    core = (ROOT / "example-app" / "src" / "core.cpp").read_text()
    m = re.search(r'username "([^"]+)" and password "([^"]+)"', SCENARIO["instructions"])

    assert m, "the instructions name the test account"
    assert f'== "{m[1]}" && password == "{m[2]}"' in core
