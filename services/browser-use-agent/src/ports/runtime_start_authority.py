"""Application port for authorizing a durable session runtime start."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class RuntimeStartAuthorityRequest:
    session_id: str
    session_token: str
    runtime_app_id: str
    runtime_instance_id: str


@dataclass(frozen=True)
class RuntimeStartAuthorityDecision:
    authorized: bool
    status: int = 200
    code: str = ""
    retryable: bool = False
    reason: str = ""

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {"authorized": self.authorized}
        if not self.authorized:
            result.update(
                {
                    "status": self.status,
                    "code": self.code,
                    "retryable": self.retryable,
                    "reason": self.reason,
                }
            )
        return result


class RuntimeStartAuthorityPort(Protocol):
    """Revalidate the persisted session/runtime generation before agent work."""

    def authorize(
        self, request: RuntimeStartAuthorityRequest
    ) -> RuntimeStartAuthorityDecision: ...
