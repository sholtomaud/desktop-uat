"""scripts/ec2-uat.sh: one UAT run on an ephemeral EC2 desktop (cdktn/).

Launch from the launch template, wait until the instance has joined the domain,
run the scenarios through the `run` document, fetch the reports, then either
tear down (leave the domain, terminate) or hold the instance for testers.
"""
import json
import time
import zipfile

import pytest

from script_support import outputs, run_script

DISCOVERY = "/desktop-uat/uat/ec2-operator"
BUCKET = "desktop-uat-uat-20261007"
INSTANCE = "i-0123456789abcdef0"
JOINED = "UAT-6789ABCDEF0.corp.example.com"
SHA = "a" * 64
BUILD = f"s3://{BUCKET}/staging/artifactory/desktop-releases/{SHA}/App-1.4.0.zip"

NOT_JOINED = ["Online", "EC2AMAZ-ABC123.WORKGROUP"]
REBOOTING = ["ConnectionLost", "EC2AMAZ-ABC123.WORKGROUP"]
READY = ["Online", JOINED]


@pytest.fixture
def scenarios(tmp_path):
    d = tmp_path / "scenarios"
    d.mkdir()
    (d / "login.yaml").write_text("name: login\n")
    (d / "sub").mkdir()
    (d / "sub" / "more.yaml").write_text("name: more\n")
    return d


@pytest.fixture
def env(fake_aws, tmp_path):
    return {
        **fake_aws.env(),
        "UAT_EC2_PARAMETER": DISCOVERY,
        "EC2_UAT_POLL_SECONDS": "0",
        "GITHUB_OUTPUT": str(tmp_path / "github_output"),
        "GITHUB_STEP_SUMMARY": str(tmp_path / "summary.md"),
    }


def world(fake_aws, *, ssm_instances=(NOT_JOINED, REBOOTING, READY), invocations=(("InProgress", -1), ("Success", 0)),
          leave=(("Success", 0),), capacity_errors=(), reports=None):
    discovery = {
        "LaunchTemplateId": "lt-0abc", "SubnetIds": ["subnet-a", "subnet-b"], "Bucket": BUCKET,
        "RunDocument": "desktop-uat-uat-run", "LeaveDocument": "desktop-uat-uat-leave",
        "Region": "ap-southeast-2", "Purpose": "desktop-uat-uat",
    }
    fake_aws.set_state(
        ssm={DISCOVERY: json.dumps(discovery)},
        ec2={"next_instance": INSTANCE, "capacity_errors": list(capacity_errors), "private_ip": "10.1.2.3"},
        ssm_instances=[list(x) for x in ssm_instances],
        invocations={"desktop-uat-uat-run": [list(x) for x in invocations],
                     "desktop-uat-uat-leave": [list(x) for x in leave]},
    )
    for name, body in (reports or {"report.json": '{"verdict": "PASS"}', "screenshots/1.png": "png"}).items():
        f = fake_aws.s3_dir / BUCKET / "runs" / "42-1" / name
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(body)


def run(env, *extra, out=None):
    args = ["run", "--build-s3-uri", BUILD, "--build-sha256", SHA, "--scenarios", str(env["_scenarios"]),
            "--run-id", "42-1", "--state-root", "%APPDATA%/UatDemo", "--git-ref", "refs/heads/main",
            "--git-sha", "f" * 40, "--out", str(out), *extra]
    return run_script("ec2-uat.sh", *args, env={k: v for k, v in env.items() if not k.startswith("_")}, timeout=60)


@pytest.fixture
def go(env, scenarios, tmp_path):
    def _go(*extra):
        return run({**env, "_scenarios": scenarios}, *extra, out=tmp_path / "reports")
    return _go


def opt(call, name):
    return call[call.index(name) + 1]


# ---------------------------------------------------------------- the happy path

def test_a_run_launches_waits_for_the_domain_runs_fetches_and_tears_down(go, fake_aws, tmp_path):
    world(fake_aws)

    r = go()

    assert r.returncode == 0, r.stdout + r.stderr
    services = [c[:2] for c in fake_aws.calls]
    # Ordered: nothing is sent before the instance has joined; nothing terminated before leaving.
    assert services.index(["ec2", "run-instances"]) < services.index(["ssm", "send-command"])
    sends = fake_aws.called("ssm", "send-command")
    assert [opt(c, "--document-name") for c in sends] == ["desktop-uat-uat-run", "desktop-uat-uat-leave"]
    assert fake_aws.calls[-1] == ["ec2", "terminate-instances", "--instance-ids", INSTANCE]
    assert (tmp_path / "reports" / "report.json").read_text() == '{"verdict": "PASS"}'
    assert (tmp_path / "reports" / "screenshots" / "1.png").exists()
    out = outputs(tmp_path / "github_output")
    assert (out["instance_id"], out["verdict"]) == (INSTANCE, "PASS")


def test_it_launches_from_the_template_with_the_tags_the_policy_and_the_boot_script_need(go, fake_aws):
    world(fake_aws)
    before = int(time.time())

    go()

    [launch] = fake_aws.called("ec2", "run-instances")
    assert opt(launch, "--launch-template") == "LaunchTemplateId=lt-0abc,Version=$Latest"
    assert opt(launch, "--subnet-id") == "subnet-a"
    [spec] = json.loads(opt(launch, "--tag-specifications"))
    assert spec["ResourceType"] == "instance"
    tags = {t["Key"]: t["Value"] for t in spec["Tags"]}
    assert tags["Purpose"] == "desktop-uat-uat"
    assert tags["desktop-uat-run"] == "42-1"
    # A run's whole budget: boot and join, then the run document's 7200 s.
    assert before + 7200 <= int(tags["desktop-uat-expires-at"]) <= int(time.time()) + 2 * 3600 + 3600


def test_the_run_document_gets_the_run_presigned_and_single_valued(go, fake_aws):
    world(fake_aws)

    go()

    run_cmd = fake_aws.called("ssm", "send-command")[0]
    assert opt(run_cmd, "--instance-ids") == INSTANCE
    params = json.loads(opt(run_cmd, "--parameters"))
    assert params == {
        "RunId": ["42-1"],
        "BuildUrl": [f"https://{BUCKET}.s3.ap-southeast-2.amazonaws.com/staging/artifactory/desktop-releases/{SHA}/App-1.4.0.zip"
                     "?X-Amz-Expires=9000&X-Amz-Signature=fake"],
        "BuildSha256": [SHA],
        "ScenariosUrl": [f"https://{BUCKET}.s3.ap-southeast-2.amazonaws.com/staging/runs/42-1/scenarios.zip"
                         "?X-Amz-Expires=9000&X-Amz-Signature=fake"],
        "Tags": [""],
        "StateRoot": ["%APPDATA%/UatDemo"],
        "GitRef": ["refs/heads/main"],
        "GitSha": ["f" * 40],
    }


def test_the_scenarios_are_zipped_and_staged_for_the_instance(go, fake_aws):
    world(fake_aws)

    go()

    staged = fake_aws.s3_dir / BUCKET / "staging" / "runs" / "42-1" / "scenarios.zip"
    with zipfile.ZipFile(staged) as z:
        assert sorted(n for n in z.namelist() if not n.endswith("/")) == ["login.yaml", "sub/more.yaml"]


def test_tags_are_passed_through(go, fake_aws):
    world(fake_aws)

    go("--tags", "smoke,login")

    params = json.loads(opt(fake_aws.called("ssm", "send-command")[0], "--parameters"))
    assert params["Tags"] == ["smoke,login"]


# ---------------------------------------------------------------- a failing run

def test_a_failed_run_still_fetches_reports_and_tears_down_and_fails_the_step(go, fake_aws, tmp_path):
    world(fake_aws, invocations=(("InProgress", -1), ("Failed", 1)))

    r = go()

    assert r.returncode == 1
    assert outputs(tmp_path / "github_output")["verdict"] == "FAIL"
    assert (tmp_path / "reports" / "report.json").exists()
    assert fake_aws.called("ec2", "terminate-instances")


@pytest.mark.parametrize("status", ["TimedOut", "Cancelled", "DeliveryTimedOut"])
def test_a_run_that_never_finished_is_a_failure(go, fake_aws, tmp_path, status):
    world(fake_aws, invocations=((status, -1),))

    r = go()

    assert r.returncode != 0
    assert outputs(tmp_path / "github_output")["verdict"] == "FAIL"
    assert fake_aws.called("ec2", "terminate-instances")


def test_an_instance_that_never_joins_the_domain_is_torn_down(go, env, fake_aws, scenarios, tmp_path):
    world(fake_aws, ssm_instances=(NOT_JOINED,))

    r = run({**env, "_scenarios": scenarios, "EC2_UAT_READY_TIMEOUT": "0"}, out=tmp_path / "reports")

    assert r.returncode != 0
    assert "did not join the domain" in r.stdout
    assert [opt(c, "--document-name") for c in fake_aws.called("ssm", "send-command")] == ["desktop-uat-uat-leave"]
    assert fake_aws.called("ec2", "terminate-instances")


def test_capacity_in_one_subnet_tries_the_next(go, fake_aws):
    world(fake_aws, capacity_errors=["subnet-a"])

    r = go()

    assert r.returncode == 0, r.stdout + r.stderr
    assert [opt(c, "--subnet-id") for c in fake_aws.called("ec2", "run-instances")] == ["subnet-a", "subnet-b"]


def test_no_capacity_anywhere_fails_without_an_instance_to_tear_down(go, fake_aws):
    world(fake_aws, capacity_errors=["subnet-a", "subnet-b"])

    r = go()

    assert r.returncode != 0
    assert fake_aws.called("ec2", "terminate-instances") == []


# ---------------------------------------------------------------- holding it for testers

def test_hold_leaves_the_instance_up_for_testers_until_its_expiry(go, fake_aws, tmp_path):
    world(fake_aws)

    r = go("--hold-minutes", "120")

    assert r.returncode == 0, r.stdout + r.stderr
    assert fake_aws.called("ec2", "terminate-instances") == []
    assert [opt(c, "--document-name") for c in fake_aws.called("ssm", "send-command")] == ["desktop-uat-uat-run"]
    tags = {t["Key"]: t["Value"] for t in json.loads(opt(fake_aws.called("ec2", "run-instances")[0], "--tag-specifications"))[0]["Tags"]}
    out = outputs(tmp_path / "github_output")
    assert out["held_until"] == tags["desktop-uat-expires-at"]
    assert int(tags["desktop-uat-expires-at"]) >= int(time.time()) + 7200 + 120 * 60 - 60
    assert out["computer_name"] == JOINED
    summary = (tmp_path / "summary.md").read_text()
    assert JOINED in summary and "10.1.2.3" in summary


def test_hold_has_a_ceiling(go, fake_aws):
    world(fake_aws)

    r = go("--hold-minutes", "100000")

    assert r.returncode == 2
    assert fake_aws.called("ec2", "run-instances") == []


# ---------------------------------------------------------------- refusing bad input before spending anything

@pytest.mark.parametrize("args, why", [
    (["--run-id", "42'; rm -rf /"], "run id"),
    (["--build-s3-uri", "s3://some-other-bucket/staging/x.zip"], "staging"),
    (["--build-s3-uri", f"s3://{BUCKET}/runs/x.zip"], "staging"),
    (["--build-sha256", "not-a-sha"], "sha256"),
    (["--tags", "a b"], "tags"),
])
def test_bad_input_is_refused_before_anything_is_launched(env, fake_aws, scenarios, tmp_path, args, why):
    world(fake_aws)
    base = {"--build-s3-uri": BUILD, "--build-sha256": SHA, "--scenarios": str(scenarios), "--run-id": "42-1",
            "--state-root": "%APPDATA%/UatDemo"}
    base.update(dict(zip(args[::2], args[1::2])))
    flat = [x for kv in base.items() for x in kv]

    r = run_script("ec2-uat.sh", "run", *flat, "--out", str(tmp_path / "r"),
                   env={k: v for k, v in env.items()}, timeout=30)

    assert r.returncode == 2
    assert why in (r.stdout + r.stderr).lower()
    assert fake_aws.called("ec2", "run-instances") == []


# ---------------------------------------------------------------- the other commands

def test_teardown_leaves_the_domain_then_terminates(env, fake_aws):
    world(fake_aws)

    r = run_script("ec2-uat.sh", "teardown", INSTANCE, env=env)

    assert r.returncode == 0, r.stdout + r.stderr
    assert fake_aws.calls[-1] == ["ec2", "terminate-instances", "--instance-ids", INSTANCE]
    assert [opt(c, "--document-name") for c in fake_aws.called("ssm", "send-command")] == ["desktop-uat-uat-leave"]


def test_teardown_terminates_even_when_leaving_the_domain_fails(env, fake_aws):
    world(fake_aws, leave=(("Failed", 1),))

    r = run_script("ec2-uat.sh", "teardown", INSTANCE, env=env)

    assert r.returncode == 0
    assert "stale computer object" in r.stdout
    assert fake_aws.called("ec2", "terminate-instances")


def test_discover_names_the_bucket_to_stage_into(env, fake_aws, tmp_path):
    world(fake_aws)

    r = run_script("ec2-uat.sh", "discover", env=env)

    assert r.returncode == 0, r.stderr
    assert outputs(tmp_path / "github_output") == {"bucket": BUCKET, "staging_prefix": "staging/"}


def test_usage(env):
    assert run_script("ec2-uat.sh", "nonsense", env=env).returncode == 2


def test_every_output_the_workflow_reads_is_one_the_script_writes():
    import re
    from script_support import ROOT
    workflow = (ROOT / ".github" / "workflows" / "desktop-uat-ec2.yml").read_text()
    script = (ROOT / "scripts" / "ec2-uat.sh").read_text()
    written = set(re.findall(r"\bout ([a-z_]+) ", script))
    read = set(re.findall(r"steps\.(?:discover|run)\.outputs\.([a-z_]+)", workflow))
    assert read, "the workflow no longer reads the script's outputs this way"
    assert read <= written
    # And it runs the scenarios the repository carries.
    assert "--scenarios harness/scenarios" in workflow and (ROOT / "harness" / "scenarios").is_dir()
