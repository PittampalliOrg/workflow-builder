"""A4 preview lifecycle: touch/last-active, sleep/resume, TTL teardown, capacity
eviction + the D1 origin/prNumber/ttlHours contract. Fake k8s clients mirror the
test_vcluster_pool.py pattern (which mirrors test_app.py)."""

import json
from contextlib import nullcontext
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
CATALOG_DIGEST = app_module._preview_service_catalog().catalog_digest
CAPABILITY_BUNDLE = {
    "controlToken": "1" * 64,
    "syncToken": "2" * 64,
    "actionToken": "3" * 64,
    "sandboxToken": "4" * 64,
    "runtimeToken": "5" * 64,
    "storageToken": "6" * 64,
}


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
    lifecycle: str | None = None,
    owner_contract: dict[str, str] | None = None,
    origin_contract: dict[str, str] | None = None,
    pr: str | None = None,
    protected: bool = False,
    last_active: datetime | None = None,
    expires_at: datetime | None = None,
    pins: str | None = None,
    phase: str = "Active",
    rv: str = "1",
    created: datetime | None = None,
    app_label: str = "vcluster-preview",
    profile: str | None = None,
    mode: str | None = None,
    platform_revision: str | None = None,
    source_revision: str | None = None,
    services: list[str] | None = None,
    images: dict[str, str] | None = None,
    catalog_digest: str | None = None,
    allocation: dict[str, str] | None = None,
    trusted_code: bool | None = None,
    reconciliation_succeeded: bool = False,
    provenance: dict | None = None,
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
    if lifecycle is not None:
        annotations["preview.stacks.io/lifecycle"] = lifecycle
    if owner_contract is not None:
        annotations["preview.stacks.io/owner"] = json.dumps(owner_contract)
    if origin_contract is not None:
        annotations["preview.stacks.io/origin"] = json.dumps(origin_contract)
    if profile is not None:
        annotations["preview.stacks.io/profile"] = profile
    if mode is not None:
        annotations["preview.stacks.io/mode"] = mode
    if platform_revision is not None:
        annotations["preview.stacks.io/target-revision"] = platform_revision
    if source_revision is not None:
        annotations["preview.stacks.io/source-revision"] = source_revision
    if services is not None:
        annotations["preview.stacks.io/services"] = json.dumps(services)
    if images is not None:
        annotations["preview.stacks.io/images"] = json.dumps(images)
    if catalog_digest is not None:
        annotations["preview.stacks.io/catalog-digest"] = catalog_digest
    if allocation is not None:
        annotations["preview.stacks.io/allocation"] = json.dumps(allocation)
    if trusted_code is not None:
        annotations["preview.stacks.io/trusted-code"] = (
            "true" if trusted_code else "false"
        )
    if reconciliation_succeeded:
        annotations["preview.stacks.io/reconciliation-succeeded-at"] = (
            "2026-07-09T12:00:00Z"
        )
        if platform_revision is not None:
            annotations["preview.stacks.io/reconciliation-platform-revision"] = (
                platform_revision
            )
        if source_revision is not None:
            annotations["preview.stacks.io/reconciliation-source-revision"] = (
                source_revision
            )
    if provenance is not None:
        annotations["preview.stacks.io/provenance"] = json.dumps(provenance)
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
    lifecycle: str | None = None,
    owner_contract: dict[str, str] | None = None,
    origin_contract: dict[str, str] | None = None,
    pr_number: int | None = None,
    protected: bool = False,
    terminating: bool = False,
    created_at: datetime | None = None,
    last_active: datetime | None = None,
    expires_at: datetime | None = None,
    platform_revision: str | None = None,
    source_revision: str | None = None,
    profile: str | None = None,
    mode: str | None = None,
    owner: str | None = None,
    services: tuple[str, ...] | None = None,
    provenance: dict | None = None,
    trusted_code: bool | None = None,
    allocation: dict[str, str] | None = None,
    images: dict[str, str] | None = None,
    catalog_digest: str | None = None,
) -> PreviewMember:
    return PreviewMember(
        real_name=name,
        ns_name=f"vcluster-{name}",
        pool_state=pool_state,
        slept=slept,
        origin=origin,
        lifecycle=lifecycle,
        owner_contract=owner_contract,
        origin_contract=origin_contract,
        pr_number=pr_number,
        protected=protected,
        terminating=terminating,
        created_at=created_at or NOW - timedelta(hours=1),
        last_active=last_active,
        expires_at=expires_at,
        platform_revision=platform_revision,
        source_revision=source_revision,
        profile=profile,
        mode=mode,
        owner=owner,
        services=services,
        provenance=provenance,
        trusted_code=trusted_code,
        allocation=allocation,
        images=images,
        catalog_digest=catalog_digest,
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

    def read_namespaced_config_map(self, name, namespace):
        # No runner ConfigMap in these lifecycle scenarios → _bake_inputs_hash returns
        # None (empty data) so a reconcile never recycles here (behavior unchanged).
        return SimpleNamespace(metadata=SimpleNamespace(name=name), data={})


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


class _FakeCoordination:
    def __init__(self) -> None:
        self.leases: dict[str, SimpleNamespace] = {}
        self.deleted: list[dict] = []
        self.replaced: list[dict] = []
        self._uid_sequence = 0

    @staticmethod
    def _lease(body, resource_version: str, uid: str):
        spec = body["spec"]
        return SimpleNamespace(
            metadata=SimpleNamespace(resource_version=resource_version, uid=uid),
            spec=SimpleNamespace(
                holder_identity=spec["holderIdentity"],
                lease_duration_seconds=spec["leaseDurationSeconds"],
                acquire_time=spec["acquireTime"],
                renew_time=spec["renewTime"],
                lease_transitions=spec.get("leaseTransitions", 0),
            ),
        )

    def read_namespaced_lease(self, name, namespace):
        if name not in self.leases:
            raise _ApiExc(404)
        return self.leases[name]

    def create_namespaced_lease(self, namespace, body):
        name = body["metadata"]["name"]
        if name in self.leases:
            raise _ApiExc(409)
        self._uid_sequence += 1
        uid = f"00000000-0000-0000-0000-{self._uid_sequence:012d}"
        self.leases[name] = self._lease(body, "1", uid)
        return self.leases[name]

    def replace_namespaced_lease(self, name, namespace, body):
        current = self.read_namespaced_lease(name, namespace)
        if body["metadata"].get("resourceVersion") != current.metadata.resource_version:
            raise _ApiExc(409)
        if body["metadata"].get("uid", current.metadata.uid) != current.metadata.uid:
            raise _ApiExc(409)
        self.replaced.append(body)
        self.leases[name] = self._lease(
            body,
            str(int(current.metadata.resource_version) + 1),
            current.metadata.uid,
        )
        return self.leases[name]

    def delete_namespaced_lease(self, name, namespace, body):
        current = self.read_namespaced_lease(name, namespace)
        if body.get("preconditions", {}).get("uid") != current.metadata.uid:
            raise _ApiExc(409)
        if current.spec.holder_identity:
            raise _ApiExc(403)
        self.deleted.append(body)
        del self.leases[name]


def _env(entries) -> dict[str, str]:
    return {e["name"]: e["value"] for e in entries if "value" in e}


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
    return SimpleNamespace(headers={"authorization": "Bearer test-token"})


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
        "PREVIEW_ARCHIVE_TEARDOWN_TOKEN",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("SANDBOX_EXECUTION_API_TOKEN", "test-token")
    coordination = _FakeCoordination()
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )
    monkeypatch.setattr(
        app_module,
        "_submit_preview_job",
        lambda batch, _core, *, namespace, manifest, create_only=False, **_kwargs: (
            app_module._create_preview_job(
                batch,
                namespace=namespace,
                manifest=manifest,
                create_only=create_only,
            )
        ),
    )
    monkeypatch.setattr(
        app_module.PreviewRunnerIdentityAdapter,
        "is_absent",
        lambda _self, **_kwargs: True,
    )
    monkeypatch.setattr(app_module, "_load_k8s_rbac_client", lambda: SimpleNamespace())
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
        app_module._member_effective_expiry(
            _member("b", created_at=created), ttl_hours=0
        )
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
    platform = "a" * 40
    source = "b" * 40
    image = "ghcr.io/pittampalliorg/workflow-builder@sha256:" + "c" * 64
    catalog = "sha256:" + "d" * 64
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
    ns.metadata.annotations.update(
        {
            "preview.stacks.io/target-revision": platform,
            "preview.stacks.io/source-revision": source,
            "preview.stacks.io/profile": "app-live",
            "preview.stacks.io/mode": "reconciled",
            "preview.stacks.io/owner": "session:42",
            "preview.stacks.io/services": '["workflow-builder"]',
            "preview.stacks.io/provenance": '{"requestId":"request-1"}',
            "preview.stacks.io/trusted-code": "true",
            "preview.stacks.io/allocation": '{"kind":"cold"}',
            "preview.stacks.io/images": json.dumps({"workflow-builder": image}),
            "preview.stacks.io/catalog-digest": catalog,
        }
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
    assert m.platform_revision == platform
    assert m.source_revision == source
    assert m.profile == "app-live"
    assert m.mode == "reconciled"
    assert m.owner == "session:42"
    assert m.services == ("workflow-builder",)
    assert m.provenance == {"requestId": "request-1"}
    assert m.trusted_code is True
    assert m.allocation == {"kind": "cold"}
    assert m.images == {"workflow-builder": image}
    assert m.catalog_digest == catalog


def test_preview_member_from_ns_tolerates_garbage_pr_and_missing_fields() -> None:
    ns = _ns("plain", pr="not-a-number")
    ns.metadata.annotations.update(
        {
            "preview.stacks.io/target-revision": "main",
            "preview.stacks.io/source-revision": "B" * 40,
            "preview.stacks.io/profile": "unknown",
            "preview.stacks.io/mode": "imperative",
            "preview.stacks.io/owner": " bad",
            "preview.stacks.io/services": '["UPPER"]',
            "preview.stacks.io/provenance": "[]",
            "preview.stacks.io/trusted-code": "yes",
            "preview.stacks.io/allocation": '{"kind":"warm"}',
            "preview.stacks.io/images": '{"workflow-builder":"latest"}',
            "preview.stacks.io/catalog-digest": "sha256:bad",
        }
    )
    m = app_module._preview_member_from_ns(ns)
    assert m.pr_number is None
    assert m.origin is None
    assert m.slept is False
    assert m.protected is False
    assert m.last_active is None
    assert m.expires_at is None
    assert m.platform_revision is None
    assert m.source_revision is None
    assert m.profile is None
    assert m.mode is None
    assert m.owner is None
    assert m.services is None
    assert m.provenance is None
    assert m.trusted_code is None
    assert m.allocation is None
    assert m.images is None
    assert m.catalog_digest is None


def test_preview_lifecycle_fields_emits_the_ui_contract() -> None:
    # The list/get lifecycle fields the BFF Dev-hub consumes, incl. `protected`
    # (Track-1 UI renders a ShieldCheck tooltip + disables Sleep for it).
    protected = app_module._preview_lifecycle_fields(
        _member(
            "gan-1",
            origin="user",
            protected=True,
            last_active=NOW - timedelta(minutes=5),
            expires_at=NOW + timedelta(hours=1),
            platform_revision="a" * 40,
            source_revision="b" * 40,
            profile="app-live",
            mode="live",
            owner="user:42",
            services=("workflow-builder",),
            provenance={"requestId": "request-1"},
            trusted_code=True,
            allocation={"kind": "warm", "baselinePlatformRevision": "a" * 40},
            images={},
            catalog_digest="sha256:" + "c" * 64,
        )
    )
    assert protected["state"] == "hot"
    assert protected["lifecycle"] == "retained"
    assert protected["origin"] == {"kind": "user"}
    assert protected["legacyOrigin"] == "user"
    assert protected["protected"] is True
    assert protected["lastActive"] == (NOW - timedelta(minutes=5)).isoformat(
        timespec="seconds"
    )
    assert protected["expiresAt"] == (NOW + timedelta(hours=1)).isoformat(
        timespec="seconds"
    )
    assert protected["platformRevision"] == "a" * 40
    assert protected["sourceRevision"] == "b" * 40
    assert protected["profile"] == "app-live"
    assert protected["mode"] == "live"
    assert protected["owner"] == {"kind": "user", "id": "user:42"}
    assert protected["services"] == ["workflow-builder"]
    assert protected["provenance"] == {"requestId": "request-1"}
    assert protected["trustedCode"] is True
    assert protected["allocation"]["kind"] == "warm"
    assert protected["images"] == {}
    assert protected["catalogDigest"] == "sha256:" + "c" * 64

    plain = app_module._preview_lifecycle_fields(
        _member("pr-9", origin="pr", pr_number=9, slept=True)
    )
    assert plain["state"] == "slept"
    assert plain["lifecycle"] == "ephemeral"
    assert plain["origin"] == {"kind": "pull-request", "reference": "9"}
    assert plain["legacyOrigin"] == "pr"
    assert plain["prNumber"] == 9
    assert plain["protected"] is False


# ---- _select_preview_evictions (the pure selector — highest-risk logic) ------


def _selector_kwargs(**overrides):
    kwargs = dict(need=10, pool_size=2, now=NOW, ttl_hours=0, active_minutes=30)
    kwargs.update(overrides)
    return kwargs


def test_evictions_need_zero_or_negative_returns_empty() -> None:
    members = [_member("a", pool_state="free")]
    assert (
        app_module._select_preview_evictions(members, **_selector_kwargs(need=0)) == []
    )
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


def test_evictions_use_lifecycle_not_owner_kind() -> None:
    members = [
        _member(
            "retained-pr",
            lifecycle="retained",
            origin="pr",
            origin_contract={"kind": "pull-request", "reference": "17"},
        ),
        _member(
            "ephemeral-user",
            lifecycle="ephemeral",
            origin="user",
            owner_contract={"kind": "user", "id": "user:42"},
        ),
        _member(
            "ephemeral-workflow",
            lifecycle="ephemeral",
            origin_contract={"kind": "workflow", "reference": "run:19"},
        ),
    ]

    picked = app_module._select_preview_evictions(members, **_selector_kwargs())

    assert [member.real_name for member in picked] == [
        "ephemeral-user",
        "ephemeral-workflow",
    ]


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
    assert env["PREVIEW_TTL_HOURS"] == "24"
    assert env["EXPIRES_AT"].endswith("Z")
    assert "+00:00" not in env["EXPIRES_AT"]
    expires = app_module._parse_rfc3339(env["EXPIRES_AT"])
    assert expires is not None
    delta = expires - datetime.now(UTC)
    assert timedelta(hours=23) < delta < timedelta(hours=25)


def test_job_manifest_carries_exact_operation_lease_holder() -> None:
    holder = f"op:{'a' * 32}"
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="down"),
        namespace="workflow-builder",
        operation_holder=holder,
    )

    assert _job_env(manifest)["PREVIEW_OPERATION_HOLDER"] == holder
    with pytest.raises(ValueError, match="operation holder"):
        app_module._vcluster_preview_job_manifest(
            VclusterPreviewRequest(name="prv", action="down"),
            namespace="workflow-builder",
            operation_holder="shared-token",
        )


def test_down_job_database_is_server_derived_from_exact_preview_name() -> None:
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="pool-1383", action="down"),
        namespace="preview-control-system",
        operation_holder=f"op:{'a' * 32}",
    )

    env = _job_env(manifest)
    assert env["PREVIEW_DB"] == "preview_pool1383"
    assert env["PREVIEW_DB_MODE"] == "shared"


def test_down_job_receipt_is_bound_to_controller_intent_and_cr_uid() -> None:
    intent_id = f"sha256:{'d' * 64}"
    environment_uid = "12345678-1234-1234-1234-123456789abc"
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(
            name="feature-one",
            action="down",
            teardownExpectedRequestId="request-1",
            teardownExpectedSourceRevision="b" * 40,
            teardownEnvironmentUid=environment_uid,
            teardownIntentId=intent_id,
        ),
        namespace="preview-control-system",
        operation_holder=f"op:{'a' * 32}",
    )

    annotations = manifest["metadata"]["annotations"]
    pod_annotations = manifest["spec"]["template"]["metadata"]["annotations"]
    assert annotations["preview.stacks.io/teardown-environment-uid"] == environment_uid
    assert annotations["preview.stacks.io/teardown-intent-id"] == intent_id
    assert pod_annotations == annotations
    assert "ttlSecondsAfterFinished" not in manifest["spec"]


def test_down_request_rejects_caller_controlled_database(monkeypatch) -> None:
    monkeypatch.setenv("SANDBOX_EXECUTION_DRY_RUN", "true")

    with pytest.raises(app_module.HTTPException) as caught:
        app_module.provision_vcluster_preview(
            _no_auth_request(),
            VclusterPreviewRequest(
                name="pool-1383",
                action="down",
                previewDb="workflow_builder",
                previewDbMode="shared",
            ),
        )

    assert caught.value.status_code == 400
    assert "server-derived" in str(caught.value.detail)


def test_operation_lease_blocks_overlap_and_releases_by_exact_holder() -> None:
    coordination = _FakeCoordination()
    first = app_module._acquire_preview_operation_lease(
        coordination, namespace="workflow-builder", real_name="feature-one"
    )
    assert first.startswith("op:")

    with pytest.raises(app_module.HTTPException) as caught:
        app_module._acquire_preview_operation_lease(
            coordination, namespace="workflow-builder", real_name="feature-one"
        )
    assert caught.value.status_code == 409

    app_module._release_preview_operation_lease(
        coordination,
        namespace="workflow-builder",
        real_name="feature-one",
        holder=f"op:{'f' * 32}",
    )
    lease = coordination.leases["vcpreview-op-feature-one"]
    assert lease.spec.holder_identity == first

    app_module._release_preview_operation_lease(
        coordination,
        namespace="workflow-builder",
        real_name="feature-one",
        holder=first,
    )
    assert lease.spec.holder_identity == first
    assert coordination.leases["vcpreview-op-feature-one"].spec.holder_identity == ""
    assert app_module._acquire_preview_operation_lease(
        coordination, namespace="workflow-builder", real_name="feature-one"
    ).startswith("op:")


def test_operation_lease_delete_cas_releases_then_uid_fences_absence() -> None:
    coordination = _FakeCoordination()
    holder = app_module._acquire_preview_operation_lease(
        coordination, namespace="workflow-builder", real_name="feature-one"
    )
    uid = coordination.leases["vcpreview-op-feature-one"].metadata.uid

    assert app_module._delete_preview_operation_lease(
        coordination,
        namespace="workflow-builder",
        real_name="feature-one",
        holder=holder,
    )

    assert "vcpreview-op-feature-one" not in coordination.leases
    assert coordination.replaced[-1]["metadata"] == {
        "name": "vcpreview-op-feature-one",
        "namespace": "workflow-builder",
        "resourceVersion": "1",
        "uid": uid,
    }
    assert coordination.replaced[-1]["spec"]["holderIdentity"] == ""
    assert coordination.deleted == [
        {
            "apiVersion": "v1",
            "kind": "DeleteOptions",
            "propagationPolicy": "Background",
            "preconditions": {"uid": uid},
        }
    ]


def test_operation_lease_delete_preserves_same_name_replacement() -> None:
    replacement_uid = "ffffffff-ffff-ffff-ffff-ffffffffffff"

    class ReplacementCoordination(_FakeCoordination):
        def delete_namespaced_lease(self, name, namespace, body):
            current = self.read_namespaced_lease(name, namespace)
            assert body["preconditions"] == {"uid": current.metadata.uid}
            self.deleted.append(body)
            replacement = app_module._preview_operation_lease_body(
                name=name, namespace=namespace, holder=""
            )
            self.leases[name] = self._lease(replacement, "99", replacement_uid)
            raise _ApiExc(404)

    coordination = ReplacementCoordination()
    coordination.create_namespaced_lease(
        namespace="workflow-builder",
        body=app_module._preview_operation_lease_body(
            name="vcpreview-op-feature-one",
            namespace="workflow-builder",
            holder="",
        ),
    )

    with pytest.raises(
        app_module.PreviewRunnerIdentityError, match="replacement appeared"
    ):
        app_module._delete_preview_operation_lease(
            coordination,
            namespace="workflow-builder",
            real_name="feature-one",
            holder="",
        )

    assert (
        coordination.leases["vcpreview-op-feature-one"].metadata.uid == replacement_uid
    )


def test_empty_operation_lease_delete_needs_only_stable_uid() -> None:
    coordination = _FakeCoordination()
    lease = coordination.create_namespaced_lease(
        namespace="workflow-builder",
        body=app_module._preview_operation_lease_body(
            name="vcpreview-op-feature-one",
            namespace="workflow-builder",
            holder="",
        ),
    )
    lease.metadata.resource_version = None

    assert app_module._delete_preview_operation_lease(
        coordination,
        namespace="workflow-builder",
        real_name="feature-one",
        holder="",
    )
    assert "vcpreview-op-feature-one" not in coordination.leases


def test_operation_lease_reacquisition_is_preserved_by_empty_holder_policy() -> None:
    successor = f"op:{'e' * 32}"

    class ReacquiredCoordination(_FakeCoordination):
        def delete_namespaced_lease(self, name, namespace, body):
            self.leases[name].spec.holder_identity = successor
            return super().delete_namespaced_lease(name, namespace, body)

    coordination = ReacquiredCoordination()
    holder = app_module._acquire_preview_operation_lease(
        coordination, namespace="workflow-builder", real_name="feature-one"
    )

    with pytest.raises(
        app_module.PreviewRunnerIdentityError, match="could not delete cleanup Lease"
    ):
        app_module._delete_preview_operation_lease(
            coordination,
            namespace="workflow-builder",
            real_name="feature-one",
            holder=holder,
        )

    assert coordination.leases["vcpreview-op-feature-one"].spec.holder_identity == successor


def test_stale_down_cannot_delete_a_reopened_generation(monkeypatch) -> None:
    old_request = "pr-42-old"
    new_request = "pr-42-new"
    old_source = "b" * 40
    new_source = "c" * 40
    ns = _ns("pr-42")
    ns.metadata.annotations.update(
        {
            "preview.stacks.io/source-revision": new_source,
            "preview.stacks.io/provenance": json.dumps({"requestId": new_request}),
        }
    )
    batch = _FakeBatch()
    core = _FakeCore([ns])
    coordination = _FakeCoordination()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )

    with pytest.raises(app_module.HTTPException) as caught:
        app_module.provision_vcluster_preview(
            _no_auth_request(),
            VclusterPreviewRequest(
                name="pr-42",
                action="down",
                teardownExpectedRequestId=old_request,
                teardownExpectedSourceRevision=old_source,
            ),
        )

    assert caught.value.status_code == 409
    assert "ownership no longer matches" in str(caught.value.detail)
    assert batch.created == []
    assert coordination.leases["vcpreview-op-pr-42"].spec.holder_identity == ""


@pytest.mark.parametrize("supplied", [None, "wrong-proof"])
def test_mutable_live_down_requires_archive_proof_before_job(
    monkeypatch, supplied: str | None
) -> None:
    request_id = "request-live-1"
    source = "b" * 40
    member = _ns(
        "live-one",
        profile="app-live",
        mode="live",
        source_revision=source,
        provenance={"requestId": request_id},
    )
    core = _FakeCore([member])
    batch = _FakeBatch()
    monkeypatch.setenv("PREVIEW_ARCHIVE_TEARDOWN_TOKEN", "host-archive-proof")
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    headers = {"authorization": "Bearer test-token"}
    if supplied is not None:
        headers["x-preview-archive-teardown-token"] = supplied

    with pytest.raises(app_module.HTTPException) as caught:
        app_module.provision_vcluster_preview(
            SimpleNamespace(headers=headers),
            VclusterPreviewRequest(
                name="live-one",
                action="down",
                teardownExpectedRequestId=request_id,
                teardownExpectedSourceRevision=source,
            ),
        )

    assert caught.value.status_code == 403
    assert _created_actions(batch) == []


def test_mutable_live_down_accepts_archive_proof_and_exact_tuple(monkeypatch) -> None:
    request_id = "request-live-1"
    source = "b" * 40
    member = _ns(
        "live-one",
        profile="app-live",
        mode="live",
        source_revision=source,
        provenance={"requestId": request_id},
    )
    core = _FakeCore([member])
    batch = _FakeBatch()
    monkeypatch.setenv("PREVIEW_ARCHIVE_TEARDOWN_TOKEN", "host-archive-proof")
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))

    app_module.provision_vcluster_preview(
        SimpleNamespace(
            headers={
                "authorization": "Bearer test-token",
                "x-preview-archive-teardown-token": "host-archive-proof",
            }
        ),
        VclusterPreviewRequest(
            name="live-one",
            action="down",
            teardownExpectedRequestId=request_id,
            teardownExpectedSourceRevision=source,
        ),
    )

    assert _created_actions(batch) == [("live-one", "down")]
    assert "host-archive-proof" not in json.dumps(batch.created[0])


def test_absent_preview_without_receipt_still_rejects_ordinary_owned_down(
    monkeypatch,
) -> None:
    batch = _FakeBatch()
    core = _FakeCore([])
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(
        app_module, "_preview_down_receipt_succeeded", lambda *_args, **_kwargs: False
    )

    with pytest.raises(app_module.HTTPException) as caught:
        app_module.provision_vcluster_preview(
            _no_auth_request(),
            VclusterPreviewRequest(
                name="never-created",
                action="down",
                teardownExpectedRequestId="request-1",
                teardownExpectedSourceRevision="b" * 40,
            ),
        )

    assert caught.value.status_code == 409
    assert "successful down receipt" in str(caught.value.detail)
    assert batch.created == []


def test_controller_intent_bootstraps_absent_down_job_for_failed_cold_launch(
    monkeypatch,
) -> None:
    batch = _FakeBatch()
    core = _FakeCore([])
    submitted: dict[str, object] = {}
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(
        app_module, "_preview_down_receipt_succeeded", lambda *_args, **_kwargs: False
    )

    def submit(batch_arg, _core, *, namespace, manifest, **kwargs):
        submitted.update(kwargs)
        return app_module._create_preview_job(
            batch_arg, namespace=namespace, manifest=manifest
        )

    monkeypatch.setattr(app_module, "_submit_preview_job", submit)

    result = app_module.provision_vcluster_preview(
        _no_auth_request(),
        VclusterPreviewRequest(
            name="never-created",
            action="down",
            teardownExpectedRequestId="request-1",
            teardownExpectedSourceRevision="b" * 40,
            teardownEnvironmentUid="12345678-1234-1234-1234-123456789abc",
            teardownIntentId=f"sha256:{'d' * 64}",
        ),
    )

    assert result["status"] == "terminating"
    assert _created_actions(batch) == [("never-created", "down")]
    assert submitted["allow_absent_down_bootstrap"] is True


@pytest.mark.parametrize(
    ("profile", "mode"),
    [("app-live", "reconciled"), ("manifest-candidate", "reconciled")],
)
def test_profiled_teardown_route_requires_exact_guard_before_job(
    monkeypatch, profile: str, mode: str
) -> None:
    member = _ns(
        "guarded-one",
        profile=profile,
        mode=mode,
        source_revision="b" * 40,
        allocation={"kind": "cold"},
        trusted_code=True,
        provenance={"requestId": "request-1"},
    )
    core = _FakeCore([member])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))

    with pytest.raises(app_module.HTTPException) as caught:
        app_module.teardown_vcluster_preview(_no_auth_request(), "guarded-one", None)

    assert caught.value.status_code == 400
    assert "requires one exact" in str(caught.value.detail)
    assert batch.created == []


def test_up_job_manifest_omits_d1_env_by_default_and_rejects_bad_origin() -> None:
    m = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="up"), namespace="workflow-builder"
    )
    env = _job_env(m)
    assert (
        "ORIGIN" not in env
        and "PR_NUMBER" not in env
        and "EXPIRES_AT" not in env
        and "PREVIEW_TTL_HOURS" not in env
    )
    m2 = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="up", origin="bogus", ttlHours=0),
        namespace="workflow-builder",
    )
    env2 = _job_env(m2)
    assert (
        "ORIGIN" not in env2
        and "EXPIRES_AT" not in env2
        and "PREVIEW_TTL_HOURS" not in env2
    )


def test_preview_control_namespace_is_independent_from_workload_namespace(
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_WORKFLOW_HOST_NAMESPACE", "workflow-builder")
    monkeypatch.setenv("VCLUSTER_PREVIEW_CONTROL_NAMESPACE", "preview-control-system")

    assert app_module._agent_workflow_host_namespace() == "workflow-builder"
    assert app_module._vcluster_preview_control_namespace() == "preview-control-system"
    manifest = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="control-ns", action="down"),
        namespace=app_module._vcluster_preview_control_namespace(),
    )
    assert manifest["metadata"]["namespace"] == "preview-control-system"
    assert manifest["spec"]["template"]["spec"]["serviceAccountName"] == (
        "vcpreview-control-ns"
    )


def test_profiled_preview_manifest_carries_immutable_contract() -> None:
    platform = "a" * 40
    source = "b" * 40
    request = VclusterPreviewRequest(
        name="feature-one",
        profile="app-live",
        lane="application",
        platformRevision=platform,
        sourceRevision=source,
        delivery="reconciler",
        enrollMode="agent",
        mode="live",
        allocation={"kind": "cold"},
        lifecycle="retained",
        owner={"kind": "user", "id": "user:123"},
        origin={"kind": "interactive-session", "reference": "session:123"},
        services=["workflow-builder", "workflow-orchestrator"],
        provenance={
            "requestId": "req-1",
            "requestedAt": "2026-07-09T12:00:00Z",
            "platformRepository": "PittampalliOrg/stacks",
            "sourceRepository": "PittampalliOrg/workflow-builder",
            "source": "interactive-session",
        },
        trustedCode=True,
        capabilityBundle=CAPABILITY_BUNDLE,
        catalogDigest=CATALOG_DIGEST,
        createOnly=True,
        ttlHours=24,
    )

    app_module._validate_profiled_preview_request(request)
    env = _job_env(
        app_module._vcluster_preview_job_manifest(request, namespace="workflow-builder")
    )

    assert env["TARGET_REVISION"] == platform
    assert env["SOURCE_REVISION"] == source
    assert env["PREVIEW_DELIVERY"] == "reconciler"
    assert env["PREVIEW_PROFILE"] == "app-live"
    assert env["PREVIEW_LANE"] == "application"
    assert env["PREVIEW_MODE"] == "live"
    assert env["PREVIEW_ALLOCATION"] == '{"kind":"cold"}'
    assert env["PREVIEW_LIFECYCLE"] == "retained"
    assert env["PREVIEW_OWNER_KIND"] == "user"
    assert env["PREVIEW_OWNER"] == "user:123"
    assert env["PREVIEW_ORIGIN_KIND"] == "interactive-session"
    assert env["PREVIEW_ORIGIN_REFERENCE"] == "session:123"
    assert env["PREVIEW_CATALOG_DIGEST"] == CATALOG_DIGEST
    assert "PREVIEW_DEV_MODE" not in env
    assert "CREATE_ONLY" not in env
    assert "BFF_IMAGE" not in env
    assert "PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN" not in env
    assert env["PREVIEW_CONTROL_CAPABILITY_TOKEN"] == "1" * 64
    assert env["PREVIEW_DEV_SYNC_MINT_TOKEN"] == "2" * 64
    assert env["PREVIEW_ACTION_INTERNAL_TOKEN"] == "3" * 64
    assert env["SANDBOX_EXECUTION_API_TOKEN"] == "4" * 64
    assert env["PREVIEW_RUNTIME_CAPABILITY_TOKEN"] == "5" * 64
    assert env["PREVIEW_STORAGE_CAPABILITY_TOKEN"] == "6" * 64
    assert env["PREVIEW_SERVICES"] == ('["workflow-builder","workflow-orchestrator"]')
    assert json.loads(env["PREVIEW_PROVENANCE"]) == request.provenance
    assert env["TRUSTED_CODE"] == "true"
    assert env["EXPIRES_AT"] == "2026-07-10T12:00:00Z"


def test_profiled_live_preview_allows_only_user_or_pull_request_automation_owner() -> None:
    request = VclusterPreviewRequest(
        name="pr-42",
        profile="app-live",
        lane="application",
        platformRevision="a" * 40,
        sourceRevision="b" * 40,
        delivery="reconciler",
        enrollMode="agent",
        mode="live",
        allocation={"kind": "cold"},
        lifecycle="ephemeral",
        owner={"kind": "automation", "id": "pr-preview:42"},
        origin={
            "kind": "pull-request",
            "reference": "PittampalliOrg/workflow-builder#42",
        },
        services=["workflow-builder"],
        provenance={
            "requestId": "req-pr-42",
            "requestedAt": "2026-07-09T12:00:00Z",
            "platformRepository": "PittampalliOrg/stacks",
            "sourceRepository": "PittampalliOrg/workflow-builder",
        },
        trustedCode=True,
        capabilityBundle=CAPABILITY_BUNDLE,
        catalogDigest=CATALOG_DIGEST,
        createOnly=True,
        ttlHours=24,
    )

    app_module._validate_profiled_preview_request(request)

    for changes in (
        {"origin": {"kind": "automation"}},
        {
            "owner": {"kind": "workflow", "id": "workflow-1"},
            "origin": {"kind": "pull-request", "reference": "repo#42"},
        },
        {
            "owner": {"kind": "session", "id": "session-1"},
            "origin": {"kind": "interactive-session", "reference": "session-1"},
        },
    ):
        with pytest.raises(app_module.HTTPException) as caught:
            app_module._validate_profiled_preview_request(
                VclusterPreviewRequest(**{**request.model_dump(), **changes})
            )
        assert caught.value.status_code == 400
        assert "pull-request automation owner" in str(caught.value.detail)


def test_profiled_preview_omitted_delivery_defaults_to_reconciler_agent(
    monkeypatch,
) -> None:
    monkeypatch.delenv("VCLUSTER_PREVIEW_DELIVERY", raising=False)
    monkeypatch.delenv("VCLUSTER_PREVIEW_ENROLL_MODE", raising=False)
    request = VclusterPreviewRequest(
        name="default-delivery",
        profile="app-live",
        lane="application",
        platformRevision="a" * 40,
        sourceRevision="b" * 40,
        mode="live",
        allocation={"kind": "cold"},
        lifecycle="ephemeral",
        owner={"kind": "user", "id": "user:123"},
        origin={"kind": "interactive-session", "reference": "session:123"},
        services=["workflow-builder"],
        provenance={
            "requestId": "req-default-delivery",
            "requestedAt": "2026-07-09T12:00:00Z",
            "platformRepository": "PittampalliOrg/stacks",
            "sourceRepository": "PittampalliOrg/workflow-builder",
        },
        trustedCode=True,
        capabilityBundle=CAPABILITY_BUNDLE,
        catalogDigest=CATALOG_DIGEST,
        createOnly=True,
        ttlHours=24,
    )

    app_module._validate_profiled_preview_request(request)
    env = _job_env(
        app_module._vcluster_preview_job_manifest(
            request, namespace="preview-control-system"
        )
    )

    assert env["PREVIEW_DELIVERY"] == "reconciler"
    assert env["ENROLL_MODE"] == "agent"


def test_profiled_expiry_uses_requested_at_despite_controller_clock_skew() -> None:
    request = VclusterPreviewRequest(
        name="clock-skew",
        profile="app-live",
        lane="application",
        platformRevision="a" * 40,
        sourceRevision="b" * 40,
        delivery="reconciler",
        enrollMode="agent",
        mode="live",
        allocation={"kind": "cold"},
        lifecycle="ephemeral",
        owner={"kind": "user", "id": "user:123"},
        origin={"kind": "interactive-session", "reference": "session:123"},
        services=["workflow-builder"],
        provenance={
            "requestId": "req-clock-skew",
            "requestedAt": "2025-01-02T03:04:05.123456Z",
            "platformRepository": "PittampalliOrg/stacks",
            "sourceRepository": "PittampalliOrg/workflow-builder",
        },
        trustedCode=True,
        capabilityBundle=CAPABILITY_BUNDLE,
        catalogDigest=CATALOG_DIGEST,
        createOnly=True,
        ttlHours=24,
    )

    app_module._validate_profiled_preview_request(request)
    env = _job_env(
        app_module._vcluster_preview_job_manifest(
            request, namespace="preview-control-system"
        )
    )

    assert env["EXPIRES_AT"] == "2025-01-03T03:04:05.123456Z"


def test_reconciled_app_live_requires_cold_immutable_images() -> None:
    image = "ghcr.io/pittampalliorg/workflow-builder@sha256:" + "c" * 64
    request = VclusterPreviewRequest(
        name="acceptance-one",
        profile="app-live",
        lane="application",
        mode="reconciled",
        allocation={"kind": "cold"},
        platformRevision="a" * 40,
        sourceRevision="b" * 40,
        delivery="reconciler",
        enrollMode="agent",
        lifecycle="ephemeral",
        owner={"kind": "session", "id": "session:123"},
        origin={"kind": "workflow", "reference": "execution:123"},
        services=["workflow-builder"],
        imageOverrides={"workflow-builder": image},
        provenance={
            "requestId": "req-acceptance",
            "requestedAt": "2026-07-09T12:00:00Z",
            "platformRepository": "PittampalliOrg/stacks",
            "sourceRepository": "PittampalliOrg/workflow-builder",
        },
        trustedCode=True,
        capabilityBundle=CAPABILITY_BUNDLE,
        catalogDigest=CATALOG_DIGEST,
        createOnly=True,
        ttlHours=24,
    )

    app_module._validate_profiled_preview_request(request)
    env = _job_env(
        app_module._vcluster_preview_job_manifest(request, namespace="workflow-builder")
    )
    assert env["PREVIEW_MODE"] == "reconciled"
    assert env["PREVIEW_ALLOCATION"] == '{"kind":"cold"}'
    assert env["PREVIEW_IMAGES"] == ('{"workflow-builder":"' + image + '"}')

    non_native = request.model_copy(
        update={
            "services": ["swebench-coordinator"],
            "imageOverrides": {
                "swebench-coordinator": (
                    "ghcr.io/pittampalliorg/swebench-coordinator@sha256:" + "d" * 64
                )
            },
        }
    )
    with pytest.raises(app_module.HTTPException, match="not preview-native"):
        app_module._validate_profiled_preview_request(non_native)

    for changes, expected in [
        (
            {
                "allocation": {
                    "kind": "warm",
                    "baselinePlatformRevision": "a" * 40,
                }
            },
            "allocation is cold-only",
        ),
        ({"imageOverrides": {}}, "requires imageOverrides"),
        (
            {"imageOverrides": {"workflow-builder": "workflow-builder:latest"}},
            "immutable",
        ),
    ]:
        invalid = request.model_copy(update=changes)
        with pytest.raises(app_module.HTTPException) as caught:
            app_module._validate_profiled_preview_request(invalid)
        assert expected in str(caught.value.detail)


@pytest.mark.parametrize(
    ("changes", "status_code", "detail"),
    [
        ({"trustedCode": False}, 403, "trustedCode=true"),
        ({"platformRevision": "main"}, 400, "platformRevision"),
        ({"profile": "host-candidate"}, 400, "physical-dev"),
        ({"delivery": "imperative"}, 400, "delivery=reconciler"),
        (
            {"delivery": "reconciler", "enrollMode": "imperative"},
            400,
            "enrollMode=agent",
        ),
        ({"profile": "manifest-candidate", "pool": True}, 400, "warm-pool"),
        ({"services": ["Workflow Builder"]}, 400, "invalid service"),
        ({"services": ["workflow-builder", "workflow-builder"]}, 400, "duplicates"),
        ({"previewDb": "host-shared"}, 400, "cannot select a shared"),
        ({"previewDbMode": "shared"}, 400, "previewDbMode=cnpg"),
        ({"previewDbBootstrap": "template"}, 400, "previewDbBootstrap=migrate"),
    ],
)
def test_profiled_preview_rejects_unsafe_contracts(
    changes: dict[str, object], status_code: int, detail: str
) -> None:
    values: dict[str, object] = {
        "name": "feature-one",
        "profile": "app-live",
        "lane": "application",
        "platformRevision": "a" * 40,
        "sourceRevision": "b" * 40,
        "delivery": "reconciler",
        "enrollMode": "agent",
        "mode": "live",
        "allocation": {"kind": "cold"},
        "lifecycle": "retained",
        "owner": {"kind": "user", "id": "user:123"},
        "origin": {"kind": "user"},
        "services": ["workflow-builder"],
        "provenance": {
            "requestId": "req-1",
            "requestedAt": "2026-07-09T12:00:00Z",
            "platformRepository": "PittampalliOrg/stacks",
            "sourceRepository": "PittampalliOrg/workflow-builder",
        },
        "trustedCode": True,
        "capabilityBundle": CAPABILITY_BUNDLE,
        "catalogDigest": CATALOG_DIGEST,
        "createOnly": True,
        "ttlHours": 24,
    }
    values.update(changes)
    request = VclusterPreviewRequest(**values)

    with pytest.raises(app_module.HTTPException) as caught:
        app_module._validate_profiled_preview_request(request)

    assert caught.value.status_code == status_code
    assert detail in str(caught.value.detail)


def test_unprofiled_preview_request_is_rejected() -> None:
    request = VclusterPreviewRequest(name="legacy", targetRevision="main")
    with pytest.raises(app_module.HTTPException) as caught:
        app_module._validate_profiled_preview_request(request)
    assert caught.value.status_code == 400
    assert "profiled PreviewEnvironment contract" in str(caught.value.detail)


@pytest.mark.parametrize(
    "name",
    [
        "pool-1383",
        "pool-replacement",
        "mtxdev1",
        "mtxtmpl1",
        "preview6",
        "ganpilot",
        "ganvalidate",
        "test3",
    ],
)
def test_profiled_preview_rejects_legacy_retirement_subject_name(name: str) -> None:
    request = VclusterPreviewRequest(
        name=name,
        action="up",
        profile="app-live",
    )

    with pytest.raises(app_module.HTTPException) as caught:
        app_module._validate_profiled_preview_request(request)

    assert caught.value.status_code == 400
    assert "reserved for legacy preview retirement" in str(caught.value.detail)


def test_sleep_and_resume_job_deadlines() -> None:
    sleep = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="sleep"), namespace="workflow-builder"
    )
    resume = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="resume"),
        namespace="workflow-builder",
    )
    up = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="prv", action="up"), namespace="workflow-builder"
    )
    assert sleep["spec"]["activeDeadlineSeconds"] == 600
    assert resume["spec"]["activeDeadlineSeconds"] == 900
    assert up["spec"]["activeDeadlineSeconds"] == 1800
    assert _job_env(sleep)["ACTION"] == "sleep"
    assert _job_env(resume)["ACTION"] == "resume"
    assert _job_env(up)["ENROLL_MODE"] == "agent"
    assert _job_env(up)["TARGET_REVISION"] == "main"
    assert "TARGET_REVISION" not in _job_env(sleep)
    assert "TARGET_REVISION" not in _job_env(resume)
    assert "PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN" not in _job_env(sleep)
    assert "PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN" not in _job_env(resume)


@pytest.mark.parametrize("action", ["down", "sleep", "resume"])
def test_profiled_lifecycle_jobs_never_carry_target_revision(action: str) -> None:
    env = _job_env(
        app_module._vcluster_preview_job_manifest(
            VclusterPreviewRequest(
                name="prv",
                action=action,
                profile="app-live",
                platformRevision="a" * 40,
            ),
            namespace="workflow-builder",
        )
    )

    assert env["ENROLL_MODE"] == "agent"
    assert "TARGET_REVISION" not in env


def test_profiled_up_job_rejects_non_sha_target_revision() -> None:
    with pytest.raises(app_module.HTTPException) as caught:
        app_module._vcluster_preview_job_manifest(
            VclusterPreviewRequest(
                name="prv",
                action="up",
                profile="app-live",
                platformRevision="main",
            ),
            namespace="workflow-builder",
        )

    assert caught.value.status_code == 400
    assert "TARGET_REVISION" in str(caught.value.detail)


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


def test_unprofiled_claim_is_rejected_before_mutation(monkeypatch) -> None:
    slept = _ns("pool-aa", pool="claimed", alias="demo", state="slept")
    core = _FakeCore([slept])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: _FakeCoordination()
    )
    monkeypatch.setattr(
        app_module,
        "_preview_capacity_lease",
        lambda *_args, **_kwargs: nullcontext(),
    )
    with pytest.raises(app_module.HTTPException) as caught:
        app_module.claim_vcluster_preview(
            _no_auth_request(), VclusterPreviewClaimRequest(name="demo")
        )
    assert caught.value.status_code == 409
    assert "warm pools are retired" in str(caught.value.detail)
    assert _created_actions(batch) == []
    assert slept.metadata.labels["vcluster-preview-state"] == "slept"


# ---- touch / sleep endpoints ---------------------------------------------------


def test_touch_stamps_last_active_on_a_hot_preview(monkeypatch) -> None:
    ns = _ns("demo")
    core = _FakeCore([ns])
    batch = _FakeBatch()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    coordination = _FakeCoordination()
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )
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
    coordination = _FakeCoordination()
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )
    monkeypatch.setattr(
        app_module,
        "_preview_capacity_lease",
        lambda *_args, **_kwargs: nullcontext(),
    )
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

    core = _FakeCore([_ns("pool-bb", pool="free"), _ns("keep", protected=True)])
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


def test_resume_member_reverts_the_label_when_the_job_fails() -> None:
    ns = _ns("demo", state="slept")
    core = _FakeCore([ns])
    batch = _FakeBatch()
    batch.create_fail = True
    member = app_module._preview_member_from_ns(ns)
    ok = app_module._resume_member(batch, core, member, "workflow-builder")
    assert ok is False
    # Reverted to slept so a later touch/claim retries the resume.
    assert ns.metadata.labels["vcluster-preview-state"] == "slept"


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


def test_reap_ttl_sleeps_mutable_live_preview_instead_of_deleting(monkeypatch) -> None:
    expired = _ns(
        "live-expired",
        profile="app-live",
        mode="live",
        expires_at=NOW - timedelta(hours=1),
    )
    core = _FakeCore([expired])
    batch = _FakeBatch()

    stats = app_module._lifecycle_reap_once(batch, core)

    assert stats["reapedExpired"] == 0
    assert stats["archiveRequired"] == 1
    assert stats["sleptNow"] == 1
    assert _created_actions(batch) == [("live-expired", "sleep")]
    assert expired.metadata.labels["vcluster-preview-state"] == "slept"


def test_reap_capacity_sleeps_mutable_live_preview_instead_of_deleting(
    monkeypatch,
) -> None:
    live = _ns(
        "live-capacity",
        profile="app-live",
        mode="live",
        origin="pr",
        created=NOW - timedelta(hours=6),
    )
    core = _FakeCore([live])
    batch = _FakeBatch()

    stats = app_module._lifecycle_reap_once(batch, core, need_room=1)

    assert stats["evicted"] == 0
    assert stats["archiveRequired"] == 1
    assert stats["sleptNow"] == 1
    assert _created_actions(batch) == [("live-capacity", "sleep")]


def test_reap_ttl_defers_pull_request_automation_without_archive() -> None:
    expired = _ns(
        "pr-42",
        profile="app-live",
        mode="live",
        lifecycle="ephemeral",
        owner_contract={"kind": "automation", "id": "pr-preview:42"},
        origin_contract={
            "kind": "pull-request",
            "reference": "PittampalliOrg/workflow-builder#42",
        },
        platform_revision="a" * 40,
        source_revision="b" * 40,
        catalog_digest="sha256:" + "d" * 64,
        allocation={"kind": "cold"},
        trusted_code=True,
        expires_at=NOW - timedelta(hours=1),
        provenance={"requestId": "request-pr-42"},
    )
    core = _FakeCore([expired])
    batch = _FakeBatch()

    stats = app_module._lifecycle_reap_once(batch, core)

    assert stats["reapedExpired"] == 0
    assert stats["archiveRequired"] == 0
    assert stats["applicationReaperRequired"] == 1
    assert stats["sleptNow"] == 0
    assert _created_actions(batch) == []


def test_reap_ttl_keeps_user_interactive_live_archive_required() -> None:
    expired = _ns(
        "interactive-live",
        profile="app-live",
        mode="live",
        lifecycle="ephemeral",
        owner_contract={"kind": "user", "id": "user-42"},
        origin_contract={"kind": "interactive-session", "reference": "session-42"},
        platform_revision="a" * 40,
        source_revision="b" * 40,
        catalog_digest="sha256:" + "d" * 64,
        allocation={"kind": "cold"},
        trusted_code=True,
        expires_at=NOW - timedelta(hours=1),
        provenance={"requestId": "request-session-42"},
    )
    core = _FakeCore([expired])
    batch = _FakeBatch()

    stats = app_module._lifecycle_reap_once(batch, core)

    assert stats["reapedExpired"] == 0
    assert stats["archiveRequired"] == 1
    assert stats["applicationReaperRequired"] == 1
    assert stats["sleptNow"] == 1
    assert _created_actions(batch) == [("interactive-live", "sleep")]


def test_reap_ttl_defers_immutable_reconciled_acceptance_to_application(
    monkeypatch,
) -> None:
    platform = "a" * 40
    source = "b" * 40
    image = "ghcr.io/pittampalliorg/workflow-builder@sha256:" + "c" * 64
    expired = _ns(
        "acceptance-expired",
        profile="app-live",
        mode="reconciled",
        platform_revision=platform,
        source_revision=source,
        services=["workflow-builder"],
        images={"workflow-builder": image},
        catalog_digest="sha256:" + "d" * 64,
        allocation={"kind": "cold"},
        trusted_code=True,
        reconciliation_succeeded=True,
        expires_at=NOW - timedelta(hours=1),
    )
    core = _FakeCore([expired])
    batch = _FakeBatch()

    stats = app_module._lifecycle_reap_once(batch, core)

    assert stats["reapedExpired"] == 0
    assert stats["archiveRequired"] == 0
    assert stats["applicationReaperRequired"] == 1
    assert _created_actions(batch) == []


def test_reap_ttl_defers_manifest_candidate_to_application(monkeypatch) -> None:
    expired = _ns(
        "manifest-expired",
        profile="manifest-candidate",
        mode="reconciled",
        platform_revision="a" * 40,
        source_revision="b" * 40,
        services=[],
        images={},
        catalog_digest="sha256:" + "d" * 64,
        allocation={"kind": "cold"},
        trusted_code=True,
        expires_at=NOW - timedelta(hours=1),
        provenance={"requestId": "request-1"},
    )
    core = _FakeCore([expired])
    batch = _FakeBatch()

    stats = app_module._lifecycle_reap_once(batch, core)

    assert stats["reapedExpired"] == 0
    assert stats["archiveRequired"] == 0
    assert stats["applicationReaperRequired"] == 1
    assert _created_actions(batch) == []


def test_reap_ttl_preserves_incomplete_reconciled_app_live(monkeypatch) -> None:
    expired = _ns(
        "acceptance-incomplete",
        profile="app-live",
        mode="reconciled",
        expires_at=NOW - timedelta(hours=1),
    )
    core = _FakeCore([expired])
    batch = _FakeBatch()

    stats = app_module._lifecycle_reap_once(batch, core)

    assert stats["reapedExpired"] == 0
    assert stats["archiveRequired"] == 1
    assert _created_actions(batch) == [("acceptance-incomplete", "sleep")]


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
    core = _FakeCore([_ns("keep", protected=True, expires_at=NOW - timedelta(hours=5))])
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
        "archiveRequired": 0,
        "applicationReaperRequired": 0,
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
    assert by_name["hot-1"]["origin"] == {"kind": "user"}
    assert by_name["hot-1"]["legacyOrigin"] == "user"
    assert by_name["hot-1"]["phase"] == "ready"
    assert by_name["pr-1"]["state"] == "slept"
    assert by_name["pr-1"]["phase"] == "slept"  # slept members are NOT probed
    assert by_name["pr-1"]["ready"] is False
    assert by_name["pr-1"]["prNumber"] == 341
    assert by_name["pr-1"]["origin"] == {
        "kind": "pull-request",
        "reference": "341",
    }
    assert by_name["pr-1"]["legacyOrigin"] == "pr"
    assert by_name["pr-1"]["expiresAt"] is not None
    assert by_name["pr-1"]["lastActive"] is not None


def test_pool_reconcile_awake_excludes_slept(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "1")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "2")
    # PreviewEnvironment pool reconciliation remains disabled even with legacy env.
    core = _FakeCore(
        [
            _ns("slept-user", state="slept"),
            _ns("hot-user"),
        ]
    )
    batch = _FakeBatch()
    apps = SimpleNamespace()
    stats = app_module._pool_reconcile_once(batch, core, apps)
    assert stats["awake"] == 0
    assert stats["created"] == 0


# ---------------------------------------------------------------------------
# _vcluster_preview_phase: unknown preview → "absent" (regression: listing pods
# in a non-existent namespace returns 200 + empty items, which used to flip
# ns_exists and report a phantom "provisioning" — the D1 idempotent-up then
# skipped its pool claim and polled that phantom forever).
# ---------------------------------------------------------------------------


class _K8s404(Exception):
    def __init__(self):
        super().__init__("not found")
        self.status = 404


def _phase_fakes(
    *, ns_exists, job_404=True, pods=(), annotations=None, job_status=None
):
    def read_namespace(*, name, _request_timeout=None):
        if not ns_exists:
            raise _K8s404()
        return SimpleNamespace(
            metadata=SimpleNamespace(name=name, annotations=annotations or {})
        )

    def list_namespaced_pod(*, namespace, _request_timeout=None):
        # K8s semantics: empty 200 even for a namespace that does not exist.
        return SimpleNamespace(items=list(pods))

    def read_namespaced_job_status(*, name, namespace, _request_timeout=None):
        if job_404:
            raise _K8s404()
        return SimpleNamespace(
            status=job_status or SimpleNamespace(active=1, succeeded=0, failed=0)
        )

    batch = SimpleNamespace(read_namespaced_job_status=read_namespaced_job_status)
    core = SimpleNamespace(
        read_namespace=read_namespace, list_namespaced_pod=list_namespaced_pod
    )
    return batch, core


def test_phase_absent_for_unknown_preview():
    batch, core = _phase_fakes(ns_exists=False)
    phase, active, succeeded, failed = app_module._vcluster_preview_phase(
        batch, core, "pr-416"
    )
    assert phase == "absent"
    assert (active, succeeded, failed) == (0, 0, 0)


def test_phase_provisioning_when_ns_exists_but_bff_not_ready():
    batch, core = _phase_fakes(ns_exists=True)
    phase, *_ = app_module._vcluster_preview_phase(batch, core, "pool-1")
    assert phase == "provisioning"


def test_phase_provisioning_when_job_active_without_ns():
    batch, core = _phase_fakes(ns_exists=False, job_404=False)
    phase, active, *_ = app_module._vcluster_preview_phase(batch, core, "pr-7")
    assert phase == "provisioning"
    assert active == 1


def test_phase_ready_when_bff_pod_ready():
    pod = SimpleNamespace(
        metadata=SimpleNamespace(
            name="workflow-builder-abc",
            labels={
                "app": "workflow-builder",
                "vcluster.loft.sh/namespace": "workflow-builder",
            },
        ),
        status=SimpleNamespace(
            conditions=[SimpleNamespace(type="Ready", status="True")]
        ),
    )
    batch, core = _phase_fakes(ns_exists=True, pods=[pod])
    phase, *_ = app_module._vcluster_preview_phase(batch, core, "pool-1")
    assert phase == "ready"


def _reconciliation_annotations(*, marker: bool = True) -> dict[str, str]:
    annotations = {
        "preview.stacks.io/profile": "app-live",
        "preview.stacks.io/target-revision": "a" * 40,
        "preview.stacks.io/source-revision": "b" * 40,
        "preview.stacks.io/reconciliation-platform-revision": "a" * 40,
        "preview.stacks.io/reconciliation-source-revision": "b" * 40,
    }
    if marker:
        annotations["preview.stacks.io/reconciliation-succeeded-at"] = (
            "2026-07-04T12:00:00Z"
        )
    return annotations


def _ready_bff_pod():
    return SimpleNamespace(
        metadata=SimpleNamespace(
            name="workflow-builder-abc",
            labels={
                "app": "workflow-builder",
                "vcluster.loft.sh/namespace": "workflow-builder",
            },
        ),
        status=SimpleNamespace(
            conditions=[SimpleNamespace(type="Ready", status="True")]
        ),
    )


@pytest.mark.parametrize(
    "labels",
    [
        {"app": "workflow-builder"},
        {
            "app": "workflow-builder",
            "vcluster.loft.sh/namespace": "other",
        },
        {
            "app": "other",
            "vcluster.loft.sh/namespace": "workflow-builder",
        },
    ],
)
def test_phase_does_not_adopt_unrelated_ready_pods(labels) -> None:
    pod = SimpleNamespace(
        metadata=SimpleNamespace(name="workflow-builder-abc", labels=labels),
        status=SimpleNamespace(
            conditions=[SimpleNamespace(type="Ready", status="True")]
        ),
    )
    batch, core = _phase_fakes(ns_exists=True, pods=[pod])

    phase, *_ = app_module._vcluster_preview_phase(batch, core, "pool-1")

    assert phase == "provisioning"


def test_phase_profiled_preview_stays_provisioning_while_up_job_active():
    batch, core = _phase_fakes(
        ns_exists=True,
        job_404=False,
        pods=[_ready_bff_pod()],
        annotations=_reconciliation_annotations(),
    )
    phase, *_ = app_module._vcluster_preview_phase(batch, core, "acceptance")
    assert phase == "provisioning"


def test_phase_profiled_preview_fails_when_up_job_fails():
    batch, core = _phase_fakes(
        ns_exists=True,
        job_404=False,
        pods=[_ready_bff_pod()],
        annotations=_reconciliation_annotations(),
        job_status=SimpleNamespace(
            active=0,
            succeeded=0,
            failed=0,
            conditions=[SimpleNamespace(type="Failed", status="True")],
        ),
    )
    phase, *_ = app_module._vcluster_preview_phase(batch, core, "acceptance")
    assert phase == "failed"


def test_phase_profiled_preview_requires_marker_after_job_success():
    batch, core = _phase_fakes(
        ns_exists=True,
        job_404=False,
        pods=[_ready_bff_pod()],
        annotations=_reconciliation_annotations(marker=False),
        job_status=SimpleNamespace(active=0, succeeded=1, failed=0),
    )
    phase, *_ = app_module._vcluster_preview_phase(batch, core, "acceptance")
    assert phase == "provisioning"


def test_phase_profiled_preview_ready_after_job_success_and_marker():
    batch, core = _phase_fakes(
        ns_exists=True,
        job_404=False,
        pods=[_ready_bff_pod()],
        annotations=_reconciliation_annotations(),
        job_status=SimpleNamespace(active=0, succeeded=1, failed=0),
    )
    phase, *_ = app_module._vcluster_preview_phase(batch, core, "acceptance")
    assert phase == "ready"


def test_phase_profiled_preview_uses_durable_marker_after_job_ttl_gc():
    batch, core = _phase_fakes(
        ns_exists=True,
        job_404=True,
        pods=[_ready_bff_pod()],
        annotations=_reconciliation_annotations(),
    )
    phase, *_ = app_module._vcluster_preview_phase(batch, core, "acceptance")
    assert phase == "ready"


# ---------------------------------------------------------------------------
# Acceptance observation endpoints: immutable pod images + teardown proof.
# ---------------------------------------------------------------------------


def _runtime_pod(service: str, image: str, *, ready: bool = True):
    return SimpleNamespace(
        metadata=SimpleNamespace(
            name=f"{service}-abc",
            labels={"app.kubernetes.io/name": service},
            deletion_timestamp=None,
        ),
        spec=SimpleNamespace(containers=[SimpleNamespace(name=service, image=image)]),
        status=SimpleNamespace(
            phase="Running",
            conditions=[SimpleNamespace(type="Ready", status="True")],
            container_statuses=[
                SimpleNamespace(name=service, image_id=image, ready=ready)
            ],
        ),
    )


def test_runtime_endpoint_reads_exact_selected_service_containers(monkeypatch) -> None:
    digest = f"sha256:{'c' * 64}"
    image = f"ghcr.io/pittampalliorg/workflow-builder@{digest}"
    namespace = _ns("acceptance")
    namespace.metadata.annotations["preview.stacks.io/services"] = json.dumps(
        ["workflow-builder", "function-router"]
    )
    namespace.metadata.annotations["preview.stacks.io/reconciliation-succeeded-at"] = (
        "2026-07-04T12:00:00Z"
    )
    namespace.metadata.annotations.update(
        {
            "preview.stacks.io/target-revision": "a" * 40,
            "preview.stacks.io/source-revision": "b" * 40,
            "preview.stacks.io/reconciliation-platform-revision": "a" * 40,
            "preview.stacks.io/reconciliation-source-revision": "b" * 40,
        }
    )
    core = _FakeCore([namespace])
    core.list_namespaced_pod = lambda **_kwargs: SimpleNamespace(
        items=[
            _runtime_pod("workflow-builder", image),
            _runtime_pod(
                "function-router",
                f"ghcr.io/pittampalliorg/function-router@sha256:{'d' * 64}",
            ),
        ]
    )
    up_job = SimpleNamespace(
        status=SimpleNamespace(succeeded=1, failed=0, conditions=[])
    )
    batch = SimpleNamespace(read_namespaced_job_status=lambda **_kwargs: up_job)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))

    result = app_module.get_vcluster_preview_runtime(_no_auth_request(), "acceptance")

    assert result["resourceName"] == "acceptance"
    assert result["reconciliationSucceeded"] is True
    assert [item["service"] for item in result["services"]] == [
        "function-router",
        "workflow-builder",
    ]
    workflow = next(
        item for item in result["services"] if item["service"] == "workflow-builder"
    )
    assert workflow["containers"] == [
        {
            "pod": "workflow-builder-abc",
            "image": image,
            "imageId": image,
            "ready": True,
        }
    ]

    def missing_up_job(**_kwargs):
        raise _ApiExc(404)

    ttl_gc_batch = SimpleNamespace(read_namespaced_job_status=missing_up_job)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (ttl_gc_batch, core))
    after_ttl_gc = app_module.get_vcluster_preview_runtime(
        _no_auth_request(), "acceptance"
    )
    assert after_ttl_gc["reconciliationSucceeded"] is True


def test_runtime_endpoint_rejects_bff_ready_before_reconciliation_finishes(
    monkeypatch,
) -> None:
    namespace = _ns("acceptance")
    namespace.metadata.annotations["preview.stacks.io/services"] = json.dumps(
        ["workflow-builder"]
    )
    core = _FakeCore([namespace])
    core.list_namespaced_pod = lambda **_kwargs: SimpleNamespace(
        items=[
            _runtime_pod(
                "workflow-builder",
                f"ghcr.io/pittampalliorg/workflow-builder@sha256:{'c' * 64}",
            )
        ]
    )
    active_job = SimpleNamespace(
        status=SimpleNamespace(succeeded=0, failed=0, conditions=[])
    )
    batch = SimpleNamespace(read_namespaced_job_status=lambda **_kwargs: active_job)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))

    result = app_module.get_vcluster_preview_runtime(_no_auth_request(), "acceptance")

    assert result["services"][0]["containers"][0]["ready"] is True
    assert result["reconciliationSucceeded"] is False


def test_cleanup_endpoint_requires_runner_success_and_host_absence(monkeypatch) -> None:
    core = _FakeCore([])
    job = SimpleNamespace(status=SimpleNamespace(succeeded=1, failed=0, conditions=[]))
    batch = SimpleNamespace(read_namespaced_job_status=lambda **_kwargs: job)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))

    result = app_module.get_vcluster_preview_cleanup(_no_auth_request(), "acceptance")

    assert result == {
        "name": "acceptance",
        "resourceName": "acceptance",
        "complete": True,
        "phase": "complete",
        "checks": {
            "runnerSucceeded": True,
            "previewEnvironmentAbsent": False,
            "applicationAbsent": False,
            "agentRegistrationAbsent": False,
            "agentNamespacesAbsent": False,
            "hostNamespaceAbsent": True,
            "databaseAbsent": True,
            "natsStreamAbsent": True,
            "headlampRegistrationAbsent": False,
            "tailnetEgressAbsent": True,
            "storageScopeAbsent": True,
            "runnerIdentityAbsent": True,
        },
        "message": None,
    }


def test_cleanup_endpoint_emits_exact_controller_deletion_receipt(monkeypatch) -> None:
    core = _FakeCore([])
    generation = f"op:{'c' * 32}"
    annotations = {
        app_module.RUNNER_GENERATION_ANNOTATION: generation,
        "preview.stacks.io/teardown-intent-id": f"sha256:{'d' * 64}",
        "preview.stacks.io/teardown-environment-uid": (
            "12345678-1234-1234-1234-123456789abc"
        ),
        "preview.stacks.io/teardown-request-id": "request-1",
        "preview.stacks.io/teardown-source-revision": "b" * 40,
    }
    job = SimpleNamespace(
        metadata=SimpleNamespace(
            name="vcpreview-down-acceptance",
            uid="87654321-4321-4321-4321-cba987654321",
            annotations=annotations,
        ),
        spec=SimpleNamespace(
            template=SimpleNamespace(
                metadata=SimpleNamespace(annotations=dict(annotations))
            )
        ),
        status=SimpleNamespace(succeeded=1, failed=0, conditions=[]),
    )
    batch = SimpleNamespace(read_namespaced_job_status=lambda **_kwargs: job)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))

    result = app_module.get_vcluster_preview_cleanup(_no_auth_request(), "acceptance")

    assert result["complete"] is True
    assert result["teardownProof"] == {
        "intentId": f"sha256:{'d' * 64}",
        "environmentUid": "12345678-1234-1234-1234-123456789abc",
        "requestId": "request-1",
        "sourceRevision": "b" * 40,
        "jobName": "vcpreview-down-acceptance",
        "jobUid": "87654321-4321-4321-4321-cba987654321",
        "runnerGeneration": generation,
    }


def _completed_cleanup_receipt_job(
    *,
    generation: str = f"op:{'c' * 32}",
    job_uid: str = "87654321-4321-4321-4321-cba987654321",
) -> SimpleNamespace:
    annotations = {
        app_module.RUNNER_GENERATION_ANNOTATION: generation,
        app_module._PREVIEW_IDENTITY_CLEANED_ANNOTATION: "true",
    }
    labels = {
        "app": "vcluster-preview",
        "vcluster-preview-name": "acceptance",
        "vcluster-preview-action": "down",
        "preview.stacks.io/managed": "true",
        "preview.stacks.io/preview-name": "acceptance",
    }
    return SimpleNamespace(
        metadata=SimpleNamespace(
            name="vcpreview-down-acceptance",
            uid=job_uid,
            labels=labels,
            annotations=annotations,
        ),
        spec=SimpleNamespace(
            template=SimpleNamespace(
                metadata=SimpleNamespace(
                    annotations=dict(annotations), labels=dict(labels)
                ),
                spec=SimpleNamespace(
                    service_account_name=app_module.preview_runner_identity_name(
                        "acceptance"
                    )
                ),
            )
        ),
        status=SimpleNamespace(succeeded=1, failed=0, conditions=[]),
    )


def _empty_cleanup_operation_lease(coordination: _FakeCoordination) -> str:
    lease = coordination.create_namespaced_lease(
        namespace="workflow-builder",
        body=app_module._preview_operation_lease_body(
            name="vcpreview-op-acceptance",
            namespace="workflow-builder",
            holder="",
        ),
    )
    return lease.metadata.uid


def test_completed_down_receipt_is_pruned_only_after_exact_release(monkeypatch) -> None:
    generation = f"op:{'c' * 32}"
    job_uid = "87654321-4321-4321-4321-cba987654321"
    job = _completed_cleanup_receipt_job(
        generation=generation,
        job_uid=job_uid,
    )

    class ReceiptBatch:
        def __init__(self) -> None:
            self.job = job
            self.deleted = False
            self.delete_body = None

        def list_namespaced_job(self, **_kwargs):
            return SimpleNamespace(items=[] if self.deleted else [self.job])

        def read_namespaced_job_status(self, **_kwargs):
            if self.deleted:
                raise _ApiExc(404)
            return self.job

        def delete_namespaced_job(self, **kwargs):
            self.delete_body = kwargs["body"]
            self.deleted = True

        def read_namespaced_job(self, **_kwargs):
            if self.deleted:
                raise _ApiExc(404)
            return self.job

    batch = ReceiptBatch()
    core = _FakeCore([])
    coordination = _FakeCoordination()
    lease_uid = _empty_cleanup_operation_lease(coordination)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )

    inventory = app_module.list_vcluster_preview_cleanup_receipts(_no_auth_request())
    assert inventory == {
        "receipts": [
            {
                "name": "acceptance",
                "jobName": "vcpreview-down-acceptance",
                "jobUid": job_uid,
                "runnerGeneration": generation,
            }
        ]
    }

    released = app_module.release_vcluster_preview_cleanup_receipt(
        _no_auth_request(),
        "acceptance",
        app_module.VclusterPreviewCleanupReceiptReleaseRequest(
            jobUid=job_uid, runnerGeneration=generation
        ),
    )
    assert released["absent"] is True
    assert batch.deleted is True
    assert batch.delete_body == {
        "apiVersion": "v1",
        "kind": "DeleteOptions",
        "propagationPolicy": "Background",
        "preconditions": {"uid": job_uid},
    }
    assert "vcpreview-op-acceptance" not in coordination.leases
    assert coordination.deleted[-1]["preconditions"] == {"uid": lease_uid}
    assert app_module.list_vcluster_preview_cleanup_receipts(_no_auth_request()) == {
        "receipts": []
    }


def test_missing_cleanup_receipt_retry_still_deletes_empty_operation_lease(
    monkeypatch,
) -> None:
    class MissingReceiptBatch:
        def read_namespaced_job_status(self, **_kwargs):
            raise _ApiExc(404)

    coordination = _FakeCoordination()
    lease_uid = _empty_cleanup_operation_lease(coordination)
    monkeypatch.setattr(
        app_module,
        "_load_k8s_clients",
        lambda: (MissingReceiptBatch(), _FakeCore([])),
    )
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )

    released = app_module.release_vcluster_preview_cleanup_receipt(
        _no_auth_request(),
        "acceptance",
        app_module.VclusterPreviewCleanupReceiptReleaseRequest(
            jobUid="87654321-4321-4321-4321-cba987654321",
            runnerGeneration=f"op:{'c' * 32}",
        ),
    )

    assert released["absent"] is True
    assert "vcpreview-op-acceptance" not in coordination.leases
    assert coordination.deleted[-1]["preconditions"] == {"uid": lease_uid}


@pytest.mark.parametrize("delete_status", [None, 404])
def test_cleanup_receipt_release_preserves_same_name_job_replacement(
    monkeypatch, delete_status: int | None
) -> None:
    job_uid = "87654321-4321-4321-4321-cba987654321"
    replacement_uid = "11111111-2222-3333-4444-555555555555"

    class ReplacementReceiptBatch:
        def __init__(self) -> None:
            self.job = _completed_cleanup_receipt_job(job_uid=job_uid)
            self.delete_body = None

        def read_namespaced_job_status(self, **_kwargs):
            return self.job

        def delete_namespaced_job(self, **kwargs):
            self.delete_body = kwargs["body"]
            self.job = _completed_cleanup_receipt_job(job_uid=replacement_uid)
            if delete_status is not None:
                raise _ApiExc(delete_status)

        def read_namespaced_job(self, **_kwargs):
            return self.job

    batch = ReplacementReceiptBatch()
    coordination = _FakeCoordination()
    _empty_cleanup_operation_lease(coordination)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, _FakeCore([])))
    monkeypatch.setattr(
        app_module, "_load_k8s_coordination_client", lambda: coordination
    )

    with pytest.raises(app_module.HTTPException) as caught:
        app_module.release_vcluster_preview_cleanup_receipt(
            _no_auth_request(),
            "acceptance",
            app_module.VclusterPreviewCleanupReceiptReleaseRequest(
                jobUid=job_uid,
                runnerGeneration=f"op:{'c' * 32}",
            ),
        )

    assert caught.value.status_code == 409
    assert batch.job.metadata.uid == replacement_uid
    assert "vcpreview-op-acceptance" in coordination.leases
    assert coordination.deleted == []


def test_cleanup_endpoint_reports_failed_runner_without_claiming_absence(
    monkeypatch,
) -> None:
    core = _FakeCore([_ns("acceptance")])
    job = SimpleNamespace(
        status=SimpleNamespace(
            succeeded=0,
            failed=1,
            conditions=[
                SimpleNamespace(
                    type="Failed", status="True", reason="BackoffLimitExceeded"
                )
            ],
        )
    )
    batch = SimpleNamespace(read_namespaced_job_status=lambda **_kwargs: job)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))

    result = app_module.get_vcluster_preview_cleanup(_no_auth_request(), "acceptance")

    assert result["complete"] is False
    assert result["phase"] == "failed"
    assert result["message"] == "BackoffLimitExceeded"
    assert not any(result["checks"].values())


def test_cleanup_endpoint_does_not_infer_success_from_missing_resources(
    monkeypatch,
) -> None:
    core = _FakeCore([])

    def missing_job(**_kwargs):
        raise _ApiExc(404)

    batch = SimpleNamespace(read_namespaced_job_status=missing_job)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))

    result = app_module.get_vcluster_preview_cleanup(_no_auth_request(), "acceptance")

    assert result["complete"] is False
    assert result["phase"] == "pending"
    assert result["checks"]["runnerSucceeded"] is False
    assert result["checks"]["hostNamespaceAbsent"] is True
