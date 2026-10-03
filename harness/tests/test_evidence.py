"""EvidenceRecorder: every screenshot is kept locally and in the evidence bucket, under a citable id."""
from support import PNG, FakeS3, open_session
from uat_harness.evidence import EvidenceRecorder


def recorder(cfg, desktop, tmp_path, s3=None):
    return EvidenceRecorder(open_session(cfg, desktop), s3 or FakeS3(), "evidence",
                            "/runs/1/smoke/", tmp_path / "ev")


def test_ids_are_sequential_and_citable(cfg, desktop, tmp_path):
    r = recorder(cfg, desktop, tmp_path)

    ids = [r.capture("one").id, r.capture("two").id, r.capture("three").id]

    assert ids == ["E001", "E002", "E003"]
    assert r.ids() == set(ids)


def test_a_screenshot_lands_locally_and_in_s3_under_the_same_name(cfg, desktop, tmp_path):
    s3 = FakeS3()
    r = recorder(cfg, desktop, tmp_path, s3)

    ev = r.capture("Dashboard after login!")

    assert ev.s3_uri == "s3://evidence/runs/1/smoke/E001-dashboard-after-login.png"
    assert s3.objects["evidence/runs/1/smoke/E001-dashboard-after-login.png"] == \
        {"body": PNG, "content_type": "image/png"}
    assert (tmp_path / "ev" / "E001-dashboard-after-login.png").read_bytes() == PNG


def test_a_jpeg_screenshot_is_stored_as_jpeg(cfg, desktop, tmp_path):
    jpeg = b"\xff\xd8\xff\xe0jpeg"
    desktop.handlers["screenshot"] = lambda a: {"status": "success",
                                                "content": [{"image": {"source": {"bytes": jpeg}}}]}
    s3 = FakeS3()

    ev = recorder(cfg, desktop, tmp_path, s3).capture("x")

    assert ev.s3_uri.endswith(".jpg")
    assert s3.objects[ev.s3_uri.removeprefix("s3://")]["content_type"] == "image/jpeg"


def test_a_label_with_nothing_sluggable_still_gets_a_name(cfg, desktop, tmp_path):
    ev = recorder(cfg, desktop, tmp_path).capture("!!!")

    assert ev.local_path.endswith("E001-shot.png")
