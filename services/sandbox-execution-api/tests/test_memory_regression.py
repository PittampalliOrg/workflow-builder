"""#32: SEA memory growth under pool churn.

Three guards:
  1. The kubernetes clients are PROCESS-CACHED — one shared ApiClient (one urllib3
     PoolManager / TLS stack) behind every `_load_k8s_*` loader. Pre-#32, a fresh
     ApiClient (own connection pool + CA-bundle load + TLS handshakes) was built per
     request handler call AND per 60s background tick — pure native-churn waste.
  2. The list endpoint SINGLE-FLIGHTS its compute — pre-#32, every cache expiry (and
     churn invalidates the cache on every claim/bake/recycle) let ALL concurrent
     pollers duplicate the full K8s fan-out at once (N namespace lists + N×8 probe
     threads + N deserialized pod lists alive simultaneously). Those synchronized
     allocation bursts are the peak-RSS ratchet that fits the observed OOM shape
     (climbs under churn, restarts clean, no single leaking structure).
  3. The hot paths (list+probe cycles, pool reconcile, reaper passes) hold NO Python
     heap memory across iterations — a tracemalloc regression with a generous
     threshold, so any newly-introduced per-call retention (growing list, cache
     without eviction, retained responses) fails loudly.
"""

import gc
import threading
import time
import tracemalloc
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

import src.app as app_module


# ---- 1. client caching contract --------------------------------------------


@pytest.fixture()
def _reset_client_cache(monkeypatch):
    """Isolate the process-wide client cache and keep kubernetes config loading from
    touching a real cluster/kubeconfig."""
    import kubernetes.config as kconfig

    monkeypatch.setattr(kconfig, "load_incluster_config", lambda: None)
    monkeypatch.setattr(
        kconfig,
        "load_kube_config",
        lambda *a, **k: pytest.fail("must not fall back to kubeconfig"),
    )
    app_module._k8s_api_client = None
    yield
    app_module._k8s_api_client = None


def test_k8s_clients_share_one_api_client(_reset_client_cache) -> None:
    batch1, core1 = app_module._load_k8s_clients()
    batch2, core2 = app_module._load_k8s_clients()
    apps = app_module._load_k8s_apps_client()
    custom = app_module._load_k8s_custom_objects_client()
    shared = batch1.api_client
    assert core1.api_client is shared
    assert batch2.api_client is shared  # cached across calls, not per-call
    assert core2.api_client is shared
    assert apps.api_client is shared
    assert custom.api_client is shared


def test_shared_client_pool_fits_the_probe_fanout(_reset_client_cache) -> None:
    """The list endpoint fans out to ≤8 concurrent probes over the SHARED client; an
    undersized urllib3 pool would discard overflow connections (recreating the TLS
    churn the cache exists to remove)."""
    batch, _core = app_module._load_k8s_clients()
    assert (batch.api_client.configuration.connection_pool_maxsize or 0) >= 16


# ---- 2. list endpoint single-flight -----------------------------------------


def _no_auth_request():
    return SimpleNamespace(headers={})


def test_list_endpoint_single_flights_concurrent_cache_misses(monkeypatch) -> None:
    """8 concurrent cache-miss list calls must run ONE compute; the rest wait for the
    winner's cache write and return the same body (bounds the burst amplification)."""
    monkeypatch.delenv("SANDBOX_EXECUTION_API_TOKEN", raising=False)
    monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)
    calls: list[int] = []
    all_arrived = threading.Barrier(8, timeout=10)

    def slow_compute(*, include_pool: bool = False) -> dict:
        calls.append(1)
        time.sleep(0.2)  # long enough for every caller to pile onto the miss
        return {"previews": [], "counts": {"awake": 0}}

    monkeypatch.setattr(app_module, "_compute_vcluster_previews", slow_compute)

    def one_call(_: int) -> dict:
        all_arrived.wait()  # release all 8 at once, against a cold cache
        return app_module.list_vcluster_previews(_no_auth_request())

    app_module._invalidate_previews_cache()
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(one_call, range(8)))
    finally:
        app_module._invalidate_previews_cache()
    assert len(calls) == 1, f"expected a single-flighted compute, got {len(calls)}"
    assert all(r is results[0] for r in results)


# ---- 3. hot-path heap growth stays bounded ----------------------------------
# Fakes mirror tests/test_vcluster_pool.py (kept local: that module is a test file,
# not a fixtures library).


def _ns(real_name: str, *, pool: str | None = None, alias: str | None = None,
        pins: str | None = None):
    labels = {"app": "vcluster-preview", "vcluster-preview-name": real_name}
    if pool is not None:
        labels["vcluster-preview-pool"] = pool
    if alias is not None:
        labels["vcluster-preview-alias"] = alias
    annotations = {"vcluster-preview-image-pins": pins} if pins else {}
    meta = SimpleNamespace(
        name=f"vcluster-{real_name}",
        labels=labels,
        annotations=annotations,
        resource_version="1",
        creation_timestamp=datetime.now(UTC),
    )
    return SimpleNamespace(metadata=meta, status=SimpleNamespace(phase="Active"))


class _FakeCore:
    def __init__(self, namespaces) -> None:
        self._ns = {n.metadata.name: n for n in namespaces}

    def list_namespace(self, label_selector=None):
        return SimpleNamespace(items=list(self._ns.values()))

    def read_namespace(self, name):
        return self._ns[name]


class _FakeBatch:
    def list_namespaced_job(self, namespace, label_selector=None):
        return SimpleNamespace(items=[])


class _FakeApps:
    def read_namespaced_deployment(self, name, namespace):
        cont = SimpleNamespace(name=name, image=f"ghcr.io/x/{name}:git-aaa")
        template = SimpleNamespace(spec=SimpleNamespace(containers=[cont]))
        return SimpleNamespace(spec=SimpleNamespace(template=template))


def test_hot_paths_hold_no_memory_across_churn_cycles(monkeypatch) -> None:
    """400 list+probe cycles + pool reconciles + reaper passes must not accumulate
    Python-heap memory. Threshold is deliberately generous (1 MiB ≈ noise); a real
    per-iteration retention of even a single list result (~10 KiB here) would trip it
    at ~4 MiB."""
    monkeypatch.delenv("SANDBOX_EXECUTION_DRY_RUN", raising=False)
    monkeypatch.setenv("VCLUSTER_PREVIEW_POOL_SIZE", "2")
    monkeypatch.setenv("VCLUSTER_PREVIEW_MAX", "6")
    monkeypatch.setenv("VCLUSTER_PREVIEW_TTL_HOURS", "0")
    monkeypatch.setenv("VCLUSTER_PREVIEW_SLEEP_AFTER_MINUTES", "0")
    monkeypatch.setenv("VCLUSTER_PREVIEW_TOTAL_MAX", "0")
    pins = "bff=b;orch=o;fr=f;sea=s"
    # A realistically-mixed fleet: pool slots in every state + user previews. Pool is
    # exactly at target (2 free) with matching pins so a reconcile pass is a steady-state
    # no-op — any allocation it makes anyway must be transient.
    namespaces = [
        _ns("pool-aa11", pool="free", pins=pins),
        _ns("pool-bb22", pool="free", pins=pins),
        _ns("pool-cc33", pool="baking"),
        _ns("pool-dd44", pool="recycling"),
        _ns("pool-ee55", pool="claimed", alias="claimed-a", pins=pins),
        _ns("pool-ff66", pool="claimed", alias="claimed-b", pins=pins),
        *[_ns(f"user-{i}") for i in range(6)],
    ]
    core = _FakeCore(namespaces)
    batch = _FakeBatch()
    apps = _FakeApps()
    monkeypatch.setattr(app_module, "_load_k8s_clients", lambda: (batch, core))
    monkeypatch.setattr(app_module, "_load_k8s_apps_client", lambda: apps)
    monkeypatch.setattr(
        app_module, "_vcluster_preview_phase", lambda *a, **k: ("ready", 0, 1, 0)
    )
    monkeypatch.setattr(
        app_module,
        "_host_image_pins",
        lambda _apps: pins,
    )

    def one_cycle() -> None:
        app_module._compute_vcluster_previews()
        app_module._compute_vcluster_previews(include_pool=True)
        stats = app_module._pool_reconcile_once(batch, core, apps)
        assert stats["created"] == 0 and stats["recycled"] == 0  # steady state
        app_module._lifecycle_reap_once(batch, core)

    for _ in range(20):  # warmup: fill import-time/lazy caches before measuring
        one_cycle()
    gc.collect()
    tracemalloc.start()
    baseline = tracemalloc.take_snapshot()
    for _ in range(400):
        one_cycle()
    gc.collect()
    final = tracemalloc.take_snapshot()
    tracemalloc.stop()
    growth = sum(
        stat.size_diff
        for stat in final.compare_to(baseline, "filename")
        if stat.size_diff > 0
    )
    assert growth < 1024 * 1024, (
        f"hot paths retained {growth} bytes across 400 churn cycles — "
        "something is accumulating per call"
    )
