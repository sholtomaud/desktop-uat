"""scripts/fleet.sh: start/stop the on-demand fleet, hold/release the janitor's lease."""
import time

import pytest

from script_support import PREFIX, run_script

FLEET = "desktop-uat-fleet"


@pytest.fixture
def env(fake_aws):
    # Poll without waiting; the real script sleeps 20s between polls.
    return {**fake_aws.env(), "FLEET_POLL_SECONDS": "0"}


def fleet(fake_aws, *states):
    fake_aws.set_state(ssm={f"{PREFIX}/fleet-name": FLEET}, fleet_states=list(states))


def test_start_on_a_running_fleet_does_nothing(env, fake_aws):
    fleet(fake_aws, "RUNNING")

    r = run_script("fleet.sh", "start", env=env)

    assert r.returncode == 0, r.stderr
    assert fake_aws.called("appstream", "start-fleet") == []


def test_start_starts_a_stopped_fleet_once_and_waits_for_running(env, fake_aws):
    fleet(fake_aws, "STOPPED", "STARTING", "STARTING", "RUNNING")

    r = run_script("fleet.sh", "start", env=env)

    assert r.returncode == 0, r.stderr
    assert fake_aws.called("appstream", "start-fleet") == [["appstream", "start-fleet", "--name", FLEET]]
    assert f"fleet {FLEET} RUNNING" in r.stdout


def test_start_waits_out_a_fleet_that_is_stopping(env, fake_aws):
    fleet(fake_aws, "STOPPING", "STOPPED", "STARTING", "RUNNING")

    r = run_script("fleet.sh", "start", env=env)

    assert r.returncode == 0, r.stderr
    assert len(fake_aws.called("appstream", "start-fleet")) == 1


def test_start_fails_on_an_unexpected_state(env, fake_aws):
    fleet(fake_aws, "None")  # what --output text prints when the fleet does not exist

    r = run_script("fleet.sh", "start", env=env)

    assert r.returncode == 1
    assert "unexpected fleet state None" in r.stdout


def test_start_gives_up_after_its_timeout(env, fake_aws):
    fleet(fake_aws, "STARTING")
    env["FLEET_START_TIMEOUT"] = "0"

    r = run_script("fleet.sh", "start", env=env, timeout=30)

    assert r.returncode == 1
    assert "did not reach RUNNING" in r.stdout


@pytest.mark.parametrize("state", ["RUNNING", "STARTING"])
def test_stop_stops_a_live_fleet(env, fake_aws, state):
    fleet(fake_aws, state)

    r = run_script("fleet.sh", "stop", env=env)

    assert r.returncode == 0, r.stderr
    assert fake_aws.called("appstream", "stop-fleet") == [["appstream", "stop-fleet", "--name", FLEET]]


@pytest.mark.parametrize("state", ["STOPPED", "STOPPING"])
def test_stop_is_idempotent(env, fake_aws, state):
    fleet(fake_aws, state)

    r = run_script("fleet.sh", "stop", env=env)

    assert r.returncode == 0, r.stderr
    assert fake_aws.called("appstream", "stop-fleet") == []


def test_lease_writes_an_expiry_the_janitor_can_compare_with_now(env, fake_aws):
    fleet(fake_aws, "RUNNING")
    before = int(time.time())

    r = run_script("fleet.sh", "lease", "14400", env=env)

    assert r.returncode == 0, r.stderr
    until = int(fake_aws.state["ssm"][f"{PREFIX}/fleet-lease"])
    assert before + 14400 <= until <= int(time.time()) + 14400


def test_release_zeroes_the_lease(env, fake_aws):
    fleet(fake_aws, "RUNNING")
    run_script("fleet.sh", "lease", "600", env=env)

    r = run_script("fleet.sh", "release", env=env)

    assert r.returncode == 0, r.stderr
    assert fake_aws.state["ssm"][f"{PREFIX}/fleet-lease"] == "0"


def test_lease_needs_a_duration(env, fake_aws):
    fleet(fake_aws, "RUNNING")

    r = run_script("fleet.sh", "lease", env=env)

    assert r.returncode != 0
    assert fake_aws.called("ssm", "put-parameter") == []


def test_an_unknown_command_is_a_usage_error(env, fake_aws):
    fleet(fake_aws, "RUNNING")

    r = run_script("fleet.sh", "restart", env=env)

    assert r.returncode == 2
    assert "usage" in r.stderr
