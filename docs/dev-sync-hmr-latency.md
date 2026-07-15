# Dev-sync HMR latency architecture

## Decision

Keep the capability-scoped HTTP dev-sync transport and change its filesystem
transaction from whole-root replacement to file-granular reconciliation.

The agent still sends a complete snapshot of the catalog-owned roots. The
receiver still validates the archive, enforces the exact root contract, stages
the complete snapshot, propagates deletions, fences generations, and rolls back
failed commits. The commit now renames only changed files or wholly added and
removed subtrees. Matching directories and byte-identical descendants stay in
place.

This is the smallest change that preserves the preview lifecycle and security
model while fixing the dominant HMR cost. Linux filesystem watches follow
inodes; replacing a watched `src` directory invalidates the useful watcher
identity and presents one source edit as a tree-wide delete/add storm. See the
[inotify documentation](https://man7.org/linux/man-pages/man7/inotify.7.html)
and [Node `fs.watch` caveats](https://nodejs.org/api/fs.html#fswatchfilename-options-listener).

## Measured baseline and result

The dev-cluster incident that prompted this change kept the workflow-builder
pod and Vite PID alive, but a one-line UI edit replaced the entire `src` tree.
Vite processed unrelated route/config changes and the application was not ready
again for about 114 seconds.

A local full-root benchmark on 2026-07-13 used the real workflow-builder sync
set: a 7,105,576-byte compressed archive and 2,638 files below `src`.

| Operation | Receiver apply | HTTP wall time | Changed paths |
| --- | ---: | ---: | ---: |
| Initial materialization | 177 ms | 222 ms | 15 roots |
| One existing `.svelte` edit | 251 ms | 267 ms | 1 file |

The second apply spent 91 ms validating, 93 ms staging, 46 ms comparing, and
1 ms committing. The `src` inode and an unchanged sibling inode remained
stable. A fresh dev-vCluster canary remains the authoritative HMR measurement.

## Hexagonal boundary

- `scripts/dev-sync/sync.sh` is the producer adapter.
- `server.mjs` and the Vite plugin are inbound HTTP adapters.
- `applyAtomicDevSync` is the filesystem transaction contract. The zero-build
  sidecar carries its plain-JavaScript runtime twin and Vite carries the typed
  twin; equivalent regression suites guard them until packaging permits one
  portable implementation.
- The dev-preview sidecar port carries status and phase timings to the
  application service and Dev UI. The UI value is the most recent receiver
  apply sample, not an end-to-end HMR percentile; the wet canary establishes
  p95.
- Preview provisioning, vCluster isolation, capture, and GitOps promotion do
  not own or implement filesystem reconciliation.

The producer serializes invocations per checkout and prepares the complete
multi-service archive set before the first POST. It retains a failed generation
for exact replay, using each receiver's `(generation, archive digest)`
idempotency contract. Per-service `APPLIED` output is only a receipt; the producer
emits `SYNCED` after every selected receiver reports the same generation and the
application health barrier passes. Strict capture remains the server-side guard
that rejects any temporary mixed set.

The architecture deliberately does not give preview agents `kubectl`,
`pods/exec`, or deployment ownership. The scoped sync capability remains the
only write port into the throwaway runtime.

## Current transaction

1. Buffer and hash the upload.
2. Validate archive members, sizes, types, and exact declared roots.
3. Extract to a hidden transaction directory on the pod-local runtime volume.
4. Build a deterministic add/replace/delete/chmod plan by comparing staged and
   live content.
5. Reflink or copy each changed regular file into the private rollback area,
   then atomically rename its staged replacement over the live path. This avoids
   the false watcher event caused by changing a live inode's hard-link count.
   Additions, deletions, and type changes use path renames. Preserve matching
   directories and files, temporarily widening read-only transaction parents
   and restoring their intended modes parent-last.
6. Persist the generation marker last. On failure, restore mutations in reverse
   order and withhold the failed generation.
7. Report bounded changed-path diagnostics and validation/staging/planning/
   commit timings.

Vite ignores transaction, generation-state, and restart-signal metadata. New
route files retain the existing explicit one-restart slow path; editing an
existing route is ordinary HMR. A multi-file generation is rollback-capable but
becomes visible one path at a time; it is not a globally atomic filesystem
snapshot. The convergence barrier is the point at which callers treat the
generation as ready.

## Follow-up thresholds

Do not add a more complex sync engine until the wet canary shows which remaining
stage dominates.

1. **Content-manifest delta protocol:** add only if full-snapshot transfer plus
   comparison exceeds 1 second at p95, or source trees grow enough to make it a
   material part of the loop. A delta must carry explicit tombstones and a base
   generation; a mismatch falls back to a full seed. Absence in a delta must
   never imply deletion.
2. **Parallel service fanout:** add if multi-service packaging/upload exceeds 1
   second. Keep one logical generation and per-service result files, then retain
   the current all-service convergence barrier.
3. **Sibling transaction mount:** if `uvicorn` or `tsx` reacts to hidden staging
   paths, reshape the shared `emptyDir` as `work/` plus `transactions/`, mounting
   only `work/` into the application container. Final temp files must remain on
   the same filesystem for atomic rename.
4. **Debounced automatic sync:** add a 100-250 ms producer debounce only after
   interactive edit streams exist. Keep `sync.sh` as the coherent manual
   checkpoint and capture boundary.

## Alternatives

- [Skaffold file sync](https://skaffold.dev/docs/filesync/) remains appropriate
  for the trusted Ryzen operator loop, but direct use would give preview agents
  Kubernetes credentials and couple the inner loop to deployment ownership.
- [DevSpace file sync](https://www.devspace.sh/docs/configuration/dev/connections/file-sync)
  is intentionally not the platform adapter. Its mature continuous-sync loop
  is useful for a trusted human workstation, but agent use would require
  kubeconfig and pod-exec authority and would not preserve the generation,
  rollback, capture/export, and structured convergence contract.
- [Tilt Live Update](https://docs.tilt.dev/live_update_reference.html) has the
  right conceptual split between sync, run steps, and rebuild fallbacks, but its
  controller would duplicate the existing preview controller.
- `kubectl cp` requires exec-level access and `tar` in the target container.
- `rsync --inplace` is unsuitable because application readers can observe
  partially written files; the [rsync manual](https://download.samba.org/pub/rsync/rsync.1)
  recommends the default temporary-file replacement behavior when that matters.
- JuiceFS remains the durable workspace/checkpoint tier, not the watched runtime
  filesystem. HMR source stays on pod-local `emptyDir` storage.

## Acceptance

- Existing UI edit visible through the preview URL within 5 seconds at p95.
- `src` inode, unchanged-file inodes, pod UID, and container restart counts stay
  unchanged for an ordinary edit.
- Receiver reports exactly the edited path and a bounded phase-timing record.
- No Vite full restart or readiness loss for an existing-file edit.
- New route addition causes exactly one intentional restart.
- Python and Node backend edits reload without replacing the workdir.
- Additions, deletions, no-op generations, export/capture, and injected rollback
  failures retain their existing semantics.
- A fresh preview consumes immutable workflow-builder-dev and dev-sync-sidecar
  digests built from the merged source SHA.
