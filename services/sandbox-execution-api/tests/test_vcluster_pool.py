"""A3 warm vcluster pool: bake POOL=true members, atomically claim one for a user, and keep
the pool full + fresh. Fake k8s clients mirror the test_app.py monkeypatch pattern."""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

import src.app as app_module
from src.app import VclusterPreviewClaimRequest, VclusterPreviewRequest


class _ApiExc(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"api status {status}")
        self.status = status


def _ns(
    real_name: str,
    *,
    pool: str | None = None,
    alias: str | None = None,
    pins: str | None = None,
    bake_hash: str | None = None,
    phase: str = "Active",
    rv: str = "1",
    created: datetime | None = None,
):
    labels = {"app": "vcluster-preview", "vcluster-preview-name": real_name}
    if pool is not None:
        labels["vcluster-preview-pool"] = pool
    if alias is not None:
        labels["vcluster-preview-alias"] = alias
    annotations = {}
    if pins is not None:
        annotations["vcluster-preview-image-pins"] = pins
    if bake_hash is not None:
        annotations["vcluster-preview-bake-hash"] = bake_hash
    meta = SimpleNamespace(
        name=f"vcluster-{real_name}",
        labels=labels,
        annotations=annotations,
        resource_version=rv,
        creation_timestamp=created or datetime.now(UTC),
    )
    return SimpleNamespace(metadata=meta, status=SimpleNamespace(phase=phase))


def _sel_match(ns, selector: str | None) -> bool:
    if not selector:
        return True
    key, _, value = selector.partition("=")
    return (ns.metadata.labels or {}).get(key) == value


def _runner_cm(data: dict[str, str]):
    """A `vcluster-preview-runner` ConfigMap object as _bake_inputs_hash reads it."""
    return SimpleNamespace(
        metadata=SimpleNamespace(name="vcluster-preview-runner"), data=dict(data)
    )


def _expected_bake_hash(data: dict[str, str]) -> str:
    """The hash _bake_inputs_hash must produce for this ConfigMap data — equivalent to
    the runner's `cat /config/* | sha256sum` (concat the values of the sorted keys)."""
    from hashlib import sha256

    payload = "".join(data[k] for k in sorted(data))
    return sha256(payload.encode("utf-8")).hexdigest()


class _FakeCore:
    def __init__(self, namespaces, configmaps=None) -> None:
        self._ns = {n.metadata.name: n for n in namespaces}
        self._configmaps = dict(configmaps or {})
        self.replaced: list = []
        self.patched: list = []
        self.replace_conflicts: set[str] = set()

    def read_namespaced_config_map(self, name, namespace):
        if name not in self._configmaps:
            raise _ApiExc(404)
        return self._configmaps[name]

    def list_namespace(self, label_selector=None):
        items = [n for n in self._ns.values() if _sel_match(n, label_selector)]
        return SimpleNamespace(items=items)

    def replace_namespace(self, name, body):
        if name in self.replace_conflicts:
            self.replace_conflicts.discard(name)
            raise _ApiExc(409)
        self._ns[name] = body
        self.replaced.append((name, body))
        return body

    def patch_namespace(self, name, body):
        self.patched.append((name, body))
        self._ns[name].metadata.labels.update(body["metadata"]["labels"])
        return self._ns[name]

    def read_namespace(self, name):
        if name not in self._ns:
            raise _ApiExc(404)
        return self._ns[name]


def _up_pool_job(name: str, active: int = 1):
    """A pool bake Job as the reconcile's in-flight-bake count sees it (#33)."""
    return SimpleNamespace(
        metadata=SimpleNamespace(name=name), status=SimpleNamespace(active=active)
    )


class _FakeBatch:
    def __init__(self, jobs=None) -> None:
        self.created: list = []
        self.jobs = list(jobs or [])  # active up-Jobs the reconcile counts as in-flight bakes

    def delete_namespaced_job(self, name, namespace, propagation_policy=None):
        raise _ApiExc(404)  # no prior job

    def read_namespaced_job(self, name, namespace):
        raise _ApiExc(404)  # settle loop breaks immediately (no sleep)

    def create_namespaced_job(self, namespace, body):
        self.created.append(body)

    def list_namespaced_job(self, namespace, label_selector=None):
        return SimpleNamespace(items=self.jobs)


class _FakeApps:
    def __init__(self, images: dict[str, str]) -> None:
        self._images = images

    def read_namespaced_deployment(self, name, namespace):
        img = self._images.get(name)
        if img is None:
            raise _ApiExc(404)
        cont = SimpleNamespace(name=name, image=img)
        template = SimpleNamespace(spec=SimpleNamespace(containers=[cont]))
        return SimpleNamespace(spec=SimpleNamespace(template=template))


_HOST_IMAGES = {
    "workflow-builder": "ghcr.io/x/workflow-builder:git-aaa",
    "workflow-orchestrator": "ghcr.io/x/workflow-orchestrator:git-bbb",
    "function-router": "ghcr.io/x/function-router:git-ccc",
    "sandbox-execution-api": "ghcr.io/x/sandbox-execution-api:git-ddd",
}
_HOST_PINS = "bff=ghcr.io/x/workflow-builder:git-aaa;orch=ghcr.io/x/workflow-orchestrator:git-bbb;fr=ghcr.io/x/function-router:git-ccc;sea=ghcr.io/x/sandbox-execution-api:git-ddd"


def _env(names) -> dict[str, str]:
    return {e["name"]: e["value"] for e in names}


def _job_env(manifest) -> dict[str, str]:
    return _env(manifest["spec"]["template"]["spec"]["containers"][0]["env"])


# ---- manifests -------------------------------------------------------------


def test_up_job_manifest_pool_flag_sets_POOL_env() -> None:
    m = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="pool-abcd", action="up", pool=True),
        namespace="workflow-builder",
    )
    assert _job_env(m)["POOL"] == "true"
    assert _job_env(m)["ACTION"] == "up"


def test_up_job_manifest_omits_POOL_when_not_pool() -> None:
    m = app_module._vcluster_preview_job_manifest(
        VclusterPreviewRequest(name="feat-x", action="up"),
        namespace="workflow-builder",
    )
    assert "POOL" not in _job_env(m)


def test_claim_job_manifest_carries_claim_env() -> None:
    m = app_module._vcluster_claim_job_manifest(
        "pool-abcd",
        "my-feature",
        "vpittamp",
        dev_mode=True,
        namespace="workflow-builder",
    )
    env = _job_env(m)
    assert env["ACTION"] == "claim"
    assert env["POOL_NAME"] == "pool-abcd"
    assert env["ALIAS"] == "my-feature"
    assert env["CLAIM_USER"] == "vpittamp"
    # Image freshness moved to the recycler; a claim no longer bumps images.
    assert "CLAIM_BUMP_IMAGES" not in env
    assert env["PREVIEW_DEV_MODE"] == "true"
    assert m["metadata"]["name"] == "vcpreview-claim-pool-abcd"


# ---- atomic claim ----------------------------------------------------------


def test_claim_free_member_flips_one_atomically() -> None:
    core = _FakeCore([_ns("pool-1", pool="free")])
    real = app_module._claim_free_member(core, alias="my-feature", claim_user="vp")
    assert real == "pool-1"
    assert len(core.replaced) == 1
    _name, body = core.replaced[0]
    assert body.metadata.labels["vcluster-preview-pool"] == "claimed"
    assert body.metadata.labels["vcluster-preview-alias"] == "my-feature"
    assert body.metadata.annotations["vcluster-preview-claimed-by"] == "vp"
    assert "vcluster-preview-claimed-at" in body.metadata.annotations


def test_claim_free_member_none_when_pool_empty() -> None:
    core = _FakeCore([_ns("regular", pool=None)])  # no free members
    assert app_module._claim_free_member(core, alias="x", claim_user="vp") is None


def test_claim_free_member_idempotent_on_existing_alias() -> None:
    core = _FakeCore([_ns("pool-7", pool="claimed", alias="my-feature")])
    real = app_module._claim_free_member(core, alias="my-feature", claim_user="vp")
    assert real == "pool-7"
    assert core.replaced == []  # reused; no new flip


def test_claim_free_member_skips_when_cold_preview_shares_name() -> None:
    # A cold preview literally named "foo" occupies vcluster-foo; claim must NOT grab a free
    # member aliased to "foo" (the BFF cold-path re-provisions the existing one instead).
    core = _FakeCore([_ns("foo", pool=None), _ns("pool-1", pool="free")])
    assert app_module._claim_free_member(core, alias="foo", claim_user="vp") is None
    assert core.replaced == []


def test_claim_free_member_retries_next_on_409() -> None:
    older = _ns("pool-a", pool="free", created=datetime(2020, 1, 1, tzinfo=UTC))
    newer = _ns("pool-b", pool="free", created=datetime(2020, 1, 2, tzinfo=UTC))
    core = _FakeCore([older, newer])
    core.replace_conflicts.add("vcluster-pool-a")  # someone else won pool-a
    real = app_module._claim_free_member(core, alias="x", claim_user="vp")
    assert real == "pool-b"  # fell through to the next candidate


# ---- claim endpoint --------------------------------------------------------


def _no_auth_request():
    return SimpleNamespace(headers={})


def test_claim_endpoint_launches_claim_job(monkeypatch) -> None:
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    monkeypatch.delenv("SANDBOX_EXECUTION_API_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)
    batch = _FakeBatch()
    core = _FakeCore([_ns("pool-xyz", pool="free")])
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    resp = app_module.claim_vcluster_preview(
        _no_auth_request(),
        VclusterPreviewClaimRequest(name="My Feature", user="vpittamp"),
    )
    assert resp["pooled"] is True
    assert resp["pool"] == "pool-xyz"
    assert resp["name"] == "my-feature"
    assert resp["tailnetHost"] == "wfb-my-feature"
    assert len(batch.created) == 1
    assert _job_env(batch.created[0])["ACTION"] == "claim"
    assert _job_env(batch.created[0])["ALIAS"] == "my-feature"


def test_claim_endpoint_404_when_pool_empty(monkeypatch) -> None:
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    monkeypatch.delenv("SANDBOX_EXECUTION_API_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)
    batch = _FakeBatch()
    core = _FakeCore([])  # empty pool
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    with pytest.raises(app_module.HTTPException) as exc:
        app_module.claim_vcluster_preview(
            _no_auth_request(), VclusterPreviewClaimRequest(name="x")
        )
    assert exc.value.status_code == 404
    assert batch.created == []


# ---- image pins / staleness ------------------------------------------------


def test_host_image_pins_format() -> None:
    assert app_module._host_image_pins(_FakeApps(_HOST_IMAGES)) == _HOST_PINS


def test_host_image_pins_none_when_a_deployment_missing() -> None:
    missing = dict(_HOST_IMAGES)
    del missing["function-router"]
    assert app_module._host_image_pins(_FakeApps(missing)) is None


_RUNNER_DATA = {
    "pins.env": "bff=git-aaa\n",
    "runner.sh": "#!/bin/sh\n",
    "template-db-pin": "sha-123\n",
}


def test_bake_inputs_hash_matches_cat_config_sha256() -> None:
    # Equivalent to the runner's `cat /config/* | sha256sum`: concat the VALUES of the
    # sorted keys (each ConfigMap key is one glob-sorted file in /config).
    core = _FakeCore([], configmaps={"vcluster-preview-runner": _runner_cm(_RUNNER_DATA)})
    assert app_module._bake_inputs_hash(core) == _expected_bake_hash(_RUNNER_DATA)


def test_bake_inputs_hash_none_when_configmap_missing() -> None:
    # Unreadable inputs → None so the recycler never false-recycles on a transient error.
    assert app_module._bake_inputs_hash(_FakeCore([])) is None


def test_member_is_stale_detects_bake_hash_drift() -> None:
    core = _FakeCore(
        [_ns("pool-1", pool="free", bake_hash="stale-hash")],
        configmaps={"vcluster-preview-runner": _runner_cm(_RUNNER_DATA)},
    )
    assert app_module._member_is_stale(core, "pool-1") is True


def test_member_not_stale_when_bake_hash_matches() -> None:
    want = _expected_bake_hash(_RUNNER_DATA)
    core = _FakeCore(
        [_ns("pool-1", pool="free", bake_hash=want)],
        configmaps={"vcluster-preview-runner": _runner_cm(_RUNNER_DATA)},
    )
    assert app_module._member_is_stale(core, "pool-1") is False


def test_member_with_legacy_pins_and_no_bake_hash_is_stale_once() -> None:
    # Migration turnover: a pre-bake-hash member (legacy image-pins, no bake-hash) is
    # recycled exactly once so its replacement carries the new annotation.
    core = _FakeCore(
        [_ns("pool-legacy", pool="free", pins="bff=old;orch=x;fr=y;sea=z")],
        configmaps={"vcluster-preview-runner": _runner_cm(_RUNNER_DATA)},
    )
    assert app_module._member_is_stale(core, "pool-legacy") is True


def test_member_with_no_annotations_is_not_stale() -> None:
    core = _FakeCore(
        [_ns("pool-bare", pool="free")],
        configmaps={"vcluster-preview-runner": _runner_cm(_RUNNER_DATA)},
    )
    assert app_module._member_is_stale(core, "pool-bare") is False


# ---- pool reconcile --------------------------------------------------------


def test_pool_reconcile_off_when_size_zero(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "0")
    batch = _FakeBatch()
    core = _FakeCore([])
    stats = app_module._pool_reconcile_once(batch, core, _FakeApps(_HOST_IMAGES))
    assert stats["created"] == 0
    assert batch.created == []


def test_pool_reconcile_fills_toward_size(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "2")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "6")
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_FILL_BATCH", "1")
    batch = _FakeBatch()
    core = _FakeCore([])  # no free members yet
    stats = app_module._pool_reconcile_once(batch, core, _FakeApps(_HOST_IMAGES))
    assert stats["created"] == 1  # capped by fill_batch=1
    m = batch.created[0]
    assert _job_env(m)["POOL"] == "true"
    assert _job_env(m)["ACTION"] == "up"
    assert m["metadata"]["name"].startswith("vcpreview-up-pool-")


def test_pool_reconcile_counts_inflight_bakes_no_overshoot(monkeypatch) -> None:
    # #33: with 0 free but the target's worth of bakes already IN FLIGHT (active up-Jobs),
    # the reconcile must create NOTHING — else it relaunches a redundant bake every tick and
    # overshoots pool_size. (Pre-fix, need=pool_size-free=2 and fill_batch=1 → it created 1.)
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "2")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "6")
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_FILL_BATCH", "1")
    batch = _FakeBatch(
        jobs=[
            _up_pool_job("vcpreview-up-pool-aaaa"),
            _up_pool_job("vcpreview-up-pool-bbbb"),
        ]
    )
    # the two baking members' namespaces (no pool-state label yet = counted awake, not free)
    core = _FakeCore([_ns("pool-aaaa", pool=None), _ns("pool-bbbb", pool=None)])
    stats = app_module._pool_reconcile_once(batch, core, _FakeApps(_HOST_IMAGES))
    assert stats["baking"] == 2
    assert stats["created"] == 0  # need = pool_size - (free 0 + baking 2) = 0
    assert batch.created == []


def test_pool_reconcile_fills_only_the_shortfall_past_inflight(monkeypatch) -> None:
    # #33: with 0 free + 1 bake in flight and pool_size 2, the true shortfall is 1 → create 1.
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "2")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "6")
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_FILL_BATCH", "1")
    batch = _FakeBatch(jobs=[_up_pool_job("vcpreview-up-pool-aaaa")])
    core = _FakeCore([_ns("pool-aaaa", pool=None)])
    stats = app_module._pool_reconcile_once(batch, core, _FakeApps(_HOST_IMAGES))
    assert stats["baking"] == 1
    assert stats["created"] == 1  # need = 2 - (0 + 1) = 1


def test_pool_reconcile_ignores_non_active_and_non_pool_jobs(monkeypatch) -> None:
    # Completed pool bakes (active=0) and unrelated up-Jobs must NOT count as in-flight.
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "2")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "6")
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_FILL_BATCH", "1")
    batch = _FakeBatch(
        jobs=[
            _up_pool_job("vcpreview-up-pool-done", active=0),  # completed bake
            _up_pool_job("vcpreview-up-feat-x", active=1),  # a normal preview, not a pool bake
        ]
    )
    core = _FakeCore([])
    stats = app_module._pool_reconcile_once(batch, core, _FakeApps(_HOST_IMAGES))
    assert stats["baking"] == 0
    assert stats["created"] == 1  # need = 2 - 0 = 2, capped to fill_batch=1


def test_pool_reconcile_respects_max_awake(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "5")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "2")
    batch = _FakeBatch()
    # 2 awake (both regular) → no room even though 0 free < pool_size
    core = _FakeCore([_ns("a", pool=None), _ns("b", pool=None)])
    stats = app_module._pool_reconcile_once(batch, core, _FakeApps(_HOST_IMAGES))
    assert stats["awake"] == 2
    assert stats["created"] == 0
    assert batch.created == []


def test_pool_reconcile_no_fill_when_already_full(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "2")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "6")
    batch = _FakeBatch()
    core = _FakeCore(
        [_ns("pool-1", pool="free", pins=_HOST_PINS), _ns("pool-2", pool="free", pins=_HOST_PINS)]
    )
    stats = app_module._pool_reconcile_once(batch, core, _FakeApps(_HOST_IMAGES))
    assert stats["free"] == 2
    assert stats["created"] == 0


def test_pool_reconcile_recycles_bake_drifted_free_member(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "1")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "6")
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_RECYCLE_DEADLINE", "900")
    batch = _FakeBatch()
    core = _FakeCore(
        [_ns("pool-old", pool="free", bake_hash="stale-hash")],
        configmaps={"vcluster-preview-runner": _runner_cm(_RUNNER_DATA)},
    )
    stats = app_module._pool_reconcile_once(batch, core, _FakeApps(_HOST_IMAGES))
    assert stats["recycled"] == 1
    # relabeled off `free` so a claim can't grab a member mid-teardown
    assert core._ns["vcluster-pool-old"].metadata.labels["vcluster-preview-pool"] == "recycling"
    down_jobs = [j for j in batch.created if _job_env(j)["ACTION"] == "down"]
    assert len(down_jobs) == 1
    assert down_jobs[0]["spec"]["activeDeadlineSeconds"] == 900


def test_pool_reconcile_keeps_fresh_free_member(monkeypatch) -> None:
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "1")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "6")
    batch = _FakeBatch()
    core = _FakeCore(
        [_ns("pool-fresh", pool="free", bake_hash=_expected_bake_hash(_RUNNER_DATA))],
        configmaps={"vcluster-preview-runner": _runner_cm(_RUNNER_DATA)},
    )
    stats = app_module._pool_reconcile_once(batch, core, _FakeApps(_HOST_IMAGES))
    assert stats["recycled"] == 0
    assert stats["created"] == 0


# ---- alias-aware list ------------------------------------------------------


def test_compute_previews_hides_free_shows_alias_and_counts(monkeypatch) -> None:
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "1")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "6")
    core = _FakeCore(
        [
            _ns("pool-free1", pool="free"),
            _ns("pool-9", pool="claimed", alias="my-feature"),
            _ns("regular", pool=None),
            _ns("recycling1", pool="recycling"),
        ]
    )
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (_FakeBatch(), core))
    monkeypatch.setattr(
        app_module, "_vcluster_preview_phase", lambda *a, **k: ("ready", 0, 1, 0)
    )
    result = app_module._compute_vcluster_previews()
    names = {p["name"] for p in result["previews"]}
    assert names == {"my-feature", "regular"}  # free + recycling hidden
    claimed = next(p for p in result["previews"] if p["name"] == "my-feature")
    assert claimed["tailnetHost"] == "wfb-my-feature"
    assert claimed["pool"] == "pool-9"
    counts = result["counts"]
    assert counts["awake"] == 4
    assert counts["free"] == 1
    assert counts["claimed"] == 1
    assert counts["recycling"] == 1


def test_resolve_preview_realname_maps_alias(monkeypatch) -> None:
    core = _FakeCore([_ns("pool-3", pool="claimed", alias="my-feature")])
    assert app_module._resolve_preview_realname(core, "my-feature") == "pool-3"
    assert app_module._resolve_preview_realname(core, "unclaimed") == "unclaimed"


# ---- #29: pool members hidden from the user list ---------------------------


def _pool_list_fixture(monkeypatch, namespaces):
    """Wire _compute_vcluster_previews to fakes; every probe reports ready."""
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    core = _FakeCore(namespaces)
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (_FakeBatch(), core))
    monkeypatch.setattr(
        app_module, "_vcluster_preview_phase", lambda *a, **k: ("ready", 0, 1, 0)
    )
    return core


def test_compute_previews_hides_baking_labeled_members(monkeypatch) -> None:
    """CONTRACT: the runner stamps vcluster-preview-pool=baking at up-Job START;
    a mid-bake member must never show in the user list (the pool-1251 incident)."""
    _pool_list_fixture(
        monkeypatch,
        [_ns("pool-ab12", pool="baking"), _ns("regular", pool=None)],
    )
    result = app_module._compute_vcluster_previews()
    assert {p["name"] for p in result["previews"]} == {"regular"}
    assert result["counts"]["baking"] == 1
    assert result["counts"]["total"] == 2  # hidden members still count for capacity
    assert result["counts"]["awake"] == 2


def test_compute_previews_fallback_heuristic_hides_unlabeled_pool_names(monkeypatch) -> None:
    """FALLBACK (pre-contract bakes): pool-<4hex> ns with NO pool label and NO alias
    is classified baking and hidden."""
    _pool_list_fixture(
        monkeypatch,
        [
            _ns("pool-1251", pool=None),  # mid-bake under an old runner image
            _ns("regular", pool=None),
        ],
    )
    result = app_module._compute_vcluster_previews()
    assert {p["name"] for p in result["previews"]} == {"regular"}
    assert result["counts"]["baking"] == 1


def test_compute_previews_fallback_heuristic_is_narrow(monkeypatch) -> None:
    """The heuristic must NOT hide: names that aren't pool-<exactly 4 hex>, or members
    with an alias label (claimed mid-personalization shows under its alias)."""
    _pool_list_fixture(
        monkeypatch,
        [
            _ns("pool-feature-x", pool=None),  # not 4 hex — a user's own name
            _ns("pool-ab123", pool=None),  # 5 chars — not the generated shape
            _ns("pool-9f", pool=None),  # 2 chars — not the generated shape
            _ns("pool-ab12", pool="claimed", alias="my-feature"),
        ],
    )
    result = app_module._compute_vcluster_previews()
    names = {p["name"] for p in result["previews"]}
    assert names == {"pool-feature-x", "pool-ab123", "pool-9f", "my-feature"}
    assert result["counts"]["baking"] == 0


def test_compute_previews_claimed_member_shows_alias_with_pool_state(monkeypatch) -> None:
    _pool_list_fixture(monkeypatch, [_ns("pool-9", pool="claimed", alias="my-feature")])
    result = app_module._compute_vcluster_previews()
    (claimed,) = result["previews"]
    assert claimed["name"] == "my-feature"
    assert claimed["pool"] == "pool-9"
    assert claimed["poolState"] == "claimed"
    assert claimed["tailnetHost"] == "wfb-my-feature"


def test_compute_previews_include_pool_shows_everything(monkeypatch) -> None:
    """?includePool=true (admin/debug): every member listed under its raw id with its
    poolState; unclaimed pool members carry NO url (no per-claim LB exists yet)."""
    _pool_list_fixture(
        monkeypatch,
        [
            _ns("pool-ab12", pool="baking"),
            _ns("pool-cd34", pool="free"),
            _ns("pool-ef56", pool="recycling"),
            _ns("pool-9", pool="claimed", alias="my-feature"),
            _ns("regular", pool=None),
        ],
    )
    result = app_module._compute_vcluster_previews(include_pool=True)
    by_name = {p["name"]: p for p in result["previews"]}
    assert set(by_name) == {"pool-ab12", "pool-cd34", "pool-ef56", "my-feature", "regular"}
    assert by_name["pool-cd34"]["poolState"] == "free"
    assert by_name["pool-cd34"]["url"] is None
    assert by_name["pool-cd34"]["tailnetHost"] is None
    assert by_name["pool-ab12"]["poolState"] == "baking"
    assert by_name["my-feature"]["poolState"] == "claimed"
    assert by_name["my-feature"]["url"] is not None
    assert "poolState" not in by_name["regular"]


def test_list_endpoint_include_pool_bypasses_the_burst_cache(monkeypatch) -> None:
    """The admin variant must neither read nor write the cache the user list uses."""
    monkeypatch.delenv("SANDBOX_EXECUTION_API_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)
    _pool_list_fixture(
        monkeypatch, [_ns("pool-cd34", pool="free"), _ns("regular", pool=None)]
    )
    app_module._invalidate_previews_cache()
    try:
        user_view = app_module.list_vcluster_previews(_no_auth_request())
        assert {p["name"] for p in user_view["previews"]} == {"regular"}
        admin_view = app_module.list_vcluster_previews(
            _no_auth_request(), includePool=True
        )
        assert {p["name"] for p in admin_view["previews"]} == {"pool-cd34", "regular"}
        # The cached user list is unchanged by the admin call.
        cached = app_module.list_vcluster_previews(_no_auth_request())
        assert {p["name"] for p in cached["previews"]} == {"regular"}
    finally:
        app_module._invalidate_previews_cache()
