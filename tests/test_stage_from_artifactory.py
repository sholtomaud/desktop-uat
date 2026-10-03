"""scripts/stage-from-artifactory.sh: pull a release, verify Artifactory's SHA-256, stage to S3."""
import hashlib

import pytest

from script_support import PREFIX, outputs, run_script

REPO = "desktop-releases"
PATH = "app/1.4.0/App-1.4.0.msi"
BODY = b"MSI-bytes-for-1.4.0"
SHA = hashlib.sha256(BODY).hexdigest()


@pytest.fixture
def env(fake_aws, artifactory, tmp_path):
    fake_aws.set_state(
        ssm={f"{PREFIX}/builds-bucket": "uat-builds"},
        secrets={"desktop-uat/artifactory-token": f'{{"token":"{artifactory.token}"}}'},
    )
    return {
        **fake_aws.env(),
        "ARTIFACTORY_URL": artifactory.url + "/",  # a trailing slash must not double up
        "ARTIFACTORY_SECRET_ID": "desktop-uat/artifactory-token",
        "GITHUB_OUTPUT": str(tmp_path / "github_output"),
    }


def test_stages_a_verified_release_content_addressed(env, fake_aws, artifactory, tmp_path):
    artifactory.publish(f"{REPO}/{PATH}", BODY, SHA)

    r = run_script("stage-from-artifactory.sh", REPO, PATH, env=env)

    assert r.returncode == 0, r.stderr
    key = f"uat-builds/artifactory/{REPO}/{SHA}/App-1.4.0.msi"
    assert (fake_aws.s3_dir / key).read_bytes() == BODY
    assert fake_aws.state["s3"][key]["metadata"] == f"artifactory-path={REPO}/{PATH},sha256={SHA}"
    assert outputs(tmp_path / "github_output") == {
        "build_s3_uri": f"s3://{key}",
        "build_sha256": SHA,
        "build_name": "App-1.4.0.msi",
        "artifactory_uri": f"{artifactory.url}/{REPO}/{PATH}",
    }


def test_sends_the_token_from_secrets_manager_as_a_bearer_token(env, artifactory):
    artifactory.publish(f"{REPO}/{PATH}", BODY, SHA)

    run_script("stage-from-artifactory.sh", REPO, PATH, env=env)

    assert artifactory.requests, "Artifactory was never called"
    assert {auth for _, auth in artifactory.requests} == {f"Bearer {artifactory.token}"}


def test_masks_the_token_in_the_job_log(env, artifactory):
    artifactory.publish(f"{REPO}/{PATH}", BODY, SHA)

    r = run_script("stage-from-artifactory.sh", REPO, PATH, env=env)

    assert f"::add-mask::{artifactory.token}" in r.stdout


def test_a_leading_slash_on_the_path_is_ignored(env, artifactory):
    artifactory.publish(f"{REPO}/{PATH}", BODY, SHA)

    r = run_script("stage-from-artifactory.sh", REPO, "/" + PATH, env=env)

    assert r.returncode == 0, r.stderr


def test_a_checksum_mismatch_fails_and_stages_nothing(env, fake_aws, artifactory):
    artifactory.publish(f"{REPO}/{PATH}", BODY, hashlib.sha256(b"something else").hexdigest())

    r = run_script("stage-from-artifactory.sh", REPO, PATH, env=env)

    assert r.returncode != 0
    assert "SHA-256 mismatch" in r.stdout
    assert fake_aws.called("s3", "cp") == []


def test_an_artifact_without_a_sha256_is_refused(env, fake_aws, artifactory):
    artifactory.publish(f"{REPO}/{PATH}", BODY, None)

    r = run_script("stage-from-artifactory.sh", REPO, PATH, env=env)

    assert r.returncode != 0
    assert "has no sha256" in r.stdout
    assert fake_aws.called("s3", "cp") == []


def test_a_missing_artifact_fails(env, fake_aws):
    r = run_script("stage-from-artifactory.sh", REPO, "app/9.9.9/App-9.9.9.msi", env=env)

    assert r.returncode != 0
    assert fake_aws.called("s3", "cp") == []


def test_a_rejected_token_fails(env, fake_aws, artifactory):
    artifactory.publish(f"{REPO}/{PATH}", BODY, SHA)
    fake_aws.set_state(
        ssm={f"{PREFIX}/builds-bucket": "uat-builds"},
        secrets={"desktop-uat/artifactory-token": '{"token":"revoked"}'},
    )

    r = run_script("stage-from-artifactory.sh", REPO, PATH, env=env)

    assert r.returncode != 0
    assert fake_aws.called("s3", "cp") == []


@pytest.mark.parametrize("missing", ["ARTIFACTORY_URL", "ARTIFACTORY_SECRET_ID", "UAT_SSM_PREFIX", "AWS_REGION"])
def test_refuses_to_run_without_its_runner_environment(env, fake_aws, missing):
    del env[missing]

    r = run_script("stage-from-artifactory.sh", REPO, PATH, env=env)

    assert r.returncode != 0
    assert fake_aws.calls == []
