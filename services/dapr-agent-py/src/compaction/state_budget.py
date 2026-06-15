"""Pre-save byte-size guard for the durable actor state (the 16 MiB cliff).

Context compaction (``compaction/engine.py``) is **token**-triggered: a model
with a very large context window may not auto-compact until ~967K tokens, while
the durabletask gRPC channel that persists ``entry.messages`` into the Postgres
actor store is capped at 16 MiB (see ``main._configure_durabletask_grpc_defaults``).
Tool args + results are already clamped to ~12 KiB each
(``compaction/payloads.py``), but assistant / user prose is unbounded — so a
long run can drive the serialized state toward the 16 MiB cliff WITHOUT ever
crossing the token threshold that would trigger compaction.

This module adds a **byte** check that runs in the same ``call_llm`` activity
boundary, BEFORE ``save_state``: when the serialized ``entry.messages`` exceeds a
configurable budget (default 10 MiB, hard ceiling = the 16 MiB gRPC limit) it
deterministically offloads the oldest oversized message bodies (head preview +
marker, and an ``artifactRef`` when an offload sink is wired) until the document
fits, then emits a ``state_size`` telemetry field so the cliff is observable.

Invariants (match the surrounding compaction code):
  - **Pairing-safe**: only string content, ``text`` blocks and ``tool_result``
    block bodies are shrunk; ``tool_use`` blocks, message roles and
    ``tool_call_id`` linkage are never altered (so the Anthropic tool_use /
    tool_result pairing the API requires is preserved).
  - **Idempotent**: a body already carrying the offload marker is skipped, so
    re-running on activity replay is a no-op.
  - **Deterministic**: output is a pure function of the input messages + config,
    so a replayed activity rewrites identical state.
"""
from __future__ import annotations

import copy
import json
import logging
import os
from dataclasses import asdict, dataclass, field
from hashlib import sha256
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

# The durabletask gRPC channel max (see main._configure_durabletask_grpc_defaults).
GRPC_HARD_CEILING_BYTES = 16 * 1024 * 1024
# Default budget leaves headroom below the hard ceiling for the rest of the
# AgentWorkflowEntry envelope (status, metadata, etc.) plus gRPC framing.
DEFAULT_STATE_BYTE_BUDGET = 10 * 1024 * 1024

_OFFLOAD_MARKER_PREFIX = "[state-budget offload"

# Offload sink: given the original body text, persist it somewhere durable
# (e.g. the Files-API) and return a reference string embedded in the marker.
# When None, bodies are shrunk in place to a head preview + marker (no external
# I/O) — the reference is the sha256 digest carried in the marker.
OffloadSink = Callable[[str], Optional[str]]


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("[state-budget] invalid int for %s=%r; using default", name, raw)
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class StateBudgetConfig:
    """Resolved byte-budget config for the durable state guard."""

    enabled: bool = True
    budget_bytes: int = DEFAULT_STATE_BYTE_BUDGET
    hard_ceiling_bytes: int = GRPC_HARD_CEILING_BYTES
    # Never shrink the freshest messages (current turn context).
    preserve_last_n: int = 6
    # Bodies smaller than this are not worth offloading.
    min_offload_bytes: int = 4096
    # How much of an offloaded body to keep inline as a readable preview.
    head_preview_chars: int = 512

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def resolve_state_budget_config() -> StateBudgetConfig:
    budget = _env_int("DAPR_AGENT_PY_STATE_BYTE_BUDGET", DEFAULT_STATE_BYTE_BUDGET)
    ceiling = _env_int("DAPR_AGENT_PY_STATE_BYTE_HARD_CEILING", GRPC_HARD_CEILING_BYTES)
    # The budget must sit under the hard ceiling, else the guard cannot protect
    # the gRPC channel.
    budget = max(1, min(budget, ceiling))
    return StateBudgetConfig(
        enabled=_env_bool("DAPR_AGENT_PY_STATE_BYTE_GUARD_ENABLED", True),
        budget_bytes=budget,
        hard_ceiling_bytes=ceiling,
        preserve_last_n=max(0, _env_int("DAPR_AGENT_PY_STATE_PRESERVE_LAST_N", 6)),
        min_offload_bytes=max(0, _env_int("DAPR_AGENT_PY_STATE_MIN_OFFLOAD_BYTES", 4096)),
        head_preview_chars=max(0, _env_int("DAPR_AGENT_PY_STATE_HEAD_PREVIEW_CHARS", 512)),
    )


@dataclass
class StateBudgetResult:
    over_budget: bool
    pre_bytes: int
    post_bytes: int
    offloaded_count: int
    reason: str
    messages: list[Any] = field(default_factory=list)

    @property
    def state_size(self) -> int:
        """The ``state_size`` telemetry value — serialized bytes after the guard."""
        return self.post_bytes

    def to_dict(self) -> dict[str, Any]:
        return {
            "overBudget": self.over_budget,
            "preBytes": self.pre_bytes,
            "postBytes": self.post_bytes,
            "stateSizeBytes": self.post_bytes,
            "offloadedCount": self.offloaded_count,
            "reason": self.reason,
        }


# ---------------------------------------------------------------------------
# Serialization helpers (duck-typed: dicts OR pydantic-style message objects)
# ---------------------------------------------------------------------------


def _to_jsonable(message: Any) -> Any:
    if isinstance(message, dict):
        return message
    dump = getattr(message, "model_dump", None)
    if callable(dump):
        try:
            return dump()
        except Exception:  # noqa: BLE001
            pass
    return {
        "role": getattr(message, "role", ""),
        "content": getattr(message, "content", None),
    }


def _message_bytes(message: Any) -> int:
    try:
        return len(
            json.dumps(_to_jsonable(message), default=str, separators=(",", ":")).encode(
                "utf-8"
            )
        )
    except Exception:  # noqa: BLE001
        return len(str(message).encode("utf-8"))


def serialized_state_bytes(messages: list[Any]) -> int:
    """Serialized byte size of ``entry.messages`` as the actor store persists it."""
    try:
        return len(
            json.dumps(
                [_to_jsonable(m) for m in messages], default=str, separators=(",", ":")
            ).encode("utf-8")
        )
    except Exception:  # noqa: BLE001
        return sum(_message_bytes(m) for m in messages)


# ---------------------------------------------------------------------------
# Offload (pairing-safe body shrink)
# ---------------------------------------------------------------------------


def _already_offloaded(text: str) -> bool:
    return _OFFLOAD_MARKER_PREFIX in text


def _offload_marker(original_bytes: int, digest: str, ref: str | None) -> str:
    ref_part = f" ref={ref}" if ref else ""
    return f"{_OFFLOAD_MARKER_PREFIX} {original_bytes}B sha={digest}{ref_part}]"


def _shrink_text(text: str, cfg: StateBudgetConfig, offload: OffloadSink | None) -> str:
    """Return a shrunk body (head preview + marker), or the input unchanged."""
    data = text.encode("utf-8")
    original_bytes = len(data)
    if original_bytes < cfg.min_offload_bytes or _already_offloaded(text):
        return text
    digest = sha256(data).hexdigest()[:12]
    ref: str | None = None
    if offload is not None:
        try:
            ref = offload(text)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[state-budget] offload sink failed: %s", exc)
            ref = None
    head = text[: cfg.head_preview_chars]
    return f"{head}\n\n{_offload_marker(original_bytes, digest, ref)}"


def _shrink_content(content: Any, cfg: StateBudgetConfig, offload: OffloadSink | None) -> Any:
    """Pairing-safe shrink of message content.

    String content is shrunk directly. List content has its ``text`` blocks and
    ``tool_result`` block bodies shrunk while ``tool_use`` blocks are left
    untouched (so tool_use/tool_result pairing survives).
    """
    if isinstance(content, str):
        return _shrink_text(content, cfg, offload)
    if isinstance(content, list):
        out: list[Any] = []
        for block in content:
            if not isinstance(block, dict):
                out.append(block)
                continue
            btype = block.get("type")
            if btype == "text" and isinstance(block.get("text"), str):
                out.append({**block, "text": _shrink_text(block["text"], cfg, offload)})
            elif btype == "tool_result":
                inner = block.get("content")
                if isinstance(inner, str):
                    out.append({**block, "content": _shrink_text(inner, cfg, offload)})
                elif isinstance(inner, list):
                    inner_out = []
                    for ib in inner:
                        if (
                            isinstance(ib, dict)
                            and ib.get("type") == "text"
                            and isinstance(ib.get("text"), str)
                        ):
                            inner_out.append(
                                {**ib, "text": _shrink_text(ib["text"], cfg, offload)}
                            )
                        else:
                            inner_out.append(ib)
                    out.append({**block, "content": inner_out})
                else:
                    out.append(block)
            else:
                # tool_use blocks and anything else: never alter.
                out.append(block)
        return out
    return content


def _shrunk_message(
    message: Any, cfg: StateBudgetConfig, offload: OffloadSink | None
) -> tuple[Any, int]:
    """Return (possibly-new message, bytes_reclaimed). Pairing-safe; idempotent."""
    before = _message_bytes(message)
    if isinstance(message, dict):
        new_msg = copy.deepcopy(message)
        if "content" in new_msg:
            new_msg["content"] = _shrink_content(new_msg.get("content"), cfg, offload)
    else:
        content = getattr(message, "content", None)
        shrunk = _shrink_content(content, cfg, offload)
        if shrunk is content:
            return message, 0
        try:
            new_msg = message.model_copy(deep=True)  # type: ignore[attr-defined]
            new_msg.content = shrunk
        except Exception:  # noqa: BLE001
            jsonable = _to_jsonable(message)
            new_msg = {**jsonable, "content": shrunk}
    after = _message_bytes(new_msg)
    reclaimed = before - after
    if reclaimed <= 0:
        return message, 0
    return new_msg, reclaimed


def enforce_state_budget(
    messages: list[Any],
    *,
    config: StateBudgetConfig | None = None,
    offload: OffloadSink | None = None,
) -> StateBudgetResult:
    """Pure byte-budget guard over ``entry.messages``.

    Returns a result describing the (possibly reduced) message list. When the
    serialized size is within budget the input is returned unchanged. When over
    budget, the oldest oversized bodies are offloaded (oldest-first, never
    touching the last ``preserve_last_n`` messages) until the document fits.
    """
    cfg = config or resolve_state_budget_config()
    pre = serialized_state_bytes(messages)
    if not cfg.enabled:
        return StateBudgetResult(
            over_budget=False,
            pre_bytes=pre,
            post_bytes=pre,
            offloaded_count=0,
            reason="disabled",
            messages=messages,
        )
    if pre <= cfg.budget_bytes:
        return StateBudgetResult(
            over_budget=False,
            pre_bytes=pre,
            post_bytes=pre,
            offloaded_count=0,
            reason="under_budget",
            messages=messages,
        )

    out = list(messages)
    n = len(out)
    reducible_upper = max(0, n - cfg.preserve_last_n)
    offloaded = 0
    for idx in range(reducible_upper):
        if serialized_state_bytes(out) <= cfg.budget_bytes:
            break
        new_msg, reclaimed = _shrunk_message(out[idx], cfg, offload)
        if reclaimed > 0:
            out[idx] = new_msg
            offloaded += 1

    post = serialized_state_bytes(out)
    reason = "offloaded" if offloaded else "over_budget_no_reducible"
    return StateBudgetResult(
        over_budget=True,
        pre_bytes=pre,
        post_bytes=post,
        offloaded_count=offloaded,
        reason=reason,
        messages=out,
    )


# ---------------------------------------------------------------------------
# Activity-side orchestration (loads state, enforces, persists, emits telemetry)
# ---------------------------------------------------------------------------


TelemetrySink = Callable[[Optional[str], str, StateBudgetResult, StateBudgetConfig], None]


def _default_emit(
    session_id: str | None,
    instance_id: str,
    result: StateBudgetResult,
    cfg: StateBudgetConfig,
) -> None:
    # Lazy import so unit tests that don't install event_publisher still run.
    from ..event_publisher import publish_session_event

    publish_session_event(
        session_id,
        "state_size",
        {
            "stateSizeBytes": result.state_size,
            "preBytes": result.pre_bytes,
            "budgetBytes": cfg.budget_bytes,
            "hardCeilingBytes": cfg.hard_ceiling_bytes,
            "overBudget": result.over_budget,
            "offloadedCount": result.offloaded_count,
            "reason": result.reason,
        },
        instance_id=instance_id,
    )


def enforce_state_byte_budget(
    agent: Any,
    *,
    instance_id: str,
    session_id: str | None = None,
    config: StateBudgetConfig | None = None,
    offload: OffloadSink | None = None,
    emit: TelemetrySink | None = None,
) -> StateBudgetResult:
    """Load durable state, enforce the byte budget, persist if reduced, emit.

    Invoked synchronously from ``OpenShellDurableAgent.call_llm`` (the activity
    body) so the state write rides the same ETag-protected ``save_state`` path
    compaction uses. Always emits a ``state_size`` telemetry field so the cliff
    is observable even on the (common) under-budget path.
    """
    cfg = config or resolve_state_budget_config()
    entry = agent._infra.get_state(instance_id)
    messages = list(getattr(entry, "messages", []) or [])

    result = enforce_state_budget(messages, config=cfg, offload=offload)

    try:
        (emit or _default_emit)(session_id, instance_id, result, cfg)
    except Exception:  # noqa: BLE001
        pass

    if result.over_budget and result.offloaded_count > 0:
        try:
            entry.messages = result.messages
            agent.save_state(instance_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[state-budget] save_state after offload failed: %s", exc)

    return result


__all__ = [
    "GRPC_HARD_CEILING_BYTES",
    "DEFAULT_STATE_BYTE_BUDGET",
    "StateBudgetConfig",
    "StateBudgetResult",
    "resolve_state_budget_config",
    "serialized_state_bytes",
    "enforce_state_budget",
    "enforce_state_byte_budget",
]
