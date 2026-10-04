"""Local mode's plumbing: serving the build over HTTPS, and capturing the screen.

install_build only downloads over HTTPS from an allow-listed host, so local mode
serves the build itself from localhost rather than weakening the server.
"""
import hashlib
import shutil
import ssl
import subprocess
import urllib.request

import pytest

from uat_harness import local


@pytest.fixture(scope="module")
def tls(tmp_path_factory):
    if not shutil.which("openssl"):
        pytest.skip("needs openssl")
    d = tmp_path_factory.mktemp("tls")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                    "-keyout", str(d / "key.pem"), "-out", str(d / "cert.pem"),
                    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
                   check=True, capture_output=True)
    return d / "cert.pem", d / "key.pem"


def test_the_build_is_served_over_https_from_localhost(tmp_path, tls):
    build = tmp_path / "uat-demo-1.4.0.zip"
    build.write_bytes(b"zip bytes")
    trust = ssl.create_default_context(cafile=str(tls[0]))

    with local.serve_over_https(build, *tls) as url:
        assert url.startswith("https://localhost:") and url.endswith("/uat-demo-1.4.0.zip")
        body = urllib.request.urlopen(url, context=trust, timeout=10).read()

    assert hashlib.sha256(body).digest() == hashlib.sha256(b"zip bytes").digest()


def test_only_the_build_is_served(tmp_path, tls):
    (tmp_path / "secret.txt").write_text("not for the desktop")
    build = tmp_path / "App.zip"
    build.write_bytes(b"z")
    trust = ssl.create_default_context(cafile=str(tls[0]))

    with local.serve_over_https(build, *tls) as url:
        other = url.rsplit("/", 1)[0] + "/secret.txt"
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(other, context=trust, timeout=10)

    assert e.value.code == 404


def test_screen_capture_shells_out_to_powershell_and_returns_the_png(monkeypatch, tmp_path):
    """The real capture only runs on Windows (CI's windows job). Here: the command and the plumbing."""
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        out = cmd[-1].split("'")[-2]  # the .Save('<path>') target
        open(out, "wb").write(b"\x89PNG fake")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(local.subprocess, "run", fake_run)

    assert local.capture_screen() == b"\x89PNG fake"
    assert seen["cmd"][:3] == ["powershell", "-NoProfile", "-NonInteractive"]
    assert "CopyFromScreen" in seen["cmd"][-1]


def test_the_flaui_server_gets_the_image_configs_arguments():
    args = local.flaui_server_args(allowed_hosts="localhost", state_root=r"%APPDATA%\UatDemo",
                                   log_root=r"C:\UAT\logs", install_root=None)

    assert args == ["--allowed-hosts", "localhost", "--state-root", r"%APPDATA%\UatDemo",
                    "--log-root", r"C:\UAT\logs"]
