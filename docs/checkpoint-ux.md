# Code Checkpoints — User Guide

Every run that edits a Git-backed workspace records **code checkpoints**: a
snapshot of the changes each mutating agent tool made (write / edit / patch /
shell). Checkpoints let you see exactly what the agent changed, restore an
earlier state, and branch a new run from any point. This page explains where
those surfaces live and how they fit together.

## The lifecycle at a glance

```
capture ─▶ durable push ─▶ diff ─▶ restore ─▶ fork / reproduce ─▶ PR
```

1. **Capture** — after a mutating tool call, the run commits the workspace and
   records the before/after SHAs, the changed files, and the tool that caused
   the change.
2. **Durable push** — when an in-cluster Git remote is configured, the commit is
   pushed so the checkpoint survives the sandbox. A checkpoint that has been
   pushed shows a **durable** label and a copyable ref; one that only exists in
   the sandbox shows **local only**.
3. **Diff** — each checkpoint renders a per-file diff on demand.
4. **Restore** — a durable checkpoint can be restored back into a live sandbox.
5. **Fork / reproduce** — start a new run from the step that owns a checkpoint,
   reusing the earlier work.
6. **PR** — the pushed refs are the basis for turning a run's changes into a pull
   request.

## Where to find them

### Run page → Code tab

The **Code** tab is the primary checkpoint surface. It is a master–detail view:

- **Left:** every checkpoint in run order, with a change summary
  (`A 2 M 1`), the SHA range, and a durability label.
- **Right:** the selected checkpoint's per-file diff. From here you can:
  - **Restore to sandbox** — apply a durable checkpoint's state into a live
    sandbox.
  - **Copy ref** — copy the pushed remote ref for use elsewhere (e.g. a PR).
  - **Fork from this checkpoint** — open the fork dialog preset to the step that
    produced this checkpoint (see below).

### Run page → Timeline tab

Checkpoint **markers** are interleaved into the Timeline feed in event order:
an icon, the tool name, and a `+added / -removed` chip. Click a marker to jump
straight to that checkpoint in the Code tab.

### Session page → Code & Changes

A session's detail page has a collapsible **Code & Changes** panel showing the
parent run's checkpoints scoped to that session, with the same per-file diff.
Use **Open in run page → Code tab** to see the full run context.

## Fork vs. Reproduce

Forking starts a **new run on an isolated copy** of the source run's workspace.
Earlier steps are skipped (their work is reused); only the chosen step onward
re-runs. The fork dialog lets you:

- **Pick the fork point** — choose any completed step (workflow node or script
  call). A failed run defaults to the failed step; a successful run defaults to
  the last completed step.
- **Choose a mode:**
  - **Reproduce** — re-run the selected steps **unchanged**, a deterministic
    baseline.
  - **Fork** — re-run with your **current** (possibly edited) workflow, to
    iterate.
- **See what you reuse** — the dialog reports how many steps, and (for
  dynamic-script runs) how many tokens, of prior work the skipped prefix reuses.

You can open the fork dialog from the run header (**Fork from step**), the
canvas (**Fork from here** on a node), or a checkpoint's **Fork from this
checkpoint** action.

## Provenance chips

Forked and seeded runs carry provenance **chips** that read the same everywhere
they appear — the run header, the fork-lineage tree, and the runs list:

- **`fork @<step>`** — this run was forked/resumed from an earlier run at a step.
- **`snapshot-seeded`** — the fork was seeded from a node-boundary snapshot (a
  consistent fork) rather than the source's end-state workspace.
- **`reproduce`** — a deterministic replay (shown when the run recorded a
  reproduce trigger source).

## Consistent forks (snapshots)

When node-boundary snapshots are available, a fork is seeded from the snapshot
of the last reused step so re-run steps see exactly the file state they would
have seen in the original run. This is what the **snapshot-seeded** chip
indicates. Without a snapshot, the fork falls back to seeding from the source
run's end-state workspace.

## Notes & limitations

- A checkpoint is only **durable** once its commit is pushed to the in-cluster
  Git remote; sandbox-only checkpoints are lost when the sandbox is reaped.
- The **reproduce** chip depends on the backend persisting a `reproduce` trigger
  source on the new run. The resume endpoint currently records `resume` for all
  resume/fork starts; until a dedicated reproduce trigger source is persisted,
  the reproduce chip will not light up even though the dialog mode is honored for
  the run itself.
- Session-scoped checkpoint filtering uses the checkpoint's session id or sandbox
  name. Older checkpoints without that linkage are shown unfiltered.
