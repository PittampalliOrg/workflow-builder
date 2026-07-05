"""A4 preview lifecycle: touch/last-active, sleep/resume, TTL teardown, capacity
eviction + the D1 origin/prNumber/ttlHours contract. Fake k8s clients mirror the
test_vcluster_pool.py pattern (which mirrors test_app.py)."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

import src.app as app_module
from src.app import (
    PreviewMember,
    VclusterPreviewClaimRequest,
    VclusterPreviewRequest,
)

NOW = datetime(2026, 7, 4, 12, 0, 0, tzinfo=UTC)


class _ApiExc(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"api status {status}")
        self.status = status


def _ns(
    real_name: str,
    *,
    pool: str | None = None,
    alias: str | None = None,
    state: str | None = None,
    origin: str | None = None,
    pr: str | None = None,
    protected: bool = False,
    last_active: datetime | None = None,
    expires_at: datetime | None = None,
    pins: str | None = None,
    phase: str = "Active",
    rv: str = "1",
    created: datetime | None = None,
    app_label: str = "vcluster-preview",
):
    labels = {"app": app_label, "vcluster-preview-name": real_name}
    if pool is not None:
        labels["vcluster-preview-pool"] = pool
    if alias is not None:
        labels["vcluster-preview-alias"] = alias
    if state is not None:
        labels["vcluster-preview-state"] = state
    if origin is not None:
        labels["vcluster-preview-origin"] = origin
    if pr is not None:
        labels["vcluster-preview-pr"] = pr
    if protected:
        labels["vcluster-preview-protected"] = "true"
    annotations = {}
    if pins is not None:
        annotations["vcluster-preview-image-pins"] = pins
    if last_active is not None:
        annotations["vcluster-preview-last-active"] = last_active.isoformat()
    if expires_at is not None:
        annotations["vcluster-preview-expires-at"] = expires_at.isoformat()
    meta = SimpleNamespace(
        name=f"vcluster-{real_name}",
        labels=labels,
        annotations=annotations,
        resource_version=rv,
        creation_timestamp=created or NOW,
    )
    return SimpleNamespace(metadata=meta, status=SimpleNamespace(phase=phase))


def _member(
    name: str = "m",
    *,
    pool_state: str | None = None,
    slept: bool = False,
    origin: str | None = None,
    pr_number: int | None = None,
    protected: bool = False,
    terminating: bool = False,
    created_at: datetime | None = None,
    last_active: datetime | None = None,
    expires_at: datetime | None = None,
) -> PreviewMember:
    return PreviewMember(
        real_name=name,
        ns_name=f"vcluster-{name}",
        pool_state=pool_state,
        slept=slept,
        origin=origin,
        pr_number=pr_number,
        protected=protected,
        terminating=terminating,
        created_at=created_at or NOW - timedelta(hours=1),
        last_active=last_active,
        expires_at=expires_at,
    )


def _sel_match(ns, selector: str | None) -> bool:
    if not selector:
        return True
    key, _, value = selector.partition("=")
    return (ns.metadata.labels or {}).get(key) == value


class _FakeCore:
    def __init__(self, namespaces) -> None:
        self._ns = {n.metadata.name: n for n in namespaces}
        self.replaced: list = []
        self.patched: list = []
        self.patch_fail: set[str] = set()

    def list_namespace(self, label_selector=None):
        items = [n for n in self._ns.values() if _sel_match(n, label_selector)]
        return SimpleNamespace(items=items)

    def replace_namespace(self, name, body):
        self._ns[name] = body
        self.replaced.append((name, body))
        return body

    def patch_namespace(self, name, body):
        if name in self.patch_fail:
            raise _ApiExc(500)
        self.patched.append((name, body))
        meta = body.get("metadata", {})
        self._ns[name].metadata.labels.update(meta.get("labels") or {})
        self._ns[name].metadata.annotations.update(meta.get("annotations") or {})
        return self._ns[name]

    def read_namespace(self, name):
        if name not in self._ns:
            raise _ApiExc(404)
        return self._ns[name]


def _job(name: str, action: str, active: int = 1):
    return SimpleNamespace(
        metadata=SimpleNamespace(
            name=name,
            labels={
                "app": "vcluster-preview",
                "vcluster-preview-name": name.split("-", 2)[-1],
                "vcluster-preview-action": action,
            },
        ),
        status=SimpleNamespace(active=active),
    )


class _FakeBatch:
    def __init__(self, jobs=None) -> None:
        self.created: list = []
        self.jobs = list(jobs or [])
        self.create_fail = False

    def delete_namespaced_job(self, name, namespace, propagation_policy=None):
        raise _ApiExc(404)

    def read_namespaced_job(self, name, namespace):
        raise _ApiExc(404)

    def create_namespaced_job(self, namespace, body):
        if self.create_fail:
            raise _ApiExc(500)
        self.created.append(body)

    def list_namespaced_job(self, namespace, label_selector=None):
        return SimpleNamespace(items=self.jobs)


def _env(entries) -> dict[str, str]:
    return {e["name"]: e["value"] for e in entries}


def _job_env(manifest) -> dict[str, str]:
    return _env(manifest["spec"]["template"]["spec"]["containers"][0]["env"])


def _created_actions(batch) -> list[tuple[str, str]]:
    return [
        (
            m["metadata"]["labels"]["vcluster-preview-name"],
            m["metadata"]["labels"]["vcluster-preview-action"],
        )
        for m in batch.created
    ]


def _no_auth_request():
    return SimpleNamespace(headers={})


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in (
        "VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES",
        "VCLUSTER_PREVIEW_TTL_HOURS",
        "VCLUSTER_PREVIEW_TOTAL_MAX",
        "VCLUSTER_PREVIEW_ACTIVE_MINUTES",
        "VCLUSTER_PREVIEW_POOL_SIZE",
        "VCLUSTER_PREVIEW_MAX",
        "SANDBOX_EXECUTION_DRY_RUN",
        "SANDBOX_EXECUTION_API_TOKEN",
        "INTERNAL_API_TOKEN",
    ):
        monkeypatch.delenv(var, raising=False)
    app_module._invalidate_previews_cache()
    yield
    app_module._invalidate_previews_cache()


# ---- _parse_rfc3339 / expiry / activity helpers -----------------------------


def test_parse_rfc3339_variants() -> None:
    assert app_module._parse_rfc3339("2026-07-04T12:00:00+00:00") == NOW
    assert app_module._parse_rfc3339("2026-07-04T12:00:00Z") == NOW
    naive = app_module._parse_rfc3339("2026-07-04T12:00:00")
    assert naive == NOW  # naive values are assumed UTC
    assert app_module._parse_rfc3339(None) is None
    assert app_module._parse_rfc3339("") is None
    assert app_module._parse_rfc3339("not-a-date") is None


def test_effective_expiry_prefers_the_sooner_marker() -> None:
    created = NOW - timedelta(hours=10)
    explicit = NOW + timedelta(hours=1)
    m = _member("a", created_at=created, expires_at=explicit)
    # Global TTL off: only the explicit marker counts.
    assert app_module._member_effective_expiry(m, ttl_hours=0) == explicit
    # Global TTL 4h: created+4h (already past) is SOONER than the explicit marker.
    assert app_module._member_effective_expiry(m, ttl_hours=4) == created + timedelta(
        hours=4
    )
    # No markers at all -> never expires.
    assert (
        app_module._member_effective_expiry(_member("b", created_at=created), ttl_hours=0)
        is None
    )


def test_member_is_expired_gating() -> None:
    old = _member("old", created_at=NOW - timedelta(hours=48))
    # Old but global TTL off and no explicit marker -> NOT expired (human-safe default).
    assert not app_module._member_is_expired(old, now=NOW, ttl_hours=0)
    assert app_module._member_is_expired(old, now=NOW, ttl_hours=24)
    explicit = _member("exp", expires_at=NOW - timedelta(minutes=1))
    # Explicit expires-at is honored even with the global flag off.
    assert app_module._member_is_expired(explicit, now=NOW, ttl_hours=0)
    future = _member("fut", expires_at=NOW + timedelta(minutes=1))
    assert not app_module._member_is_expired(future, now=NOW, ttl_hours=0)


def test_member_recently_active_window() -> None:
    fresh = _member("f", last_active=NOW - timedelta(minutes=5))
    stale = _member("s", last_active=NOW - timedelta(minutes=45))
    untracked = _member("u")
    assert app_module._member_recently_active(fresh, now=NOW, active_minutes=30)
    assert not app_module._member_recently_active(stale, now=NOW, active_minutes=30)
    assert not app_module._member_recently_active(untracked, now=NOW, active_minutes=30)


# ---- _preview_member_from_ns -------------------------------------------------


def test_preview_member_from_ns_parses_the_full_contract() -> None:
    ns = _ns(
        "pool-aa",
        pool="claimed",
        alias="demo",
        state="slept",
        origin="pr",
        pr="341",
        protected=True,
        last_active=NOW - timedelta(minutes=10),
        expires_at=NOW + timedelta(hours=2),
        created=NOW - timedelta(hours=3),
    )
    m = app_module._preview_member_from_ns(ns)
    assert m.real_name == "pool-aa"
    assert m.ns_name == "vcluster-pool-aa"
    assert m.pool_state == "claimed"
    assert m.alias == "demo"
    assert m.slept is True
    assert m.origin == "pr"
    assert m.pr_number == 341
    assert m.protected is True
    assert m.created_at == NOW - timedelta(hours=3)
    assert m.last_active == NOW - timedelta(minutes=10)
    assert m.expires_at == NOW + timedelta(hours=2)


def test_preview_member_from_ns_tolerates_garbage_pr_and_missing_fields() -> None:
    ns = _ns("plain", pr="not-a-number")
    m = app_module._preview_member_from_ns(ns)
    assert m.pr_number is None
    assert m.origin is None
    assert m.slept is False
    assert m.protected is False
    assert m.last_active is None
    assert m.expires_at is None


# ---- _select_preview_evictions (the pure selector — highest-risk logic) ------


def _selector_kwargs(**overrides):
    kwargs = dict(need=10, pool_size=2, now=NOW, ttl_hours=0, active_minutes=30)
    kwargs.update(overrides)
    return kwargs


def test_evictions_need_zero_or_negative_returns_empty() -> None:
    members = [_member("a", pool_state="free")]
    assert app_module._select_preview_evictions(members, **_selector_kwargs(need=0)) == []
    assert (
        app_module._select_preview_evictions(members, **_selector_kwargs(need=-1)) == []
    )


def test_evictions_locked_order_across_all_buckets() -> None:
    members = [
        # bucket 4: PR-origin, oldest first
        _member("pr-new", origin="pr", created_at=NOW - timedelta(hours=1)),
        _member("pr-old", origin="pr", created_at=NOW - timedelta(hours=9)),
        # bucket 3: expired claimed (explicit marker)
        _member(
            "expired",
            pool_state="claimed",
            origin="user",
            expires_at=NOW - timedelta(hours=1),
        ),
        # bucket 2: free-hot surplus (3 free hot, pool_size=2 -> oldest 1 evictable)
        _member("free-hot-old", pool_state="free", created_at=NOW - timedelta(hours=8)),
        _member("free-hot-mid", pool_state="free", created_at=NOW - timedelta(hours=4)),
        _member("free-hot-new", pool_state="free", created_at=NOW - timedelta(hours=2)),
        # bucket 1: free-slept
        _member("free-slept", pool_state="free", slept=True),
        # never: human non-expired
        _member("human", origin="user"),
        _member("legacy"),
    ]
    picked = app_module._select_preview_evictions(members, **_selector_kwargs())
    assert [m.real_name for m in picked] == [
        "free-slept",
        "free-hot-old",
        "expired",
        "pr-old",
        "pr-new",
    ]


def test_evictions_need_caps_the_result() -> None:
    members = [
        _member("free-slept", pool_state="free", slept=True),
        _member("pr", origin="pr"),
    ]
    picked = app_module._select_preview_evictions(members, **_selector_kwargs(need=1))
    assert [m.real_name for m in picked] == ["free-slept"]


def test_evictions_keep_pool_size_free_hot_members() -> None:
    members = [
        _member("f1", pool_state="free", created_at=NOW - timedelta(hours=3)),
        _member("f2", pool_state="free", created_at=NOW - timedelta(hours=2)),
    ]
    # 2 free hot members, pool_size=2 -> no surplus, nothing evictable.
    assert app_module._select_preview_evictions(members, **_selector_kwargs()) == []
    # pool_size=0 -> both are surplus, oldest first.
    picked = app_module._select_preview_evictions(
        members, **_selector_kwargs(pool_size=0)
    )
    assert [m.real_name for m in picked] == ["f1", "f2"]


def test_evictions_never_pick_protected_terminating_recycling_or_active() -> None:
    members = [
        _member("protected", pool_state="free", slept=True, protected=True),
        _member("terminating", origin="pr", terminating=True),
        _member("recycling", pool_state="recycling", origin="pr"),
        _member(
            "active-pr",
            origin="pr",
            last_active=NOW - timedelta(minutes=5),
        ),
        _member(
            "active-expired",
            origin="user",
            expires_at=NOW - timedelta(hours=1),
            last_active=NOW - timedelta(minutes=5),
        ),
    ]
    assert app_module._select_preview_evictions(members, **_selector_kwargs()) == []


def test_evictions_never_pick_human_non_expired() -> None:
    members = [
        _member("human-user", origin="user"),
        _member("legacy-no-origin"),
        _member("human-claimed", pool_state="claimed", origin="user"),
    ]
    assert app_module._select_preview_evictions(members, **_selector_kwargs()) == []


def test_evictions_pick_expired_humans_and_sort_by_expiry() -> None:
    members = [
        _member("late", origin="user", expires_at=NOW - timedelta(minutes=5)),
        _member("early", expires_at=NOW - timedelta(hours=5)),
    ]
    picked = app_module._select_preview_evictions(members, **_selector_kwargs())
    assert [m.real_name for m in picked] == ["early", "late"]


def test_evictions_global_ttl_expires_by_creation_age() -> None:
    members = [_member("aged", origin="user", created_at=NOW - timedelta(hours=48))]
    assert app_module._select_preview_evictions(members, **_selector_kwargs()) == []
    picked = app_module._select_preview_evictions(
        members, **_selector_kwargs(ttl_hours=24)
    )
    assert [m.real_name for m in picked] == ["aged"]


def test_evictions_expired_pr_lands_in_the_expired_bucket_not_twice() -> None:
    members = [
        _member("pr-expired", origin="pr", expires_at=NOW - timedelta(hours=1)),
        _member("pr-live", origin="pr", created_at=NOW - timedelta(hours=2)),
    ]
    picked = app_module._select_preview_evictions(members, **_selector_kwargs())
    assert [m.real_name for m in picked] == ["pr-expired", "pr-live"]


# ---- job manifest D1/A4 passthrough ------------------------------------------


def test_up_job_manifest_stamps_d1_env() -> None:
    m = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(
            name="prv", action="up", origin="pr", prNumber=341, ttlHours=24
        ),
        namespace="workflow-builder",
    )
    env = _job_env(m)
    assert env["ORIGIN"] == "pr"
    assert env["PR_NUMBER"] == "341"
    expires = app_module._parse_rfc3339(env["EXPIRES_AT"])
    assert expires is not None
    delta = expires - datetime.now(UTC)
    assert timedelta(hours=23) < delta < timedelta(hours=25)


def test_up_job_manifest_omits_d1_env_by_default_and_rejects_bad_origin() -> None:
    m = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="up"), namespace="workflow-builder"
    )
    env = _job_env(m)
    assert "ORIGIN" not in env and "PR_NUMBER" not in env and "EXPIRES_AT" not in env
    m2 = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="up", origin="bogus", ttlHours=0),
        namespace="workflow-builder",
    )
    env2 = _job_env(m2)
    assert "ORIGIN" not in env2 and "EXPIRES_AT" not in env2


def test_sleep_and_resume_job_deadlines() -> None:
    sleep = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="sleep"), namespace="workflow-builder"
    )
    resume = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="resume"), namespace="workflow-builder"
    )
    up = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="up"), namespace="workflow-builder"
    )
    assert sleep["spec"]["activeDeadlineSeconds"] == 600
    assert resume["spec"]["activeDeadlineSeconds"] == 900
    assert up["spec"]["activeDeadlineSeconds"] == 1800
    assert _job_env(sleep)["ACTION"] == "sleep"
    assert _job_env(resume)["ACTION"] == "resume"


# ---- claim: D1 stamping + slept re-claim --------------------------------------


def test_claim_free_member_stamps_d1_contract_atomically() -> None:
    core = _FakeCore([_ns("pool-aa", pool="free")])
    got = app_module._claim_free_member(
        core,
        alias="pr-341",
        claim_user="bot",
        origin="pr",
        pr_number=341,
        ttl_hours=24,
    )
    assert got == "pool-aa"
    assert len(core.replaced) == 1  # ONE atomic replace carries everything
    _, body = core.replaced[0]
    labels = body.metadata.labels
    ann = body.metadata.annotations
    assert labels["vcluster-preview-pool"] == "claimed"
    assert labels["vcluster-preview-alias"] == "pr-341"
    assert labels["vcluster-preview-origin"] == "pr"
    assert labels["vcluster-preview-pr"] == "341"
    assert ann["vcluster-preview-claimed-by"] == "bot"
    assert app_module._parse_rfc3339(ann["vcluster-preview-last-active"]) is not None
    expires = app_module._parse_rfc3339(ann["vcluster-preview-expires-at"])
    assert expires is not None
    assert timedelta(hours=23) < (expires - datetime.now(UTC)) < timedelta(hours=25)


def test_claim_free_member_without_d1_fields_stamps_only_last_active() -> None:
    core = _FakeCore([_ns("pool-aa", pool="free")])
    got = app_module._claim_free_member(core, alias="demo", claim_user="me")
    assert got == "pool-aa"
    _, body = core.replaced[0]
    assert "vcluster-preview-origin" not in body.metadata.labels
    assert "vcluster-preview-pr" not in body.metadata.labels
    assert "vcluster-preview-expires-at" not in body.metadata.annotations
    assert "vcluster-preview-last-active" in body.metadata.annotations


def test_claim_skips_slept_free_members() -> None:
    core = _FakeCore([_ns("pool-aa", pool="free", state="slept")])
    assert app_module._claim_free_member(core, alias="demo", claim_user="me") is None


def test_claim_endpoint_resumes_a_slept_idempotent_reclaim(monkeypatch) -> None:
    slept = _ns("pool-aa", pool="claimed", alias="demo", state="slept")
    core = _FakeCore([slept])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    resp = app_module.claim_vcluster_preview(
        _no_auth_request(), VclusterPreviewClaimRequest(name="demo")
    )
    assert resp["status"] == "resuming"
    assert resp["action"] == "resume"
    assert resp["pool"] == "pool-aa"
    assert _created_actions(batch) == [("pool-aa", "resume")]
    # The label flipped back to hot + last-active stamped (the resume IS activity).
    assert slept.metadata.labels["vcluster-preview-state"] == "hot"
    assert "vcluster-preview-last-active" in slept.metadata.annotations


# ---- touch / sleep endpoints ---------------------------------------------------


def test_touch_stamps_last_active_on_a_hot_preview(monkeypatch) -> None:
    ns = _ns("demo")
    core = _FakeCore([ns])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    resp = app_module.touch_vcluster_preview(_no_auth_request(), "demo")
    assert resp["state"] == "hot"
    assert resp["resuming"] is False
    assert "vcluster-preview-last-active" in ns.metadata.annotations
    assert batch.created == []  # no job for a hot touch


def test_touch_resolves_an_alias_to_its_pool_member(monkeypatch) -> None:
    ns = _ns("pool-aa", pool="claimed", alias="demo")
    core = _FakeCore([ns])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    resp = app_module.touch_vcluster_preview(_no_auth_request(), "demo")
    assert resp["pool"] == "pool-aa"
    assert "vcluster-preview-last-active" in ns.metadata.annotations


def test_touch_resumes_a_slept_preview(monkeypatch) -> None:
    ns = _ns("demo", state="slept")
    core = _FakeCore([ns])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    resp = app_module.touch_vcluster_preview(_no_auth_request(), "demo")
    assert resp["state"] == "resuming"
    assert resp["resuming"] is True
    assert _created_actions(batch) == [("demo", "resume")]
    assert ns.metadata.labels["vcluster-preview-state"] == "hot"


def test_touch_404s_on_missing_or_non_preview_namespaces(monkeypatch) -> None:
    from fastapi import HTTPException

    core = _FakeCore([_ns("other", app_label="something-else")])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    with pytest.raises(HTTPException) as exc:
        app_module.touch_vcluster_preview(_no_auth_request(), "missing")
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:
        app_module.touch_vcluster_preview(_no_auth_request(), "other")
    assert exc.value.status_code == 404


def test_sleep_endpoint_sleeps_a_claimed_member(monkeypatch) -> None:
    ns = _ns("pool-aa", pool="claimed", alias="demo")
    core = _FakeCore([ns])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    resp = app_module.sleep_vcluster_preview(_no_auth_request(), "demo")
    assert resp["state"] == "slept"
    assert resp["pool"] == "pool-aa"
    assert _created_actions(batch) == [("pool-aa", "sleep")]
    assert ns.metadata.labels["vcluster-preview-state"] == "slept"
    assert "vcluster-preview-slept-at" in ns.metadata.annotations


def test_sleep_endpoint_refuses_free_and_protected(monkeypatch) -> None:
    from fastapi import HTTPException

    core = _FakeCore(
        [_ns("pool-bb", pool="free"), _ns("keep", protected=True)]
    )
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    with pytest.raises(HTTPException) as exc:
        app_module.sleep_vcluster_preview(_no_auth_request(), "pool-bb")
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        app_module.sleep_vcluster_preview(_no_auth_request(), "keep")
    assert exc.value.status_code == 409
    assert batch.created == []


def test_sleep_member_reverts_the_label_when_the_job_fails() -> None:
    ns = _ns("demo")
    core = _FakeCore([ns])
    batch = _FakeBatch()
    batch.create_fail = True
    member = app_module._preview_member_from_ns(ns)
    ok = app_module._sleep_member(batch, core, member, "workflow-builder")
    assert ok is False
    assert ns.metadata.labels["vcluster-preview-state"] == "hot"  # reverted


# ---- the reap pass -------------------------------------------------------------


def test_reap_is_inert_with_flags_off_and_no_markers(monkeypatch) -> None:
    core = _FakeCore(
        [
            _ns("gan-1", created=NOW - timedelta(days=90)),
            _ns("gan-2", created=NOW - timedelta(days=90)),
            _ns("pool-aa", pool="free"),
        ]
    )
    batch = _FakeBatch()
    stats = app_module._lifecycle_reap_once(batch, core)
    assert batch.created == []
    assert core.patched == []
    assert stats["total"] == 3
    assert stats["reapedExpired"] == 0
    assert stats["evicted"] == 0
    assert stats["sleptNow"] == 0


def test_reap_ttl_tears_down_explicitly_expired_previews(monkeypatch) -> None:
    expired = _ns("pr-old", origin="pr", expires_at=NOW - timedelta(hours=1))
    core = _FakeCore([expired, _ns("fresh")])
    batch = _FakeBatch()
    stats = app_module._lifecycle_reap_once(batch, core)
    assert stats["reapedExpired"] == 1
    assert _created_actions(batch) == [("pr-old", "down")]
    # Non-pool member: no recycling flip, straight down-Job with the tight deadline.
    assert core.patched == []
    assert batch.created[0]["spec"]["activeDeadlineSeconds"] == 900


def test_reap_ttl_flips_pool_members_to_recycling_first(monkeypatch) -> None:
    expired = _ns(
        "pool-aa", pool="claimed", alias="demo", expires_at=NOW - timedelta(hours=1)
    )
    core = _FakeCore([expired])
    batch = _FakeBatch()
    stats = app_module._lifecycle_reap_once(batch, core)
    assert stats["reapedExpired"] == 1
    assert expired.metadata.labels["vcluster-preview-pool"] == "recycling"
    assert _created_actions(batch) == [("pool-aa", "down")]


def test_reap_global_ttl_reaps_by_creation_age_only_when_enabled(monkeypatch) -> None:
    old = _ns("old-preview", created=NOW - timedelta(hours=48))
    core = _FakeCore([old])
    batch = _FakeBatch()
    stats = app_module._lifecycle_reap_once(batch, core)
    assert stats["reapedExpired"] == 0 and batch.created == []
    monkeypatch.setenv("VCLUSTER_PREVIEW_TTL_HOURS", "24")
    stats = app_module._lifecycle_reap_once(batch, core)
    assert stats["reapedExpired"] == 1
    assert _created_actions(batch) == [("old-preview", "down")]


def test_reap_never_touches_protected_even_when_expired(monkeypatch) -> None:
    core = _FakeCore(
        [_ns("keep", protected=True, expires_at=NOW - timedelta(hours=5))]
    )
    batch = _FakeBatch()
    stats = app_module._lifecycle_reap_once(batch, core)
    assert stats["reapedExpired"] == 0
    assert batch.created == [] and core.patched == []


def test_reap_skips_members_with_in_flight_jobs(monkeypatch) -> None:
    core = _FakeCore([_ns("busy", expires_at=NOW - timedelta(hours=1))])
    batch = _FakeBatch(jobs=[_job("vcpreview-down-busy", "down", active=1)])
    stats = app_module._lifecycle_reap_once(batch, core)
    assert stats["reapedExpired"] == 0
    assert batch.created == []


def test_reap_sleeps_idle_tracked_previews_only(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES", "60")
    idle = _ns("idle", last_active=NOW - timedelta(hours=3))
    fresh = _ns("fresh", last_active=datetime.now(UTC))
    untracked = _ns("gan-1", created=NOW - timedelta(days=30))
    free = _ns("pool-aa", pool="free", last_active=NOW - timedelta(hours=5))
    already = _ns("slept", state="slept", last_active=NOW - timedelta(hours=5))
    protected = _ns("keep", protected=True, last_active=NOW - timedelta(hours=5))
    core = _FakeCore([idle, fresh, untracked, free, already, protected])
    batch = _FakeBatch()
    stats = app_module._lifecycle_reap_once(batch, core)
    assert stats["sleptNow"] == 1
    assert _created_actions(batch) == [("idle", "sleep")]
    assert idle.metadata.labels["vcluster-preview-state"] == "slept"
    # Everyone else untouched.
    for ns in (fresh, untracked, free, protected):
        assert ns.metadata.labels.get("vcluster-preview-state") != "slept"


def test_reap_total_max_evicts_overflow_via_the_locked_order(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_TOTAL_MAX", "2")
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "1")
    surplus_free = _ns("pool-old", pool="free", created=NOW - timedelta(hours=9))
    kept_free = _ns("pool-new", pool="free", created=NOW - timedelta(hours=1))
    human = _ns("human", origin="user", created=NOW - timedelta(days=2))
    core = _FakeCore([surplus_free, kept_free, human])
    batch = _FakeBatch()
    stats = app_module._lifecycle_reap_once(batch, core)
    # Overflow of 1: the surplus free-hot member goes; the human is NEVER picked
    # (so the pass may under-deliver rather than touch it).
    assert stats["evicted"] == 1
    assert _created_actions(batch) == [("pool-old", "down")]
    assert surplus_free.metadata.labels["vcluster-preview-pool"] == "recycling"


def test_reap_need_room_evicts_on_request(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "0")
    pr = _ns("pr-1", origin="pr", pr="341", created=NOW - timedelta(hours=6))
    human = _ns("human", origin="user")
    core = _FakeCore([pr, human])
    batch = _FakeBatch()
    stats = app_module._lifecycle_reap_once(batch, core, need_room=1)
    assert stats["evicted"] == 1
    assert _created_actions(batch) == [("pr-1", "down")]


def test_reap_stats_count_awake_and_slept(monkeypatch) -> None:
    core = _FakeCore(
        [
            _ns("hot-1"),
            _ns("slept-1", state="slept"),
            _ns("gone", phase="Terminating"),
        ]
    )
    batch = _FakeBatch()
    stats = app_module._lifecycle_reap_once(batch, core)
    assert stats["total"] == 2
    assert stats["awake"] == 1
    assert stats["slept"] == 1


def test_reap_endpoint_runs_a_pass(monkeypatch) -> None:
    expired = _ns("pr-old", origin="pr", expires_at=NOW - timedelta(hours=1))
    core = _FakeCore([expired])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    stats = app_module.reap_vcluster_previews(_no_auth_request(), None)
    assert stats["reapedExpired"] == 1
    assert _created_actions(batch) == [("pr-old", "down")]


def test_reap_endpoint_need_room(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "0")
    pr = _ns("pr-1", origin="pr", created=NOW - timedelta(hours=6))
    core = _FakeCore([pr])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    stats = app_module.reap_vcluster_previews(
        _no_auth_request(), app_module.VclusterPreviewReapRequest(needRoom=1)
    )
    assert stats["evicted"] == 1


def test_reap_endpoint_dry_run_returns_zeros(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_DRY_RUN", "true")
    stats = app_module.reap_vcluster_previews(_no_auth_request(), None)
    assert stats == {
        "total": 0,
        "awake": 0,
        "slept": 0,
        "reapedExpired": 0,
        "evicted": 0,
        "sleptNow": 0,
    }


# ---- lifecycle enablement / reaper gating --------------------------------------


def test_lifecycle_enabled_gating(monkeypatch) -> None:
    assert app_module._lifecycle_enabled() is False
    monkeypatch.setenv("VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES", "30")
    assert app_module._lifecycle_enabled() is True
    monkeypatch.delenv("VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES")
    monkeypatch.setenv("VCLUSTER_PREVIEW_TTL_HOURS", "24")
    assert app_module._lifecycle_enabled() is True
    monkeypatch.delenv("VCLUSTER_PREVIEW_TTL_HOURS")
    monkeypatch.setenv("VCLUSTER_PREVIEW_TOTAL_MAX", "8")
    assert app_module._lifecycle_enabled() is True


# ---- list endpoint: counts + lifecycle fields -----------------------------------


def test_compute_previews_counts_slept_separately_and_surfaces_d1(monkeypatch) -> None:
    hot = _ns(
        "hot-1",
        origin="user",
        last_active=NOW - timedelta(minutes=5),
    )
    slept = _ns(
        "pr-1",
        origin="pr",
        pr="341",
        state="slept",
        expires_at=NOW + timedelta(hours=4),
        last_active=NOW - timedelta(hours=3),
    )
    free = _ns("pool-aa", pool="free")
    core = _FakeCore([hot, slept, free])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(
        app_module,
        "_vcluster_preview_phase",
        lambda *a, **k: ("ready", 0, 1, 0),
    )
    monkeypatch.setenv("VCLUSTER_PREVIEW_TOTAL_MAX", "8")
    result = app_module._compute_vcluster_previews()
    counts = result["counts"]
    assert counts["total"] == 3
    assert counts["slept"] == 1
    assert counts["awake"] == 2  # hot + free (slept doesn't count)
    assert counts["totalMax"] == 8
    by_name = {p["name"]: p for p in result["previews"]}
    assert set(by_name) == {"hot-1", "pr-1"}  # free member hidden as before
    assert by_name["hot-1"]["state"] == "hot"
    assert by_name["hot-1"]["origin"] == "user"
    assert by_name["hot-1"]["phase"] == "ready"
    assert by_name["pr-1"]["state"] == "slept"
    assert by_name["pr-1"]["phase"] == "slept"  # slept members are NOT probed
    assert by_name["pr-1"]["ready"] is False
    assert by_name["pr-1"]["prNumber"] == 341
    assert by_name["pr-1"]["origin"] == "pr"
    assert by_name["pr-1"]["expiresAt"] is not None
    assert by_name["pr-1"]["lastActive"] is not None


def test_pool_reconcile_awake_excludes_slept(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "1")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "2")
    # 2 non-terminating members but one is slept -> awake=1 -> room for 1 bake.
    core = _FakeCore(
        [
            _ns("slept-user", state="slept"),
            _ns("hot-user"),
        ]
    )
    batch = _FakeBatch()
    apps = SimpleNamespace()
    stats = app_module._pool_reconcile_once(batch, core, apps)
    assert stats["awake"] == 1
    assert stats["created"] == 1
