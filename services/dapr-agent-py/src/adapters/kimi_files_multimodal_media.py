"""Kimi Files adapter for durable multimodal tool results.

K3 accepts uploaded images as ``ms://<file-id>`` references. Uploading pixels
before an activity completes keeps base64 out of Dapr workflow history while
preserving native vision input. Managed files use a private filename prefix;
each cache miss opportunistically reuses identical uploads and deletes a
bounded number of stale managed files so the account-level file quota does not
grow without limit.
"""

from __future__ import annotations

from collections import OrderedDict
import hashlib
import json
import logging
import os
import threading
import time
from typing import Any, Callable
from urllib.error import HTTPError
import urllib.parse
import urllib.request
import uuid

from src.ports.multimodal_media import OffloadedMediaReference


logger = logging.getLogger(__name__)

_MANAGED_FILE_PREFIX = "wfb-durable-media-"
_SUPPORTED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
_READY_FILE_STATUSES = {"ready", "ok", "processed", "success", "completed"}


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    raw = os.environ.get(name)
    if raw:
        try:
            return max(minimum, int(raw))
        except ValueError:
            pass
    return max(minimum, default)


class KimiFilesMultimodalMediaAdapter:
    """Persist image bytes through Kimi's ``purpose=image`` Files API."""

    def __init__(
        self,
        *,
        urlopen: Callable[..., Any] = urllib.request.urlopen,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._urlopen = urlopen
        self._now = now
        self._cache: OrderedDict[str, OffloadedMediaReference] = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def _base_url() -> str:
        return os.environ.get("KIMI_BASE_URL", "https://api.moonshot.ai/v1").rstrip("/")

    @staticmethod
    def _api_key() -> str:
        api_key = os.environ.get("KIMI_API_KEY", "").strip()
        if not api_key:
            raise RuntimeError("No Kimi authentication configured. Set KIMI_API_KEY.")
        return api_key

    @staticmethod
    def _timeout_seconds() -> int:
        return _env_int("DAPR_AGENT_PY_KIMI_FILE_TIMEOUT_SECONDS", 90, minimum=1)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key()}",
            "Accept": "application/json",
            "User-Agent": os.environ.get(
                "KIMI_USER_AGENT", "workflow-builder-dapr-agent-py/1.0"
            ),
        }

    def _json_request(self, request: urllib.request.Request) -> dict[str, Any]:
        try:
            with self._urlopen(request, timeout=self._timeout_seconds()) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"Kimi Files API failed ({exc.code}): {detail}") from exc
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"Kimi Files API unavailable: {exc}") from exc
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Kimi Files API returned invalid JSON") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("Kimi Files API returned an invalid response")
        return parsed

    def _list_managed_files(self) -> list[dict[str, Any]]:
        request = urllib.request.Request(
            f"{self._base_url()}/files",
            headers=self._headers(),
            method="GET",
        )
        try:
            payload = self._json_request(request)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[multimodal-media] Kimi file listing failed: %s", exc)
            return []
        files = payload.get("data")
        if not isinstance(files, list):
            return []
        return [
            item
            for item in files
            if isinstance(item, dict)
            and str(item.get("filename") or "").startswith(_MANAGED_FILE_PREFIX)
        ]

    def _delete_file(self, file_id: str) -> None:
        request = urllib.request.Request(
            f"{self._base_url()}/files/{urllib.parse.quote(file_id, safe='')}",
            headers=self._headers(),
            method="DELETE",
        )
        self._json_request(request)

    def _reap_stale(self, files: list[dict[str, Any]]) -> set[str]:
        now = int(self._now())
        retention = _env_int(
            "DAPR_AGENT_PY_KIMI_FILE_RETENTION_SECONDS",
            7 * 24 * 3600,
            minimum=3600,
        )
        minimum_delete_age = _env_int(
            "DAPR_AGENT_PY_KIMI_FILE_MIN_DELETE_AGE_SECONDS",
            6 * 3600,
            minimum=3600,
        )
        max_managed = _env_int(
            "DAPR_AGENT_PY_KIMI_FILE_MAX_MANAGED",
            800,
            minimum=1,
        )
        max_deletes = _env_int(
            "DAPR_AGENT_PY_KIMI_FILE_MAX_DELETE_PER_UPLOAD",
            20,
            minimum=0,
        )
        ordered = sorted(files, key=lambda item: int(item.get("created_at") or 0))
        stale_ids: list[str] = []

        def _mark_stale(item: dict[str, Any]) -> None:
            file_id = str(item.get("id") or "")
            if file_id and file_id not in stale_ids:
                stale_ids.append(file_id)

        for item in ordered:
            if int(item.get("created_at") or 0) <= now - retention:
                _mark_stale(item)
        overflow = max(0, len(ordered) - max_managed)
        for item in ordered[:overflow]:
            if int(item.get("created_at") or 0) <= now - minimum_delete_age:
                _mark_stale(item)

        deleted: set[str] = set()
        for file_id in stale_ids[:max_deletes]:
            try:
                self._delete_file(file_id)
                deleted.add(file_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "[multimodal-media] stale Kimi file cleanup failed id=%s: %s",
                    file_id,
                    exc,
                )
        if deleted:
            logger.info(
                "[multimodal-media] deleted %d stale managed Kimi file(s)",
                len(deleted),
            )
        return deleted

    @staticmethod
    def _multipart_body(
        *,
        image: bytes,
        media_type: str,
        filename: str,
        boundary: str,
    ) -> bytes:
        prefix = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="purpose"\r\n\r\n'
            "image\r\n"
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: {media_type}\r\n\r\n"
        ).encode("ascii")
        return prefix + image + f"\r\n--{boundary}--\r\n".encode("ascii")

    def _upload(self, image: bytes, media_type: str, filename: str) -> dict[str, Any]:
        boundary = f"wfb-{uuid.uuid4().hex}"
        body = self._multipart_body(
            image=image,
            media_type=media_type,
            filename=filename,
            boundary=boundary,
        )
        request = urllib.request.Request(
            f"{self._base_url()}/files",
            data=body,
            headers={
                **self._headers(),
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(body)),
            },
            method="POST",
        )
        return self._json_request(request)

    def _remember(
        self, digest: str, reference: OffloadedMediaReference
    ) -> OffloadedMediaReference:
        max_cache = _env_int("DAPR_AGENT_PY_KIMI_FILE_CACHE_ENTRIES", 256, minimum=1)
        self._cache.pop(digest, None)
        self._cache[digest] = reference
        while len(self._cache) > max_cache:
            self._cache.popitem(last=False)
        return reference

    def upload_image(
        self,
        image: bytes,
        media_type: str,
        *,
        label: str | None = None,
    ) -> OffloadedMediaReference:
        del label  # Filename is content-addressed and must remain cleanup-safe.
        normalized_type = str(media_type or "").strip().lower()
        extension = _SUPPORTED_IMAGE_TYPES.get(normalized_type)
        if extension is None:
            raise ValueError(f"Kimi K3 does not support image type {media_type!r}")
        max_bytes = _env_int(
            "DAPR_AGENT_PY_KIMI_FILE_MAX_IMAGE_BYTES",
            20 * 1024 * 1024,
            minimum=1,
        )
        if not image or len(image) > max_bytes:
            raise ValueError(
                f"Image size {len(image)} bytes is outside the configured 1-{max_bytes} byte range"
            )

        digest = hashlib.sha256(image).hexdigest()
        filename = f"{_MANAGED_FILE_PREFIX}{digest}{extension}"
        with self._lock:
            cached = self._cache.get(digest)
            if cached is not None:
                self._cache.move_to_end(digest)
                return cached

            files = self._list_managed_files()
            deleted = self._reap_stale(files)
            for item in files:
                file_id = str(item.get("id") or "").strip()
                if (
                    file_id
                    and file_id not in deleted
                    and item.get("filename") == filename
                    and str(item.get("status") or "ready").lower()
                    in _READY_FILE_STATUSES
                ):
                    return self._remember(
                        digest,
                        OffloadedMediaReference(
                            uri=f"ms://{file_id}",
                            provider="kimi-files",
                            file_id=file_id,
                            media_type=normalized_type,
                            size_bytes=len(image),
                            sha256=digest,
                        ),
                    )

            payload = self._upload(image, normalized_type, filename)
            file_id = str(payload.get("id") or "").strip()
            status = str(payload.get("status") or "ready").lower()
            if not file_id or status not in _READY_FILE_STATUSES:
                raise RuntimeError(
                    "Kimi Files API did not return a ready image file reference "
                    f"(status={status or 'missing'})"
                )
            reference = OffloadedMediaReference(
                uri=f"ms://{file_id}",
                provider="kimi-files",
                file_id=file_id,
                media_type=normalized_type,
                size_bytes=len(image),
                sha256=digest,
            )
            logger.info(
                "[multimodal-media] uploaded image to Kimi Files id=%s bytes=%d type=%s",
                file_id,
                len(image),
                normalized_type,
            )
            return self._remember(digest, reference)


__all__ = ["KimiFilesMultimodalMediaAdapter"]
