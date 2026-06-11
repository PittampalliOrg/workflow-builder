# CLI conversation durability — making the interactive CLI's history durable + resumable

> **Status:** prototype **GO** (2026-06-11). Decision doc for persisting the interactive-cli runtime family's
> conversation history. Companion: `interactive-cli-sessions.md` (the CLI SSOT), `agent-runtime-comparison.md`.

## The problem

Two session types persist conversation history very differently:

| | **dapr-agent-py** session | **CLI** session (claude-code-cli / codex-cli / agy-cli) |
|---|---|---|
| Who drives the loop | the platform (Dapr activities) — it **owns the message list** | the **real CLI TUI** in a herdr pane — the CLI owns it |
| Durability granularity | per-activity | per-session (the Dapr workflow is only a **lifecycle wrapper**) |
| Where history lives | `entry.messages` in the Dapr **`dapr-agent-py-statestore`** (actor store), compacted for the 16 MiB limit | the CLI's own **transcript file** on the pod's ephemeral `emptyDir` (`$CLAUDE_CONFIG_DIR/projects/<cwd-hash>/<claudeSessionId>.jsonl`) |
| Durable record | yes — Dapr state, replayable | **no** — only a lossy mirror (assistant text + usage) in Postgres `session_events`; the raw transcript dies with the pod; no resume |

**Goal:** make a CLI conversation durable + resumable **without deconstructing the agent loop** (we want the real TUI, not a re-implemented loop). The user's framing: *can the CLI think it's reading/writing a file while the bytes actually persist in a database?*

## Why we can't make the CLI write to a store directly

The shipped `@anthropic-ai/claude-code` binary is **hardcoded to a transcript file**. The `claude-code-src` harness has internal storage hooks (`setInternalEventWriter`/`setInternalEventReader` — the "CCR v2" remote-session path), but those are **not exposed** by the npm CLI. So we can't redirect *where the CLI writes*. (The diagrid `claude_agents` example takes the opposite path — it *decomposes* the Claude SDK loop into Dapr activities and so owns the message list; that's exactly the loop-deconstruction we're avoiding.) `claude --resume <id>` rebuilds the conversation from the transcript JSONL if it exists in the project dir — so the lever is the **filesystem under the transcript path**.

## Options

| Option | Transparent | Real-time | PG/statestore-native | Native `--resume` | Size ceiling | Infra weight | Loop-preserving |
|---|---|---|---|---|---|---|---|
| **(0) DB-backed FUSE (JuiceFS-on-Postgres)** ✅ chosen | **yes** | yes | yes (Postgres) | yes (free) | none | medium (CSI/mount) | yes |
| (1) Statestore snapshot/restore | no | no (lifecycle boundaries) | yes | yes (with restore) | 16 MiB → gzip + Files offload | low | yes |
| (2) Files-API blob | no | no | Postgres (not "state") | yes (with restore) | 25 MiB | low | yes |
| (3) Per-session/user PVC | n/a (real files) | yes | no | yes | none | low–med (RWO scheduling) | yes |
| (4) Deconstruct loop / fork claude-code-src | — | — | — | — | — | high | **no** ❌ |
| (X) FusqlFS / Fuse::DBI | wrong shape (exposes DB *tables* as files) ❌ | | | | | | |
| (Y) LD_PRELOAD `read`/`write` shim | fragile on Node libuv (`preadv`/`pwritev`/threadpool) ❌ | | | | | | |

**(0) is the literal answer** to "can the CLI think it's reading a file while it persists in a DB": a POSIX FUSE filesystem whose bytes live in PostgreSQL ([JuiceFS](https://juicefs.com/) / [PGFS](https://vonng.com/en/pg/pgfs/) — `juicefs format --storage postgres` uses Postgres as **both** the metadata engine and the `jfs_blob` data table, **no object store**, with WAL/PITR). Mount it under the CLI's transcript path; the CLI does ordinary file I/O; native `claude --resume` + cross-pod durability come "for free." The Kubernetes blocker (FUSE needs `CAP_SYS_ADMIN`/`/dev/fuse`) is solved either by the production [juicefs-csi-driver](https://juicefs.com/docs/csi/introduction/) (mount pods stay privileged; the **workload pod is unprivileged**) or by [meta-fuse-csi-plugin](https://github.com/pfnet-research/meta-fuse-csi-plugin).

## Prototype findings (2026-06-11) — GO

A two-stage spike (fully isolated: throwaway docker + a local kind cluster; zero prod impact).

**Stage A — local feasibility (docker + Postgres + JuiceFS 1.3.1):**
- `juicefs format --storage postgres` works — **Postgres is both metadata and data** (`Data use postgres://…`); no object store needed.
- Wrote a 114,890-byte transcript → bytes land in `jfs_blob` (2 rows, 114,926 B). Unmounted; a **fresh container** remounted the same Postgres FS and read it **byte-identical** (sha256 matched).
- Append latency **~2–4 ms** per synced line — negligible for a transcript that grows a few lines per turn (PGFS itself targets "small file volumes, low access frequency," which fits).

**Stage B — Kubernetes (isolated kind cluster):**
- `interactive-cli` sandbox pods set **no `runtimeClassName` → default runc** (only `secure-gvisor` uses gVisor). **So gVisor is moot** — the scariest unknown is gone; CLI pods can run FUSE.
- Pod = a privileged **mounter sidecar** (`juicefs mount -o allow_other`, Bidirectional propagation) + an **unprivileged uid-10001 reader** (caps dropped, `allowPrivilegeEscalation:false`, `runAsNonRoot` — exactly our sandbox shape, HostToContainer propagation).
- The unprivileged container **read** a Postgres-backed transcript byte-identical, and (on a 10001-owned subtree) **wrote** its own transcript. After **deleting the entire pod**, a **fresh pod** read the unprivileged-written file back **byte-identical** from Postgres.

**Stage C — real dev cluster (Talos):**
- The `juicefs` DB + `wfbcli` FS formatted against the **real dev Postgres** (`juicefs format --storage postgres`).
- **FUSE works on Talos**: `/dev/fuse` is present on the dev node (the `fuse` module is loaded); an **inline privileged mount** of the PG-backed `wfbcli` FS succeeded and a write persisted (`MOUNTED-ON-TALOS`, `WRITE-OK`).
- The juicefs-csi-driver's mount-pod template hostPath-mounts `/etc/updatedb.conf` (`FileOrCreate`), which Talos's **read-only `/etc`** initially rejected (`mkdir … read-only file system`); `mountPodPatch` only **appends**, so it can't remove the volume. **BUT the driver has a built-in `JUICEFS_IMMUTABLE=true` env** (`cmd/{node,controller}.go` → `config.Immutable`) that, in `pkg/.../builder/pod.go`, **skips the `updatedb` host mount entirely** — purpose-built for immutable OSes.

**Conclusion: GO — (0b) the unprivileged juicefs-csi-driver works cleanly on Talos.** With `JUICEFS_IMMUTABLE=true` on the controller + node-driver, re-verified on the **real dev Talos cluster**: the mount pod runs with `updatedb` **skipped**, and an **unprivileged uid-10001** pod mounted `JuiceFS:wfbcli` at `/sandbox/.claude` and wrote a file that **persisted to Postgres** — **no Talos node change, no privileged container in the workload pod, transparent**. This is the ideal path.

### Integration details the spike surfaced (for the implementation)
1. Mount with **`-o allow_other`** + `user_allow_other` in `/etc/fuse.conf` so the unprivileged CLI container (uid 10001) sees the root-mounted FUSE.
2. `/dev/fuse` must exist in the mounter (mknod in a privileged mounter, or the CSI driver provides it).
3. The transcript subtree must be **owned/writable by the runtime uid** (10001): create + `chown` a **per-session subtree** at start (the CLI then owns the files it creates). Root-owned pre-existing files are read-only to uid 10001.
4. Mount mechanism choice: **juicefs-csi-driver** (recommended — no privileged container in the workload pod; mount pods managed by the driver) vs an inline privileged mounter sidecar (simpler, but one privileged container per session pod) vs meta-fuse-csi-plugin (generic).

## Implementation — (0b) unprivileged juicefs-csi-driver (chosen, proven on dev Talos)

The `juicefs` DB + `wfbcli` FS are formatted on dev Postgres; the driver mounts it transparently into **unprivileged** session pods (`JUICEFS_IMMUTABLE=true` for Talos). Steps:
- **Driver (GitOps):** an ArgoCD app for juicefs-csi-driver (pin v0.31.x) on dev → ryzen, with `JUICEFS_IMMUTABLE=true` on the controller + node-driver containers. Postgres backing: a dedicated `juicefs` DB + `wfbcli` FS (format Job) + a `juicefs-wfbcli` secret (`metaurl/storage/bucket/access-key/secret-key`); ryzen gets its own.
- **Per-session mount (sandbox-execution-api):** the `interactive-cli` class mounts the `wfbcli` FS at `$CLAUDE_CONFIG_DIR` (or `…/projects`) with **`subPath: <sessionId>`** + `allow_other`, subtree chowned to uid 10001 (the CLI then owns its transcript). The CLI's transcript + native `--resume`/`--continue` "just work" durably with **minimal cli-agent-py code**.
- **Resume:** spawn passes `resumeFromSessionId` → the new pod mounts the **same** `subPath` → `claude --resume <claudeSessionId>`. Generalizes to codex (`~/.codex/sessions`) / agy (brain transcript) since it's just the filesystem.
- **Scope/GC:** runc `interactive-cli` class only (not `secure-gvisor`); per-session `subPath` GC on session end; `jfs_blob` footprint monitoring.

Fallbacks kept in reserve (not built): **(0a)** an inline privileged mount sidecar (works on Talos but re-adds a privileged container), and **(1)** statestore snapshot/restore (no FUSE, cli-agent-py reuses its Dapr state client + Files-API offload).

### Lighter fallback (if the CSI rollout is deferred) — statestore snapshot/restore
cli-agent-py already writes a non-actor statestore (`services/cli-agent-py/src/cancellation.py` does sidecar `save_state`/`get_state` against `dapr-agent-py-statestore`). A best-effort `persist_cli_transcript` activity (gzip + 8 MiB inline guard + Files-API offload via `session_outputs.py`'s `/outputs/ingest`) at turn-completed/stop/`continue_as_new`, a `restore_cli_transcript` activity + `claude --resume` on a resume spawn, key `cli-transcript:<sessionId>`. Not transparent, but the same durability + user-initiated resume with far less infra.

## Cross-runtime continuity (CLI ↔ dapr-agent-py) — future, assessed

Handing a session between claude-code-cli and dapr-agent-py is feasible only as a **degraded/summary handoff** via `session_events` (the transcript tailer captures assistant text + usage only — tool turns and the `parentUuid` chain are lost), **not** lossless resume. The two representations differ (CLI JSONL parentUuid-DAG vs dapr `entry.messages` list); a faithful bridge would need a translation layer. Documented as a non-goal for now.
