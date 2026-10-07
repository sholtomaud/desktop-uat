"""Repository configuration nothing else in `make check` reads: Dependabot's.

A broken dependabot.yml fails only as a check on GitHub, after the push.
"""
import yaml

from script_support import ROOT


def dependabot():
    return yaml.safe_load((ROOT / ".github" / "dependabot.yml").read_text())


def entry(ecosystem, directory):
    [e] = [u for u in dependabot()["updates"] if u["package-ecosystem"] == ecosystem and u["directory"] == directory]
    return e


def test_every_ecosystem_the_repo_has_is_watched():
    watched = {(u["package-ecosystem"], u["directory"]) for u in dependabot()["updates"]}
    assert {("npm", "/infra"), ("npm", "/cdktn"), ("pip", "/harness"),
            ("nuget", "/image/flaui-mcp-server"), ("github-actions", "/")} <= watched


def test_cdktn_groups_its_libraries_and_tooling():
    assert set(entry("npm", "/cdktn")["groups"]) == {"cdktn", "test-tooling"}


def test_cdktn_holds_constructs_where_cdktn_allows_it():
    # cdktn 0.24 requires constructs >=10.6.0 <10.8.0 (see cdktn/package.json).
    assert {"dependency-name": "constructs", "versions": [">=10.8.0"]} in entry("npm", "/cdktn")["ignore"]
