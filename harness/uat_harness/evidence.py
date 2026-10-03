"""Screenshot evidence: saved locally (job artifact) and to the KMS-encrypted evidence bucket."""
from __future__ import annotations

import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from .models import Evidence
from .session import SCREENSHOT_TOOL, DesktopSession


class EvidenceRecorder:
    """With s3_client None (local mode), screenshots are kept on disk only."""

    def __init__(self, session: DesktopSession, s3_client, bucket: str | None, key_prefix: str, local_dir: Path):
        self.session = session
        self.s3 = s3_client
        self.bucket = bucket
        self.key_prefix = key_prefix.strip("/")
        self.local_dir = local_dir
        self.items: list[Evidence] = []
        self._lock = threading.Lock()
        local_dir.mkdir(parents=True, exist_ok=True)

    def capture(self, label: str) -> Evidence:
        img = self.session.image_of(self.session.call(SCREENSHOT_TOOL, {}))
        ext, ctype = ("png", "image/png") if img[:4] == b"\x89PNG" else ("jpg", "image/jpeg")
        with self._lock:
            eid = f"E{len(self.items) + 1:03d}"
            slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")[:40] or "shot"
            name = f"{eid}-{slug}.{ext}"
            path = self.local_dir / name
            path.write_bytes(img)
            s3_uri = None
            if self.s3 is not None:
                key = f"{self.key_prefix}/{name}"
                self.s3.put_object(Bucket=self.bucket, Key=key, Body=img, ContentType=ctype)
                s3_uri = f"s3://{self.bucket}/{key}"
            ev = Evidence(
                id=eid, label=label[:200], s3_uri=s3_uri,
                local_path=str(path), captured_at=datetime.now(timezone.utc).isoformat(),
            )
            self.items.append(ev)
            return ev

    def ids(self) -> set[str]:
        return {e.id for e in self.items}
