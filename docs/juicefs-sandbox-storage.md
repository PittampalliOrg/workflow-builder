# JuiceFS for sandbox workspaces — current setup, best-practices review, recommendations

> Architecture evaluation of how we use **JuiceFS** as the shared filesystem for CLI/agent sandbox workspaces (`/sandbox/work`, `/sandbox/.transcripts`) and how the BFF browses those files for the run-page **Files** tab. Findings are from the JuiceFS official docs (juicefs.com/docs), the `juicedata/juicefs` + `juicefs-csi-driver` repos, and JuiceFS engineering blogs. This is a review + roadmap; only item (0) is shipped.

## Current setup

- **JuiceFS Community Edition 1.3.1**, one filesystem `wfbcli`.
- **Metadata engine = PostgreSQL**; **data/object store = ALSO PostgreSQL** (`--storage postgres` → blobs in a `jfs_blob` table) — both on the shared app Postgres.
- Mounted into **per-session ephemeral agent pods** via `juicefs-csi-driver` at `/sandbox/work` (shared coding workspace) + `/sandbox/.transcripts`. Each run's files live under a per-run subdir keyed by the **Dapr instance id**. Runs clone git repos and run `npm install` → `node_modules` (thousands of small files).
- **`juicefs-webdav` gateway** (`juicedata/mount` image, ClusterIP :9007, stacks `Deployment/Service-juicefs-webdav`) so the BFF browses/reads a run's files over the network (PROPFIND/GET), independent of the ephemeral pod. Consumed by `src/lib/server/workflows/juicefs-webdav.ts` + the run-page Files tab.

## Key findings (sourced)

1. **Access pattern** — WebDAV is a valid fit for our PROPFIND/GET BFF; S3 gateway (`juicefs gateway`) is the S3 alternative. Running a long-lived gateway against the **same fs** as the CSI mounts is **supported** (every client shares the meta+data store; just init with the same UID/GID). Caveat: JuiceFS is **close-to-open consistent** — files a session is *actively writing* may not be visible via the gateway until closed (fine for browsing finished output; no live tail-while-writing). [webdav](https://juicefs.com/docs/community/deployment/webdav/) · [gateway](https://github.com/juicedata/juicefs/blob/main/docs/en/guide/gateway.md) · [cache/consistency](https://juicefs.com/docs/community/guide/cache/)

2. **`--storage postgres` for DATA is not the production tier.** Supported (creates `jfs_blob`), but the recommended data backends are real object stores. Structural issue: JuiceFS stores data as **blocks (≤4 MiB) = rows in `jfs_blob`**, so `npm install` produces **thousands of tiny rows** sharing the app DB's pool/WAL/autovacuum; Postgres can't shard the data out. [object storage](https://juicefs.com/docs/community/reference/how_to_set_up_object_storage/) · [storage design](https://juicefs.com/en/blog/engineering/design-metadata-data-storage)

3. **PostgreSQL metadata = supported but the slow tier.** Docs: Redis fastest; MySQL/PostgreSQL "average" (~2–4× Redis; up to ~13× on small I/O); SQL metadata ~600 B/file vs ~300 B/file Redis/TiKV. Postgres has **no multi-shard distributed txns** → "do not use a multi-server distributed architecture for the JuiceFS metadata"; run HA + a pooler. This many-small-files/high-churn/concurrent-sandbox profile is exactly where Redis is favored. [benchmark](https://juicefs.com/docs/community/metadata_engines_benchmark) · [pg best practices](https://juicefs.com/docs/community/postgresql_best_practices/)

4. **Per-run isolation & limits** — `--subdir` (subdir-as-root; CSI `subdir=` mountOption) or CSI **`pathPattern`** (templated per-PVC dir, needs CSI `--provisioner=true`). **Directory quotas are the hard cap**: `juicefs quota set $META --path <dir> --capacity <GiB> --inodes <N>` — over-capacity writes return `EDQUOT`; **`--inodes` bounds file count** (the guardrail vs a runaway `npm install`). Quotas are **CLI/metadata-only — no CSI/StorageClass field**, so run them out-of-band keyed on the instance id. [quota](https://juicefs.com/docs/community/guide/quota/) · [csi config](https://juicefs.com/docs/csi/guide/configurations/)

5. **Listing large trees** — recursive listing is **NOT cache-accelerated** ("readdir/ls cannot utilize" the entry cache); each `readdir` round-trips to Postgres. **Avoid `PROPFIND Depth: infinity`** over `node_modules`; browse lazily with **`Depth: 1`**. Raise `--attr/entry/dir-entry-cache` for repeat-browse comfort. [cache](https://github.com/juicedata/juicefs/blob/main/docs/en/guide/cache.md)

6. **Cleanup/GC** — `--trash-days` default 1; deleting files does **not** free space until trash expiry. Immediate reclaim: `juicefs config META --trash-days 0` (or `rmr` the `.trash`) → `juicefs gc --delete`. Postgres caveat: deleted `jfs_blob` rows free disk only via autovacuum (`VACUUM FULL` to shrink) — high churn bloats the table. [trash](https://juicefs.com/docs/community/security/trash/) · [gc](https://juicefs.com/en/blog/engineering/juicefs-garbage-collection)

7. **Read-gateway tuning** — enable **`--open-cache`** (docs recommend for read-only), SSD `--cache-dir`, generous `--cache-size`/`--buffer-size`, `--backup-meta=0` on the browse daemon. [cache](https://github.com/juicedata/juicefs/blob/main/docs/en/guide/cache.md)

8. **Security** — scope the daemon with **`--subdir=<run-dir>` + `--read-only`**; WebDAV auth = HTTP Basic (`WEBDAV_USER`/`WEBDAV_PASSWORD`, >v1.0.3) + TLS (`--cert-file`/`--key-file`); gateway auth = S3 creds + IAM `readonly` policy (v1.2+). [webdav](https://juicefs.com/docs/community/deployment/webdav/)

## Recommendations (priority-ordered)

0. **[SHIPPED #244] Lazy `Depth: 1` BFS listing** in `juicefs-webdav.ts`, never recursing into `node_modules`/`.git` — fixes the Files-tab hang (a single `Depth: infinity` walked 1700+ node_modules rows, ~90s timeout). Matches finding #5.
1. **Move DATA off Postgres to a real object store (MinIO in-cluster or S3) — highest impact.** Removes thousands of tiny `jfs_blob` rows + WAL/autovacuum pressure from the app DB; keep Postgres for metadata only. (Stacks: re-`juicefs format` `wfbcli` with `--storage minio --bucket … --access-key/--secret-key`; this is a data-migration, plan a clean cutover.)
2. **Consider Redis (or TiKV) for metadata** for the many-small-files/high-churn profile; if staying on Postgres, run it HA + pooled and tune autovacuum on the JuiceFS tables.
3. **Per-run quotas** — out-of-band `juicefs quota set --path <run-dir> --inodes <N> --capacity <GiB>` (keyed on the Dapr instance id) as the guardrail against runaway installs. No CSI field; do it via a Job/sidecar/hook.
4. **Deterministic per-run dirs via CSI `pathPattern`** (stamp instance id into PVC name/annotation; enable `--provisioner=true`) so quota/subdir scoping is addressable.
5. **Harden the webdav gateway**: `--read-only`, set `WEBDAV_USER/PASSWORD` (or per-run `--subdir` scoping), TLS or terminate at the cluster. (The BFF already confines reads to `/<daprInstanceId>/`, but the gateway itself currently exposes the whole fs unauthenticated on the ClusterIP.)
6. **Tune the gateway for read**: `--open-cache`, SSD `--cache-dir` + `--cache-size`, larger `--buffer-size`, `--backup-meta=0`, bumped `--attr/entry/dir-entry-cache`.
7. **Fix reclaim on run end**: `--trash-days 0` (or purge `.trash`) when reaping a run, periodic `juicefs gc --delete`, and ensure Postgres autovacuum keeps `jfs_blob` from bloating (until rec #1 lands).

**Quick wins** (gateway flags, low risk): #5 (`--read-only` + auth) and #6 (`--open-cache` etc.) are one-line edits to `Deployment-juicefs-webdav.yaml`. **Bigger infra**: #1 (data→object store) and #2 (metadata→Redis) are the real scaling fixes and warrant their own cutover.

**UI note:** because JuiceFS is close-to-open, the Files tab shows a run's *committed* files; a file a session is mid-write on may not appear until closed. The CLI Files tree also loads once per tab-open (no live refresh yet).
