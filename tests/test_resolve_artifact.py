"""scripts/resolve-artifact.sh: turn the triggering event into a validated (repo, path).

Every value here comes from outside the repository (a webhook payload, a form, a
branch name), so the tests are mostly about what it refuses.
"""
import pytest

from script_support import outputs, run_script


@pytest.fixture
def run(tmp_path):
    out = tmp_path / "github_output"

    def _run(**event):
        env = {"PATH": "/usr/bin:/bin", "GITHUB_OUTPUT": str(out), **event}
        r = run_script("resolve-artifact.sh", env=env)
        return r, (outputs(out) if out.exists() else {})

    return _run


def test_repository_dispatch_uses_the_webhook_payload(run):
    r, out = run(EVENT_NAME="repository_dispatch",
                 DISPATCH_REPO="desktop-releases", DISPATCH_PATH="app/1.4.0/App-1.4.0.msi")

    assert r.returncode == 0, r.stdout
    assert out == {"repo": "desktop-releases", "path": "app/1.4.0/App-1.4.0.msi"}


def test_workflow_dispatch_uses_the_form_inputs(run):
    r, out = run(EVENT_NAME="workflow_dispatch", INPUT_REPO="desktop-rc", INPUT_PATH="app/2.0.0-rc.1/App.zip")

    assert r.returncode == 0, r.stdout
    assert out == {"repo": "desktop-rc", "path": "app/2.0.0-rc.1/App.zip"}


def test_push_to_a_release_branch_fills_the_path_template(run):
    r, out = run(EVENT_NAME="push", REF_NAME="release/1.4.0", DEFAULT_REPO="desktop-releases",
                 PATH_TEMPLATE="app/{version}/App-{version}.msi")

    assert r.returncode == 0, r.stdout
    assert out == {"repo": "desktop-releases", "path": "app/1.4.0/App-1.4.0.msi"}


@pytest.mark.parametrize("branch", ["release/main", "release/1.4", "release/1.4.0;rm -rf /", "release/../1.0.0"])
def test_push_refuses_a_branch_that_is_not_a_version(run, branch):
    r, out = run(EVENT_NAME="push", REF_NAME=branch, DEFAULT_REPO="desktop-releases",
                 PATH_TEMPLATE="app/{version}/App.msi")

    assert r.returncode != 0
    assert "bad version" in r.stdout
    assert out == {}


@pytest.mark.parametrize("repo", ["", "desk releases", "repo;id", "repo/sub", "$(id)"])
def test_refuses_a_bad_repository_key(run, repo):
    r, out = run(EVENT_NAME="repository_dispatch", DISPATCH_REPO=repo, DISPATCH_PATH="app/1.0.0/App.msi")

    assert r.returncode != 0
    assert out == {}


@pytest.mark.parametrize("path", [
    "",
    "../secrets/token",
    "app/../../etc/passwd",
    "app/1.0.0/App.msi;curl evil",
    "app/$(id)/App.msi",
    "app/1.0.0/App .msi",
    "app/1.0.0/App.msi\nrepo=other",
])
def test_refuses_a_path_that_could_escape_or_inject(run, path):
    r, out = run(EVENT_NAME="repository_dispatch", DISPATCH_REPO="desktop-releases", DISPATCH_PATH=path)

    assert r.returncode != 0
    assert out == {}


def test_an_unsupported_event_fails(run):
    r, out = run(EVENT_NAME="pull_request")

    assert r.returncode != 0
    assert "unsupported event" in r.stdout
    assert out == {}
