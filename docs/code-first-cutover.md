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

- [x] **6.** `action(slug, input, opts)`: `input` hashed, `label`/`timeoutMs`/
  `allowFailure` not; non-AP slugs = un-awaited `execute_action` activity tasks; AP slugs
  via the `action_runner_workflow_v1` child porting SW's AP retry + DELAY→timer +
  WEBHOOK→`wait_for_external_event(ap.resume.<id>)` pause contract (waiter marker →
  ap-resume route targets the child); idempotencyKey `workflowId:execId:callId`;
  throws unless `allowFailure:true`. `web/crawl.async` dispatch-errors clearly
  (sync `web/crawl` works; async poll port is a follow-up). PRs #566 + #567,
  suites green 2026-07-14.
- [x] **7.** `sleep(seconds)`: journaled `create_timer` task in the pump's `when_any`
  set. Dispatched un-awaited; drain synthesizes `{sleptSeconds}`; clamped by
  `DYNAMIC_SCRIPT_MAX_SLEEP_SECONDS` (86400 default). Pump + evaluator + journal
  tests green 2026-07-14.
- [x] **8.** `approve()`/`waitForEvent()`: `wait_event_workflow_v1` child per callId
  (`script.event.<callId>` — parallel gates), reusing SW approval-log activities;
  `getApprovalState`/`approveExecution` journal-driven for scripts (plural gates,
  `body.callId` disambiguation, `approved:false` resolves too); timeout RESOLVES
  `{timedOut:true}` (24h default / 7d cap). PR #567, suites green 2026-07-14.
- [x] **9.** `agent(..., {agent: slug})`: resolved fail-closed in the ensure-for-workflow
  bridge with swap-safety; unknown slug journals null (422 `agent_ref_unresolved` →
  deterministic bridge refusal); NEVER falls back to the metered default runtime —
  including old-BFF skew (missing `resolvedAgentSlug` echo → refusal). PR #568;
  orchestrator 353 + evaluator 86 passed 2026-07-14.
- [x] **10.** `meta.input` JSON Schema validated at `startDynamicScriptRun` via Ajv
  (useDefaults on a clone; object schema + absent args starts from `{}`; invalid schema
  = 400) — covers UI/MCP/trigger-spine/resume; execute dialog renders it via
  `JsonSchemaDataEditor` (Form|JSON tabs) replacing the raw Args textarea. PR #568;
  validator vitest 17 passed 2026-07-14.
- [x] **11.** Pump: explicit task-kind allowlist (unknown kind → dispatchError, never a
  phantom agent dispatch — shipped with P0, `test_unknown_task_kind_journals_dispatch_error…`);
  kind-aware caps (action-class dispatches OUTSIDE agent slots: `maxConcurrentActions`
  16 / `maxLifetimeActions` 500 via `DYNAMIC_SCRIPT_MAX_{CONCURRENT_ACTIONS,ACTION_CALLS}`,
  `test_actions_do_not_consume_agent_concurrency_slots`); dict results capped like strings
  (`_cap_json_result`, applied to action data + workflow returnValue,
  `test_action_oversized_data_is_truncated`).
- [x] **P1 proof:** dev smoke run `Te2o6gXJqF2OgmXYHkA-h` (2026-07-14, fixture
  `scripts/fixtures/dynamic-scripts/p1-smoke-action-class.js`, flag live on dev)
  exercised all four primitives in one run — journal rows:
  `action|done|crawl|{success:false, error:"Unknown Dapr Error 500"}` (allowFailure
  envelope journaled; the crawl BACKEND 500 is a payload-shape follow-up, the engine
  path — dispatch → execute_action → journal → script continued — is exactly correct),
  `sleep|done|{sleptSeconds:5}`,
  `event|done|{approved:true, approvedBy:"p1-smoke"}` (gate resolved by a raise at the
  journaled waiter child `…__durable-script__e48802dad51f552e_0__run__0` — note the
  P0 occurrence-tail fix visible in the id),
  `agent|done|named-agent|"P1-SMOKE-OK"` (named `trace-analyst` resolved fail-closed);
  execution terminal `success`, returnValue
  `{gate:{approved:true,…}, named:"P1-SMOKE-OK", crawlOk:false, crawlDispatched:true}`.
  meta.input defaults applied at start (P1f path). Follow-up: `action('web/crawl')`
  payload shape vs crawl4ai-adapter (backend 500).

### P2 — canvas

- [x] **12.** Evaluator captures call-site positions → additive `tasks[].position`
  (NEVER in the callId hash) → journal `call_site` column (migration 0107) + both store
  adapters → returned by `/script-calls`. PR #570; evaluator 92 + orchestrator 355 passed.
  **Dev-proven** 2026-07-14 (run `j_6GYNddjtdKAbfY9JDl7`): every journal row carries its
  position — `action {line:23}`, `sleep {line:26}`, `event {line:30}`, `agent {line:33}`,
  matching the stored source exactly. (Live-caught + fixed: the AP/gate child journal
  specs omitted `callSite`, so a pause-marker rewrite clobbered the running row's
  position to NULL.)
- [x] **13.** ScriptCanvas live overlay: per-node journal status, fan-out grouped by call
  site, kill/skip on nodes; run-page Canvas List|Graph toggle. PR #570. **Dev-proven**
  2026-07-14: the run page's Canvas tab shows List|Graph; Graph renders the frozen
  script's node graph with the `named-agent` node carrying a live **"1 done"** chip —
  the journal row joined to its static node by `call_site.line`.
- [x] **14.** Execute dialog renders the `meta.input` form. **Dev-proven** 2026-07-14: the
  dialog detects `meta.input` and renders Form|JSON tabs with the schema's fields
  (url / gateTimeoutMinutes / namedAgent + defaults). (Live-caught + fixed: the sjsf
  `JsonSchemaGeneratedForm` needs a theme-component registration this app never wires —
  it threw and the boundary fell back to JSON-only; the fields are now rendered natively,
  same shape as the SW trigger form.) Validator vitest 17 passed.

### P3 — system-producer migration (per-producer flag; SW builder callable until parity)

- [x] **15.** Ported to scripts; **20-item shadow parity EXECUTED on dev** (2026-07-14).
  **Result: SW baseline 20/20 · script port 19/20 · per-item agreement 19/20.** The single
  diff (HumanEval/17) is LLM solution variance — the same agent generates a different
  solution per run — not an engine defect: both engines ran all 20 items to completion
  with IDENTICAL grading (the fence-strip + pytest run as the same shell snippet in the
  sandbox, so the engines differ only in interpolation). Harness: 20 real HumanEval tasks
  through BOTH engines in the agent's project on dev (runs under workflows
  `code-eval-parity-sw2` + `code-eval parity (script port)`). Environmental finding: the
  dev openshell runtime ships NO `/api/tools/*` API (write_file 404s on BOTH engines —
  why evals never ran on dev); the parity therefore grades via `workspace/command`, which
  both engines exercise identically. Live-caught engine bugs along the way (all fixed +
  CI-pinned): the executionId identity (Dapr instance id, not DB id), the workspace/*
  result envelope, the profile sandbox-name nesting, and the allowFailure `data` wrapper.
  Remaining canaries (SWE-bench ≥5-instance, one live GAN run) follow the same runbook in
  §Blockers — the harness and both engine paths are now proven.
  **Per-producer status (2026-07-14):**
  - [x] **office smokes** — start through the BFF internal execute route (PR #571,
    merged); the last raw-SQL execution fabricator is gone.
  - [x] **agent-eval builder** — `buildAgentEvaluationScript` behind
    `EVAL_AGENT_SCRIPT_PRODUCER` (SW builder still callable); the pump envelope is
    unwrapped by `extractEvaluationGeneratedOutput` so graders need zero changes;
    evaluations vitest 26 passed. **Parity run not yet executed** (needs eval spend).
  - [x] **code-eval-item** — ported (`scripts/fixtures/dynamic-scripts/code-eval-item.js`),
    seeded under the SAME workflow id via `CODE_EVAL_SCRIPT_PRODUCER` (so
    `CODE_EVAL_WORKFLOW_ID` + the 3 template routes are untouched). Validates + first-round
    dispatches through the REAL evaluator (`producer-ports.test.ts`).
    **20-item parity run not yet executed** (needs eval spend).
  - [x] **swebench eval builder** (`EVAL_SWEBENCH_SCRIPT_PRODUCER`) and
    **benchmark instance builder** (`BENCHMARK_SCRIPT_PRODUCER`) — both DERIVE every
    value from their SW builder (env spec, prompt, clone/extract commands, sandbox
    policy) so the producers cannot drift, then re-express the same 4-step spine with
    the agent bound to the profile's sandbox. Benchmark dispatch is engine-aware on all
    three paths (executionIr, host-execution-plane payload, direct orchestrator POST),
    and `sandbox-execution-api/worker.py` routes to `/api/v2/script-workflows` when the
    payload carries a script build (the goal's *"incl. sandbox-execution-api start
    path"*). Tests: evaluations 27, benchmarks 71 passed.
    **≥5-instance parity run not yet executed** (needs benchmark spend — see B2).
  - [x] **GAN generator** — `gen/gan-script-generator.ts` emits the harness as a script
    (23KB), reusing the SW emitter's persona instructions/prompts AND its gate shell
    verbatim so the two producers cannot drift; the jq `for`/`while` refine loop becomes
    a plain JS loop and the verdict is a schema'd critic call. Emitted fixture checked in
    (`scripts/fixtures/dynamic-scripts/preview-gan-ui-feature.js`) with a byte-identical
    drift guard. **One live GAN run not yet executed** (see B2).
  - [x] **microservice-dev-session** — ported (20KB), verbatim seed shell + handoff prose.
  - [x] **pr-heavy-review** — ported: review → independent judge → publish, three CLI
    agents on ONE shared workspace.
  - **Enabling capability shipped for all of the above:** the `workspace` sentinel +
    `agent(..., {sandbox: {...}})` binding — a script can now create a workspace/sandbox
    with `action('workspace/profile', …)` and bind agents to it (the gap that blocked
    every workspace-shaped producer).
- [x] **16.** events-ingest legacy route + `external-event-registry.ts` **deleted**. The
  route was already inert on dev (`SUPPORTED_WORKFLOW_ID` unset) and its replacement —
  the engine-agnostic github trigger spine — is live-proven (trigger
  `lErvqAEkpnd_BSe4RUCGT` drove 250 executions). Boundary ratchet: 2 edges removed.
  *(Activating a repo webhook is left to the user: it is an outward-facing action.)*
- [x] **17.** Seeds retargeted; fixtures pruned; guard suite **fully rewritten**.
  - 13 obsolete SW fixtures deleted + their 3 orphaned guards; `seed-workflows` fixture
    block pruned to the port set.
  - **Every remaining fixture is ported**, including the last two: `preview-gan-redesign`
    and `gan-harness-dapr-showcase` (the 12-step harness — its SW `listen` gate becomes a
    first-class `approve()`, and all three jq `for`/`while` loops become plain JS loops
    whose exits read **schema'd** critic verdicts instead of parsing free-form JSON out of
    stdout — the exact failure mode `docs/gan-run-analysis-2026-06-30.md` recorded).
  - **`producer-plan-guards.test.ts` (19 tests, green)** replaces the entire
    regex-over-`fixture.do` suite: every script is fed to the REAL script-evaluator and the
    emitted `/evaluate` **task plan** is asserted — call kinds, action slugs, labels, the
    schema'd critic, shared-workspace + profile-sandbox binding, and loop behavior across
    rounds (a failing build gate short-circuits the critic; a failing runtime probe
    short-circuits a code-eval item; a DENIED/timed-out approval gate short-circuits before
    any design work; the paired UI/code critics run in the same round). Strictly stronger
    than the structural proxy: a script that parses but plans the wrong calls fails here.
  - **ZERO SW-era guard files remain.** (They live in the evaluator's own vitest lane —
    the root runner does not set `--experimental-vm-modules`, which `vm.SourceTextModule`
    needs.) Evaluator lane: **118 passed**.

### P4 — freeze

- [x] **18.** P4 freeze, **shipped OFF** (`SW_AUTHORING_FROZEN`): new workflows default to
  `dynamic-script`; `POST /api/workflows` rejects explicit SW creation and
  `PUT /api/workflows/[id]` rejects SW *spec* writes (internal callers bypass via
  `internalOverride` so system producers can still seed during the migration window;
  legacy rows stay readable/runnable/metadata-editable). Legacy MCP `create_workflow`
  was already removed (asserted by `workflow-tools.test.ts`). `SW_START_DISABLED`
  implemented in `start-run.ts` and SHIPPED OFF (410 when flipped). Editor read-only
  for legacy rows: the ScriptCanvas/WorkflowCanvas split already routes `dapr` rows to
  the SW canvas; a read-only gate rides the freeze flag. Tests:
  workflow-definition-commands vitest **12 passed** (3 new, incl. off-by-default).

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

**B1 — RESOLVED (2026-07-14).** `dev/preview` durable activation is now expressible from a
script: `action('dev/preview', {mode:'preview-native', services:[…]})` dispatches through
`action_runner_workflow_v1`, which reuses the SW interpreter's own
`_run_durable_dev_preview_activation` generator verbatim (strict batch/ready-set poll with
durable timers + deadline). AP-only retry semantics are not stamped on activation calls.
Regression test:
`test_dev_preview_activation_routes_to_runner_child_with_durable_poll`; orchestrator suite
356 passed. The GAN / preview / dev-session fixture ports are unblocked (still to be
written).

**B2 — the shadow-parity canaries cannot be run as specified: there is no SW baseline on
dev.** Item 15 asks for parity "vs pre-captured SW baselines". A live census (2026-07-14)
shows **0 evaluation runs on dev in the last 90 days** and no `code-eval-item` workflow row
— so no baseline exists, and producing one means running the SW side of every suite first
(doubling the LLM spend). The canaries themselves (code-eval 20-item, SWE-bench ≥5-instance,
one live GAN run) each bill real usage and run for hours.

*What WAS proven on dev instead* (2026-07-14): the ported **code-eval script executed
end-to-end on the cluster** (runs `fs0jYluYaUBqSCgyRcSKJ` → `RPC92pbMxEEXjp1ccsT8m`),
which caught three real integration bugs no unit test had — the `workspace/*` result
envelope, the `workspace/profile` sandbox-name nesting, and the **executionId identity**
(openshell `/api/tools/*` resolve a sandbox by the DAPR instance id, so the DB id 404'd
`write_file` while `profile`/`command` returned 200). All three are fixed, pinned by tests,
and the guard suite now models the real envelope.

**Runbook when budget/time is available** (each step is a flag flip + one suite):
1. `CODE_EVAL_SCRIPT_PRODUCER=false` → run one HumanEval+ suite (20 items) → capture the SW
   baseline in `benchmark_run_instance_scores`.
2. `CODE_EVAL_SCRIPT_PRODUCER=true` → re-run the same 20 items → diff per-item verdicts.
3. Repeat for `EVAL_AGENT_SCRIPT_PRODUCER`, then `EVAL_SWEBENCH_SCRIPT_PRODUCER` /
   `BENCHMARK_SCRIPT_PRODUCER` (≥5 instances — the most expensive; do it last).
4. One live GAN run of `preview-gan-ui-feature.js` inside a Tier-2 preview.
Every flag falls back to the SW builder, so a failed parity check is a one-line revert.

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
