# Code-First Cutover (SW 1.0 → dynamic-script) — Program SSOT

**Status:** IN PROGRESS (P0). Phases P0–P4; **P5 deletion is soak-gated and out of scope
for this program** (30 days / ≥2 release cycles after the P4 freeze).
**Decision record:** 2026-07-14 architecture review (17-agent deep-read of both repos +
live dev-DB census + evaluator sandbox repro). This document is the single source of
truth for the cutover; update the checklist as items are *proven* (tests green, dev
verified at pod level), not merely coded.

## The decision, in two sentences

The CNCF Serverless Workflow 1.0 interpreter (`sw_workflow_v1`, ~4,700 lines) is retired
for **user-facing** authoring in favor of the dynamic-script engine; the five dialect
gaps that keep system producers on SW (deterministic actions, sleep, approval gates,
named agents, input schemas) are closed **inside the pump model**, not by registering
user code natively. Native per-script Dapr registration was adversarially evaluated and
**refuted**: durabletask forbids registration after worker start, the JS SDK cannot
dispatch cross-app agent sessions (no app-id on `callChildWorkflow`), positional replay
breaks on edit (losing resume-after-edit/skip/budget), and it would move user code inside
the platform trust boundary — while the pump costs <1% of wall-clock.

## The two-lane principle

- **User workflows = scripts as data.** Authored/edited at runtime, executed by the ONE
  registered `dynamic_script_workflow_v1` pump re-executing the script in the zero-secret
  `script-evaluator` sandbox against the content-addressed `workflow_script_calls`
  journal. This is the only design that preserves runtime authoring, resume-after-edit
  (longest-unchanged-prefix journal import), per-call skip, budget authority, and the
  trust boundary. It is also the convergent industry design (Temporal/Restate/Inngest/
  Windmill all interpret user-editable definitions; Inngest's hashed step IDs ≈ our
  content-addressed callIds).
- **Platform workflows = native code in git.** Registered before `wfr.start()`, reviewed
  by PR, versioned by image — the `evaluation-coordinator` pattern. `sw_workflow_v1`,
  `dynamic_script_workflow_v1`, `team_join_workflow_v1`, and `session_workflow` are
  themselves lane-2 citizens.

## Checklist (goal items 1–18)

Mark an item `[x]` only when its proof has landed (command output in a PR/CI/session
transcript). Keep this list in sync with the active `/goal`.

### P0 — prep

- [x] **1.** This document committed (program checklist + two-lane principle).
- [x] **2.** `script_agent_dispatch.py` child-id collision fixed — the fragment now keeps
  the `_<occurrence>` tail (callId chars 40+) that `[:16]` dropped; pytest proves two
  identical un-labeled `agent()` calls (occurrence `_0`/`_1`) get DISTINCT child
  instance/session ids and dispatch as distinct pump children
  (`test_duplicate_prompt_occurrences_get_distinct_child_ids`,
  `test_duplicate_prompt_agent_calls_dispatch_distinct_children`; suite 328 passed
  2026-07-14).
- [x] **3.** `sw_workflow.py` imports `SWExpressionError` (caught at the artifacts error
  path ~:4036; was a latent NameError). Exercised by the full pytest suite import.
- [x] **4.** Contract `1.1.0 → 1.2.0` additive (reserves task kinds `action`/`sleep`/
  `event`, agent semanticOpts key `agent`, advisory `tasks[].position`); callid vector
  test proves existing callIds byte-identical; evaluator vitest (73 passed) +
  orchestrator pytest (328 passed) both updated and green 2026-07-14.
- [x] **5.** stacks: `script-evaluator` replicas 1→2 + PDB (it is a hard start-path
  dependency — `validateWithEvaluator` runs with `degradeOnUnavailable:false` on every
  script start). Merged as stacks PR #4187 (`a02f63bb7`); dev verified 2026-07-14:
  2 Ready script-evaluator pods, surge-only strategy live, PDB ALLOWED DISRUPTIONS
  behaving (`kubectl --context dev rollout status` clean).

### P1 — dialect gaps (all behind `DYNAMIC_SCRIPT_ACTIONS_ENABLED`)

- [ ] **6.** `action(slug, input, opts)`: `input` hashed, `label`/`timeoutMs`/
  `allowFailure` not; non-AP slugs = un-awaited `execute_action` activity tasks; AP slugs
  via a new `action_runner` child porting SW's AP retry + DELAY→timer +
  WEBHOOK→`wait_for_external_event(ap.resume.<id>)` pause contract; idempotencyKey
  `workflowId:execId:callId`; throws unless `allowFailure:true`.
- [ ] **7.** `sleep(seconds)`: journaled `create_timer` task in the pump's `when_any` set.
- [ ] **8.** `approve()`/`waitForEvent()`: wait_event child per callId, reusing SW
  approval-log activities; approval routes journal-driven for scripts; timeout RESOLVES
  `{timedOut:true}`.
- [ ] **9.** `agent(..., {agent: slug})`: resolved fail-closed in the ensure-for-workflow
  bridge with swap-safety; unknown slug journals null; NEVER falls back to the metered
  default runtime.
- [ ] **10.** `meta.input` JSON Schema validated at `startDynamicScriptRun` (covers the
  trigger spine) + rendered as an execute-dialog form.
- [ ] **11.** Pump: explicit task-kind allowlist (unknown kind → dispatchError, never a
  phantom agent dispatch); kind-aware caps (actions/sleeps/gates don't consume agent
  slots); dict results capped like strings.
- [ ] **P1 proof:** tests green + one dev smoke run exercising
  `action()`+`sleep()`+`approve()`+named agent, journal rows shown.

### P2 — canvas

- [ ] **12.** Evaluator captures call-site positions → additive `tasks[].position`
  (NEVER in the callId hash) → journal `call_site` column + migration → returned by
  `/script-calls`.
- [ ] **13.** ScriptCanvas live overlay: per-node journal status, fan-out grouped by call
  site, kill/skip on nodes; run-page Canvas List|Graph toggle.
- [ ] **14.** Execute dialog renders the `meta.input` form. Proof: vitest green + DOM
  evidence on a live dev run.

### P3 — system-producer migration (per-producer flag; SW builder callable until parity)

- [ ] **15.** Ported to scripts with dev shadow-parity vs pre-captured SW baselines:
  agent-eval builder; code-eval-item (SAME workflow id, 20-item parity); swebench eval +
  benchmark builders (≥5-instance parity incl. the sandbox-execution-api start path); GAN
  generator (one live GAN run green); microservice-dev-session; pr-heavy-review; office
  smokes via BFF internal execute.
- [ ] **16.** events-ingest legacy route deleted AFTER a replacement github trigger row
  is live.
- [ ] **17.** Seeds retargeted to ported scripts; 13 obsolete SW fixtures deleted; the
  348-expect guard suite rewritten against evaluator `/evaluate` plan output, green.

### P4 — freeze

- [ ] **18.** engineType default → `dynamic-script`; POST/PUT reject new SW specs
  (internal override header); legacy MCP `create_workflow` removed; `SW_START_DISABLED`
  flag implemented but SHIPPED OFF; editor read-only for `engineType=dapr` rows.

## Constraints (binding for every phase)

- Never alter the frozen callId derivation for existing kinds — additive semanticOpts
  keys only (absent keys are omitted from canonicalJSON, so existing hashes are stable).
- Deploy orchestrator before/with evaluator: the pre-1.2.0 pump defaults unknown task
  kinds to `agent`, so a new evaluator against an old orchestrator would dispatch
  phantom empty-prompt agent sessions.
- Every phase flag-reversible; nothing is deleted before P5.
- ArgoCD-only deploys (no `kubectl set image`); dev cluster only for this program.
- Do NOT delete `sw_workflow.py`, the code-emitter, or `spec-graph-adapter.ts` — the
  first two go in P5; the graph adapter stays indefinitely as the frozen legacy run view
  for historical SW executions.

## Deploy notes

- **Item 2 (child-id derivation)** changes ids the workflow code computes: completed
  children replay from history unaffected (child replay validation checks names, not
  instance ids), but runs in flight AT rollout get skewed skip/stop targeting until they
  finish. Roll out in a quiet window, dev first; check no long fan-out is mid-flight
  (`workflow_executions` running + `workflow_script_calls` non-terminal).
- **Contract rollout order:** orchestrator (accepts 1.1 and 1.2 responses) → evaluator.

## Blockers

*(none — record here any blocker persisting 3 consecutive turns, then stop per the goal)*

## References

- `docs/workflow-execution-architecture.md` — the pre-implementation options analysis
  (its Option C2 is what shipped, done safely out-of-process).
- `docs/dynamic-script-workflows.md` — engine SSOT (pump, journal, callId contract).
- `docs/dynamic-script-authoring-guide.md` — dialect SSOT (update as P1 primitives land).
- `services/shared/contracts/script-evaluator-evaluate.contract.json` — frozen exchange
  contract (1.2.0 additive line).
- Dev-DB census 2026-07-14: 130 dynamic-script vs 62 SW rows, zero user-authored SW,
  SW runs 278/wk → 3/wk after scripts landed; all 4 triggers target SW (3 inactive,
  1 never fired) — the user-data migration burden is ~zero; producers are the work.
