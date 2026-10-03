"""Fixtures for the workflow's shell scripts: a fake `aws` and a stub Artifactory.

The scripts run unmodified, as subprocesses, exactly as the workflow runs them.
Only the outside world is replaced.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
FAKES = Path(__file__).resolve().parent / "fakes"

PREFIX = "/desktop-uat/prod"


@dataclass
class FakeAws:
    dir: Path
    state_file: Path
    log_file: Path
    s3_dir: Path

    def set_state(self, **kw) -> None:
        state = {"ssm": {}, "secrets": {}, "fleet_states": ["STOPPED"], "s3": {}}
        state.update(kw)
        self.state_file.write_text(json.dumps(state))

    @property
    def state(self) -> dict:
        return json.loads(self.state_file.read_text())

    @property
    def calls(self) -> list[list[str]]:
        if not self.log_file.exists():
            return []
        return [json.loads(line) for line in self.log_file.read_text().splitlines()]

    def called(self, service: str, op: str) -> list[list[str]]:
        return [c for c in self.calls if c[:2] == [service, op]]

    def env(self) -> dict[str, str]:
        return {
            "PATH": f"{FAKES}{os.pathsep}{os.environ['PATH']}",
            "FAKE_AWS_STATE": str(self.state_file),
            "FAKE_AWS_LOG": str(self.log_file),
            "FAKE_AWS_S3_DIR": str(self.s3_dir),
            "AWS_REGION": "ap-southeast-2",
            "UAT_SSM_PREFIX": PREFIX,
        }


@pytest.fixture
def fake_aws(tmp_path: Path) -> FakeAws:
    f = FakeAws(tmp_path, tmp_path / "aws-state.json", tmp_path / "aws-calls.log", tmp_path / "s3")
    f.set_state()
    return f


@dataclass
class StubArtifactory:
    url: str
    token: str
    files: dict[str, tuple[bytes, str | None]] = field(default_factory=dict)
    requests: list[tuple[str, str | None]] = field(default_factory=list)

    def publish(self, repo_path: str, body: bytes, sha256: str | None) -> None:
        """sha256=None is an artifact Artifactory has no checksum for."""
        self.files[repo_path] = (body, sha256)


@pytest.fixture
def artifactory():
    """Answers the two calls the staging script makes: the storage API and the download."""
    stub = StubArtifactory(url="", token="artifactory-test-token")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (http.server's naming)
            stub.requests.append((self.path, self.headers.get("Authorization")))
            if self.headers.get("Authorization") != f"Bearer {stub.token}":
                return self._send(401, b'{"errors":[{"status":401}]}')
            path = self.path.removeprefix("/artifactory/")
            if path.startswith("api/storage/"):
                entry = stub.files.get(path.removeprefix("api/storage/"))
                if entry is None:
                    return self._send(404, b'{"errors":[{"status":404}]}')
                checksums = {"sha1": "x" * 40, "md5": "x" * 32}
                if entry[1] is not None:
                    checksums["sha256"] = entry[1]
                return self._send(200, json.dumps({"checksums": checksums}).encode())
            entry = stub.files.get(path)
            if entry is None:
                return self._send(404, b"not found")
            return self._send(200, entry[0])

        def _send(self, code: int, body: bytes):
            self.send_response(code)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # keep pytest output clean
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    stub.url = f"http://127.0.0.1:{server.server_port}/artifactory"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield stub
    server.shutdown()


def run_script(name: str, *args: str, env: dict[str, str], timeout: float = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(SCRIPTS / name), *args],
        env=env, capture_output=True, text=True, timeout=timeout, cwd=ROOT,
    )


def outputs(path: Path) -> dict[str, str]:
    """Parse a $GITHUB_OUTPUT file (key=value lines)."""
    return dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
