"""Async NDJSON Unix-socket client for the herdr server (https://herdr.dev).

Protocol: one JSON request per line ``{"id": "...", "method": "...", "params": {...}}``;
the response line with the matching ``id`` carries ``{"result": {...}}`` or
``{"error": {"code": ..., "message": ...}}``. ``events.subscribe`` is long-lived:
after the ack, the server keeps streaming NDJSON event objects on the SAME
connection — implemented here as an async generator on its OWN connection.

DEFENSIVE BY DESIGN: herdr is v0.6.x and field-level params/results are not
fully documented upstream. Every method/param/event name lives in the constants
block below, every call funnels through the single choke point ``_call``, and
result parsing is tolerant (``pick`` / ``pane_id_of`` / ``agent_status_of``).
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import os
from typing import Any, AsyncIterator, Mapping

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Method / param / event constants.
#
# VERIFIED against a LIVE herdr 0.6.8 socket (protocol 13) on 2026-06-10 by an
# isolated smoke server (`HERDR_SOCKET_PATH=… herdr server` + raw NDJSON
# probes). Verified facts this module relies on:
#   * There is NO `pane.run` socket method (the CLI's `herdr pane run` is
#     sugar). The launch method is `agent.start {name, argv, cwd?, env?}` →
#     `{type:"agent_started", agent:{terminal_id, name, agent_status,
#     workspace_id, tab_id, pane_id, focused, cwd, revision}}`. It creates its
#     own workspace/pane — no prior `workspace.create` needed.
#   * `agent.get` takes `target` (terminal id | unique agent name | detected/
#     reported label | pane id) → `{type:"agent_info", agent:{…, agent?,
#     agent_status}}`. `agent_status` is `unknown` until detection/report.
#   * `events.subscribe` REQUIRES `subscriptions: [Subscription]` (internally
#     tagged enum). Global variants (no extra fields): `pane.created`,
#     `pane.closed`, `pane.exited`, `pane.agent_detected`, workspace/tab CRUD.
#     Pane-scoped variants (require a concrete `pane_id`; no wildcard):
#     `pane.agent_status_changed`, `pane.output_matched`. Ack line:
#     `{"id":<rid>,"result":{"type":"subscription_started"}}`; per-subscription
#     errors may echo a SUFFIXED id (`<rid>:sub:<i>:probe`). Streamed lines:
#     `{"event":"pane.agent_status_changed","data":{agent, agent_status,
#     pane_id, workspace_id}}` and `{"event":"pane_exited","data":{pane_id,
#     workspace_id}}` — NOTE the underscore form (`pane_exited`), an upstream
#     naming inconsistency; no exit code is carried.
#   * Malformed-request errors echo `"id": ""` (NOT the request id) — see the
#     singleton-pending fallback in `_read_loop`.
#   * `pane.read` requires `source` (visible|recent|recent-unwrapped).
#   * `pane.report_agent {pane_id, source, agent, state, message?}` works and
#     feeds `agent_status` / `pane.agent_status_changed`.
#   * Attaching from INSIDE a herdr pane is refused ("nested herdr is
#     disabled by default") — the terminal WS endpoint must spawn the attach
#     client with all inherited HERDR_* vars stripped except HERDR_SOCKET_PATH.
# ---------------------------------------------------------------------------
METHOD_PING = "ping"
METHOD_WORKSPACE_CREATE = "workspace.create"
METHOD_AGENT_START = "agent.start"  # the verified pane-launch method
METHOD_PANE_SEND_TEXT = "pane.send_text"
METHOD_PANE_SEND_KEYS = "pane.send_keys"
METHOD_PANE_READ = "pane.read"  # params: pane_id, source (REQUIRED), lines
METHOD_PANE_CLOSE = "pane.close"
METHOD_AGENT_GET = "agent.get"  # params: target
METHOD_AGENT_LIST = "agent.list"
METHOD_AGENT_SEND = "agent.send"  # alternative for user-text injection
METHOD_EVENTS_SUBSCRIBE = "events.subscribe"
METHOD_NOTIFICATION_SHOW = "notification.show"  # params: title (req), body

# Subscription variants (events.subscribe `subscriptions[].type`).
SUB_PANE_CREATED = "pane.created"
SUB_PANE_CLOSED = "pane.closed"
SUB_PANE_EXITED = "pane.exited"
SUB_PANE_AGENT_DETECTED = "pane.agent_detected"
SUB_PANE_AGENT_STATUS_CHANGED = "pane.agent_status_changed"  # pane-scoped

# Streamed event names (the `event` field of streamed lines).
EVENT_AGENT_STATUS_CHANGED = "pane.agent_status_changed"
EVENT_PANE_EXITED = "pane_exited"  # sic — underscore form on the stream
EVENT_PANE_CLOSED = "pane.closed"

# Global subscriptions every supervisor stream wants; the pane-scoped
# `pane.agent_status_changed` is appended per registered pane.
DEFAULT_GLOBAL_SUBSCRIPTIONS: list[dict[str, Any]] = [
    {"type": SUB_PANE_CREATED},
    {"type": SUB_PANE_CLOSED},
    {"type": SUB_PANE_EXITED},
    {"type": SUB_PANE_AGENT_DETECTED},
]


def agent_status_subscription(pane_id: str) -> dict[str, Any]:
    return {"type": SUB_PANE_AGENT_STATUS_CHANGED, "pane_id": pane_id}


PARAM_PANE_ID = "pane_id"
PARAM_TARGET = "target"
PARAM_TEXT = "text"
PARAM_KEYS = "keys"
PARAM_SUBSCRIPTIONS = "subscriptions"

# Documented semantic agent states ("State is semantic" — herdr docs).
AGENT_STATUS_WORKING = "working"
AGENT_STATUS_IDLE = "idle"
AGENT_STATUS_BLOCKED = "blocked"
AGENT_STATUS_DONE = "done"
AGENT_STATUS_UNKNOWN = "unknown"
AGENT_STATUSES = (
    AGENT_STATUS_WORKING,
    AGENT_STATUS_IDLE,
    AGENT_STATUS_BLOCKED,
    AGENT_STATUS_DONE,
    AGENT_STATUS_UNKNOWN,
)

DEFAULT_CALL_TIMEOUT_SECONDS = float(os.environ.get("HERDR_CALL_TIMEOUT_SECONDS", "10"))


def default_socket_path() -> str:
    return os.environ.get("HERDR_SOCKET_PATH") or os.path.expanduser(
        "~/.config/herdr/herdr.sock"
    )


class HerdrError(RuntimeError):
    """Error response from the herdr server."""

    def __init__(self, code: Any, message: str):
        super().__init__(f"herdr error {code}: {message}")
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# Tolerant result parsing helpers
# ---------------------------------------------------------------------------


def pick(mapping: Any, *keys: str, default: Any = None) -> Any:
    """Return the first non-None value among ``keys`` in ``mapping``."""
    if not isinstance(mapping, Mapping):
        return default
    for key in keys:
        value = mapping.get(key)
        if value is not None:
            return value
    return default


def pane_id_of(obj: Any) -> str | None:
    """Extract a pane reference from a result/event, tolerating field renames."""
    if not isinstance(obj, Mapping):
        return None
    direct = pick(obj, "pane_id", "paneId", "pane", "id")
    if isinstance(direct, Mapping):
        direct = pick(direct, "pane_id", "paneId", "id")
    if direct is not None:
        return str(direct)
    # "agent" covers agent.start/agent.get results ({type, agent: {pane_id}}).
    nested = (
        obj.get("result") or obj.get("data") or obj.get("payload") or obj.get("agent")
    )
    if isinstance(nested, Mapping):
        return pane_id_of(nested)
    return None


def agent_status_of(obj: Any) -> str | None:
    """Extract the semantic agent state (working|idle|blocked|done|unknown)."""
    if not isinstance(obj, Mapping):
        return None
    for key in ("agent_status", "agentStatus", "status", "state"):
        value = obj.get(key)
        if isinstance(value, str) and value.strip().lower() in AGENT_STATUSES:
            return value.strip().lower()
    for key in ("agent", "data", "payload", "result", "agent_session"):
        nested = obj.get(key)
        if isinstance(nested, Mapping):
            status = agent_status_of(nested)
            if status:
                return status
    return None


def status_detail_of(obj: Any) -> str | None:
    """Extract herdr's explain/detail string for a blocked state, if present."""
    if not isinstance(obj, Mapping):
        return None
    for key in ("explain", "detail", "reason", "message", "agent_status_detail"):
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for key in ("agent", "data", "payload", "result"):
        nested = obj.get(key)
        if isinstance(nested, Mapping):
            detail = status_detail_of(nested)
            if detail:
                return detail
    return None


def _retrieve_future_exception(fut: "asyncio.Future") -> None:
    """Done-callback that consumes a pending-request future's exception.

    When the herdr socket closes mid-flight, ``_fail_pending`` sets a
    ConnectionError on every pending future. If the awaiting ``_call`` was
    already cancelled/abandoned (e.g. its turn was torn down), nobody retrieves
    that exception and asyncio floods the log with "Future exception was never
    retrieved" (observed 57x on a flaky herdr socket). Retrieving it here marks
    it consumed without hiding anything — a live awaiter still gets the error via
    ``await``. herdr failures are already benign: ``_call`` reconnects-once and
    the supervisor restarts herdr, and turn-completion no longer depends on herdr
    (transcript-JSONL completion is the authoritative path).
    """
    if fut.cancelled():
        return
    try:
        fut.exception()
    except Exception:  # noqa: BLE001
        pass


class HerdrClient:
    """Request/response NDJSON client with reconnect-on-broken-socket."""

    def __init__(
        self,
        socket_path: str | None = None,
        *,
        call_timeout: float = DEFAULT_CALL_TIMEOUT_SECONDS,
    ):
        self._socket_path = socket_path or default_socket_path()
        self._call_timeout = call_timeout
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._read_task: asyncio.Task | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._req_counter = itertools.count(1)
        self._conn_lock = asyncio.Lock()

    @property
    def socket_path(self) -> str:
        return self._socket_path

    # -- connection management ---------------------------------------------

    async def _ensure_connected(self) -> None:
        async with self._conn_lock:
            if self._writer is not None and not self._writer.is_closing():
                return
            self._reset_connection_locked()
            self._reader, self._writer = await asyncio.open_unix_connection(
                self._socket_path
            )
            self._read_task = asyncio.ensure_future(self._read_loop(self._reader))

    def _reset_connection_locked(self) -> None:
        if self._read_task is not None:
            self._read_task.cancel()
            self._read_task = None
        if self._writer is not None:
            try:
                self._writer.close()
            except Exception:  # noqa: BLE001
                pass
            self._writer = None
        self._reader = None
        self._fail_pending(ConnectionError("herdr socket connection reset"))

    async def _reset_connection(self) -> None:
        async with self._conn_lock:
            self._reset_connection_locked()

    def _fail_pending(self, exc: Exception) -> None:
        pending, self._pending = self._pending, {}
        for future in pending.values():
            if not future.done():
                future.set_exception(exc)

    async def _read_loop(self, reader: asyncio.StreamReader) -> None:
        try:
            while True:
                line = await reader.readline()
                if not line:
                    raise ConnectionError("herdr socket closed by server")
                obj = _parse_line(line)
                if obj is None:
                    continue
                rid = obj.get("id")
                future = self._pending.pop(str(rid), None) if rid is not None else None
                if future is None and obj.get("error") and len(self._pending) == 1:
                    # VERIFIED: malformed-request errors echo `"id": ""` instead
                    # of the request id. With one in-flight request we can still
                    # correlate; otherwise the caller times out (logged below).
                    _, future = self._pending.popitem()
                if future is not None and not future.done():
                    future.set_result(obj)
                elif obj.get("error"):
                    logger.warning(
                        "[herdr] uncorrelatable error response (id=%r): %s",
                        rid,
                        str(obj.get("error"))[:200],
                    )
                # Unsolicited objects on the request connection (e.g. stray
                # events) are tolerated and dropped — subscriptions use their
                # own connection via subscribe_events().
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self._fail_pending(
                exc if isinstance(exc, ConnectionError) else ConnectionError(str(exc))
            )

    async def close(self) -> None:
        await self._reset_connection()

    # -- single choke point ---------------------------------------------------

    async def _call(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Send one request, await the matching response. Reconnects + retries
        ONCE on a broken socket; timeouts propagate as ``asyncio.TimeoutError``."""
        effective_timeout = timeout if timeout is not None else self._call_timeout
        last_exc: Exception | None = None
        for attempt in (0, 1):
            rid: str | None = None
            future: asyncio.Future | None = None
            try:
                await self._ensure_connected()
                rid = f"req_{next(self._req_counter)}"
                future = asyncio.get_running_loop().create_future()
                future.add_done_callback(_retrieve_future_exception)
                self._pending[rid] = future
                request = {"id": rid, "method": method, "params": dict(params or {})}
                assert self._writer is not None
                self._writer.write(json.dumps(request).encode("utf-8") + b"\n")
                await self._writer.drain()
                response = await asyncio.wait_for(future, timeout=effective_timeout)
            except asyncio.TimeoutError:
                if rid is not None:
                    self._pending.pop(rid, None)
                if future is not None and not future.done():
                    future.cancel()
                raise
            except (ConnectionError, BrokenPipeError, OSError) as exc:
                if rid is not None:
                    self._pending.pop(rid, None)
                if future is not None and not future.done():
                    future.cancel()
                last_exc = exc
                await self._reset_connection()
                if attempt == 1:
                    raise
                continue
            error = response.get("error")
            if error:
                if isinstance(error, Mapping):
                    raise HerdrError(error.get("code"), str(error.get("message") or error))
                raise HerdrError(None, str(error))
            result = response.get("result")
            return dict(result) if isinstance(result, Mapping) else {}
        raise last_exc or ConnectionError("herdr call failed")

    # -- convenience wrappers (tolerant param shapes) -------------------------

    async def ping(self, *, timeout: float | None = None) -> dict[str, Any]:
        return await self._call(METHOD_PING, timeout=timeout)

    async def workspace_create(self, **params: Any) -> dict[str, Any]:
        return await self._call(METHOD_WORKSPACE_CREATE, params)

    async def agent_start(
        self,
        *,
        name: str,
        argv: list[str],
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        """VERIFIED launch method: creates a workspace/pane and runs ``argv``.

        Returns ``{type: "agent_started", agent: {pane_id, terminal_id, …}}``
        (use ``pane_id_of`` on the result).
        """
        params: dict[str, Any] = {"name": name, "argv": list(argv), **extra}
        if cwd:
            params["cwd"] = cwd
        if env:
            params["env"] = dict(env)
        return await self._call(METHOD_AGENT_START, params)

    async def pane_send_text(self, pane_id: str, text: str) -> dict[str, Any]:
        return await self._call(
            METHOD_PANE_SEND_TEXT, {PARAM_PANE_ID: pane_id, PARAM_TEXT: text}
        )

    async def pane_send_keys(self, pane_id: str, keys: list[str]) -> dict[str, Any]:
        return await self._call(
            METHOD_PANE_SEND_KEYS, {PARAM_PANE_ID: pane_id, PARAM_KEYS: list(keys)}
        )

    async def pane_submit_enter(self, pane_id: str) -> dict[str, Any]:
        """Press Enter in a pane. The ``keys`` param name follows the CLI's
        ``pane send-keys`` plural (unprobed); falls back to a literal CR via
        ``pane.send_text`` if the server rejects the shape."""
        try:
            return await self.pane_send_keys(pane_id, ["Enter"])
        except HerdrError as exc:
            logger.debug("[herdr] send_keys Enter rejected (%s); CR fallback", exc)
            return await self.pane_send_text(pane_id, "\r")

    async def pane_read(
        self, pane_id: str, *, source: str = "recent", lines: int | None = None
    ) -> dict[str, Any]:
        params: dict[str, Any] = {PARAM_PANE_ID: pane_id, "source": source}
        if lines is not None:
            params["lines"] = lines
        return await self._call(METHOD_PANE_READ, params)

    async def pane_close(self, pane_id: str) -> dict[str, Any]:
        return await self._call(METHOD_PANE_CLOSE, {PARAM_PANE_ID: pane_id})

    async def agent_get(self, target: str | None = None, **extra: Any) -> dict[str, Any]:
        """``target`` accepts terminal ids, unique agent names, detected/
        reported labels, and pane ids (VERIFIED param name)."""
        params: dict[str, Any] = dict(extra)
        if target:
            params[PARAM_TARGET] = target
        return await self._call(METHOD_AGENT_GET, params)

    async def agent_list(self) -> dict[str, Any]:
        return await self._call(METHOD_AGENT_LIST)

    async def notification_show(self, title: str, body: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"title": title}
        if body:
            params["body"] = body
        return await self._call(METHOD_NOTIFICATION_SHOW, params)

    # -- event subscription ----------------------------------------------------

    async def subscribe_events(
        self,
        subscriptions: list[dict[str, Any]] | None = None,
        *,
        ack_timeout: float | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Long-lived event stream on its OWN connection.

        Sends ``events.subscribe`` and yields each subsequent NDJSON event
        object. ``subscriptions`` is REQUIRED by the server (defaults to the
        global pane lifecycle set). The ack line is
        ``{"id": <rid>, "result": {"type": "subscription_started"}}``; error
        acks may echo a SUFFIXED id (``<rid>:sub:<i>:probe``) — both raise
        HerdrError. Connection loss raises ConnectionError — the caller (the
        session supervisor) reconnects with backoff.
        """
        reader, writer = await asyncio.open_unix_connection(self._socket_path)
        rid = f"sub_{next(self._req_counter)}"
        effective_subs = (
            list(subscriptions)
            if subscriptions
            else [dict(s) for s in DEFAULT_GLOBAL_SUBSCRIPTIONS]
        )
        request: dict[str, Any] = {
            "id": rid,
            "method": METHOD_EVENTS_SUBSCRIBE,
            "params": {PARAM_SUBSCRIPTIONS: effective_subs},
        }
        try:
            writer.write(json.dumps(request).encode("utf-8") + b"\n")
            await writer.drain()
            ack_deadline = ack_timeout if ack_timeout is not None else self._call_timeout
            acked = False
            while True:
                if not acked:
                    line = await asyncio.wait_for(reader.readline(), timeout=ack_deadline)
                else:
                    line = await reader.readline()
                if not line:
                    raise ConnectionError("herdr event stream closed by server")
                obj = _parse_line(line)
                if obj is None:
                    continue
                obj_id = str(obj.get("id") or "")
                if not acked and (obj_id == rid or obj_id.startswith(f"{rid}:")):
                    error = obj.get("error")
                    if error:
                        if isinstance(error, Mapping):
                            raise HerdrError(
                                error.get("code"), str(error.get("message") or error)
                            )
                        raise HerdrError(None, str(error))
                    acked = True
                    continue
                yield obj
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass


def _parse_line(line: bytes) -> dict[str, Any] | None:
    text = line.decode("utf-8", errors="replace").strip()
    if not text:
        return None
    try:
        obj = json.loads(text)
    except (TypeError, ValueError):
        logger.debug("[herdr] dropping unparseable line: %s", text[:200])
        return None
    return obj if isinstance(obj, dict) else None
