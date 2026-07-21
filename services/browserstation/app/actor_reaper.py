from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from typing import Optional


ActorIdentity = tuple[str, str]


def _record_value(record: object, field: str) -> object:
    if isinstance(record, Mapping):
        return record.get(field)
    return getattr(record, field, None)


def _finite_number(value: object) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _actor_identity(record: object) -> Optional[ActorIdentity]:
    namespace = _record_value(record, "ray_namespace")
    name = _record_value(record, "name")
    if not isinstance(namespace, str) or not namespace:
        return None
    if not isinstance(name, str) or not name:
        return None
    return (namespace, name)


def reconcile_actor_start_times(
    actor_records: Iterable[object],
    known_start_times: Mapping[ActorIdentity, float],
    *,
    now_monotonic: float,
    now_epoch_ms: float,
) -> dict[ActorIdentity, float]:
    """Rebuild monotonic actor start estimates from the current Ray snapshot.

    Ray versions that expose ``start_time_ms`` retain the actor's real age
    across BrowserStation restarts. Ray 2.47 falls back to first-seen time, so
    a service restart can extend cleanup by at most one fresh TTL.
    """
    reconciled: dict[ActorIdentity, float] = {}
    for record in actor_records:
        identity = _actor_identity(record)
        if identity is None or identity in reconciled:
            continue

        start_time_ms = _finite_number(_record_value(record, "start_time_ms"))
        if start_time_ms is not None and 0 < start_time_ms <= now_epoch_ms:
            age_seconds = (now_epoch_ms - start_time_ms) / 1000
            reconciled[identity] = now_monotonic - age_seconds
            continue

        known_start = _finite_number(known_start_times.get(identity))
        if known_start is not None and known_start <= now_monotonic:
            reconciled[identity] = known_start
        else:
            reconciled[identity] = now_monotonic

    return reconciled


def merge_reconciled_actor_times(
    current: dict[ActorIdentity, float],
    scan_start: Mapping[ActorIdentity, float],
    reconciled: Mapping[ActorIdentity, float],
) -> None:
    """Apply one scan without deleting entries created while it was running."""
    for identity, observed_start in scan_start.items():
        if current.get(identity) == observed_start:
            current.pop(identity, None)
    for identity, started_at in reconciled.items():
        current.setdefault(identity, started_at)


def stale_actor_ages(
    actor_start_times: Mapping[ActorIdentity, float],
    *,
    now_monotonic: float,
    ttl_seconds: float,
) -> dict[ActorIdentity, float]:
    """Return actors at or beyond the configured finite lifetime."""
    if ttl_seconds <= 0:
        return {}
    return {
        name: max(0.0, now_monotonic - started_at)
        for name, started_at in actor_start_times.items()
        if max(0.0, now_monotonic - started_at) >= ttl_seconds
    }
