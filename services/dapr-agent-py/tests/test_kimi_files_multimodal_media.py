from __future__ import annotations

import hashlib
import json
from typing import Any
import urllib.request

import pytest

from src.adapters.kimi_files_multimodal_media import (
    KimiFilesMultimodalMediaAdapter,
)


class _Response:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *args: Any) -> None:
        return None

    def read(self) -> bytes:
        return self._body


class _KimiFilesApi:
    def __init__(self, listed_files: list[dict[str, Any]] | None = None) -> None:
        self.listed_files = listed_files or []
        self.requests: list[urllib.request.Request] = []

    def __call__(
        self,
        request: urllib.request.Request,
        *,
        timeout: int,
    ) -> _Response:
        assert timeout == 90
        self.requests.append(request)
        if request.method == "GET":
            return _Response({"data": self.listed_files})
        if request.method == "DELETE":
            return _Response({"deleted": True})
        if request.method == "POST":
            return _Response({"id": "uploaded-file", "status": "ok"})
        raise AssertionError(f"unexpected request method: {request.method}")


@pytest.fixture(autouse=True)
def _kimi_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KIMI_API_KEY", "secret-kimi-key")
    monkeypatch.setenv("KIMI_BASE_URL", "https://kimi.test/v1")
    monkeypatch.delenv("DAPR_AGENT_PY_KIMI_FILE_RETENTION_SECONDS", raising=False)
    monkeypatch.delenv("DAPR_AGENT_PY_KIMI_FILE_MAX_MANAGED", raising=False)


def test_uploads_image_with_kimi_api_key_and_purpose_image() -> None:
    api = _KimiFilesApi()
    adapter = KimiFilesMultimodalMediaAdapter(urlopen=api)

    reference = adapter.upload_image(b"real-pixel-bytes", "image/png")

    assert reference.uri == "ms://uploaded-file"
    assert [request.method for request in api.requests] == ["GET", "POST"]
    upload = api.requests[1]
    assert upload.full_url == "https://kimi.test/v1/files"
    assert upload.headers["Authorization"] == "Bearer secret-kimi-key"
    body = bytes(upload.data or b"")
    assert b'name="purpose"\r\n\r\nimage' in body
    assert b'name="file"' in body
    assert b"real-pixel-bytes" in body
    digest = hashlib.sha256(b"real-pixel-bytes").hexdigest().encode("ascii")
    assert b"wfb-durable-media-" + digest + b".png" in body


def test_reuses_existing_content_addressed_file() -> None:
    image = b"same-pixels"
    digest = hashlib.sha256(image).hexdigest()
    api = _KimiFilesApi(
        [
            {
                "id": "existing-file",
                "filename": f"wfb-durable-media-{digest}.jpg",
                "status": "ok",
                "created_at": 900,
            }
        ]
    )
    adapter = KimiFilesMultimodalMediaAdapter(urlopen=api, now=lambda: 1_000)

    reference = adapter.upload_image(image, "image/jpeg")

    assert reference.uri == "ms://existing-file"
    assert [request.method for request in api.requests] == ["GET"]


def test_cleanup_only_deletes_stale_managed_files(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DAPR_AGENT_PY_KIMI_FILE_RETENTION_SECONDS", "3600")
    api = _KimiFilesApi(
        [
            {
                "id": "managed-stale",
                "filename": "wfb-durable-media-old.png",
                "created_at": 1,
            },
            {
                "id": "unmanaged-stale",
                "filename": "user-document.png",
                "created_at": 1,
            },
        ]
    )
    adapter = KimiFilesMultimodalMediaAdapter(urlopen=api, now=lambda: 10_000)

    adapter.upload_image(b"new-image", "image/webp")

    assert [request.method for request in api.requests] == ["GET", "DELETE", "POST"]
    assert api.requests[1].full_url.endswith("/files/managed-stale")
    assert all("unmanaged-stale" not in request.full_url for request in api.requests)


def test_kimi_api_key_is_the_only_authentication_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("KIMI_API_KEY")
    monkeypatch.setenv("MOONSHOT_API_KEY", "must-not-be-used")
    adapter = KimiFilesMultimodalMediaAdapter(urlopen=_KimiFilesApi())

    with pytest.raises(RuntimeError, match="Set KIMI_API_KEY"):
        adapter.upload_image(b"pixels", "image/png")


def test_non_ready_upload_is_not_persisted_as_an_ms_reference() -> None:
    class _PendingApi(_KimiFilesApi):
        def __call__(
            self,
            request: urllib.request.Request,
            *,
            timeout: int,
        ) -> _Response:
            if request.method == "POST":
                self.requests.append(request)
                return _Response({"id": "pending-file", "status": "processing"})
            return super().__call__(request, timeout=timeout)

    adapter = KimiFilesMultimodalMediaAdapter(urlopen=_PendingApi())

    with pytest.raises(RuntimeError, match="status=processing"):
        adapter.upload_image(b"pixels", "image/png")
