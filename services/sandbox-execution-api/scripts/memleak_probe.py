"""#32 evidence probe: RSS/fd churn of per-call kubernetes ApiClient creation vs one
process-cached client, using READ-ONLY list calls (namespaces + jobs) against the
current kubeconfig context. This reproduces the pre-#32 hot path shape: SEA re-created
BatchV1Api/CoreV1Api (each with a private ApiClient → private urllib3 PoolManager →
fresh TLS) on every request handler call and every background tick.

Usage (from services/sandbox-execution-api; requires a reachable cluster, read-only):
    uv run python scripts/memleak_probe.py --mode fresh  --iterations 300 --context admin@dev
    uv run python scripts/memleak_probe.py --mode cached --iterations 300 --context admin@dev

Interpretation: `fresh` shows RSS climbing with iteration count (native TLS/pool churn
+ glibc arena fragmentation — memory that never returns to the OS) while `cached`
plateaus after warmup. This is an evidence/diagnosis tool, NOT a CI test — CI coverage
lives in tests/test_memory_regression.py.
"""

from __future__ import annotations

import argparse
import gc
import os
import time


def rss_kib() -> int:
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1])
    return 0


def open_fds() -> int:
    return len(os.listdir("/proc/self/fd"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("fresh", "cached"), required=True)
    parser.add_argument("--iterations", type=int, default=300)
    parser.add_argument("--context", default=None, help="kubeconfig context")
    parser.add_argument("--namespace", default="workflow-builder")
    parser.add_argument("--sample-every", type=int, default=25)
    args = parser.parse_args()

    from kubernetes import client, config

    config.load_kube_config(context=args.context)

    def fresh_clients():
        # Pre-#32 shape: a NEW ApiClient (own PoolManager/TLS) per call.
        return client.BatchV1Api(), client.CoreV1Api()

    shared = client.ApiClient()
    def cached_clients():
        return client.BatchV1Api(shared), client.CoreV1Api(shared)

    make = fresh_clients if args.mode == "fresh" else cached_clients

    print(f"mode={args.mode} iterations={args.iterations} context={args.context}")
    print(f"{'iter':>6} {'rss_kib':>10} {'rss_delta':>10} {'fds':>5} {'elapsed_s':>9}")
    gc.collect()
    start_rss = rss_kib()
    t0 = time.monotonic()
    for i in range(1, args.iterations + 1):
        batch, core = make()
        core.list_namespace(label_selector="app=vcluster-preview")
        batch.list_namespaced_job(
            namespace=args.namespace, label_selector="app=vcluster-preview"
        )
        if i % args.sample_every == 0 or i == args.iterations:
            gc.collect()
            print(
                f"{i:>6} {rss_kib():>10} {rss_kib() - start_rss:>10} "
                f"{open_fds():>5} {time.monotonic() - t0:>9.1f}"
            )
    print(f"final: start={start_rss} KiB end={rss_kib()} KiB "
          f"growth={rss_kib() - start_rss} KiB over {args.iterations} iterations")


if __name__ == "__main__":
    main()
