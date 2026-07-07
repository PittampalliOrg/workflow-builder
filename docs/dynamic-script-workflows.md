# Dynamic Script Workflows (SSOT)

User-authored JS orchestration scripts — a port of Claude Code's internal Workflow tool —
executed durably on Dapr. Scripts use `agent()`, `parallel()` (barrier), `pipeline()`
(per-item staged, no barrier), `phase()`/`log()`, `workflow()` (one-level nesting), and the
globals `args` + `budget {total, spent(), remaining()}`. Shipped wfb #446–#449 + stacks
#3613/#3614/#3619; verified end-to-end on dev 2026-07-07.

## Architecture — the re-execution pump

The JS script cannot run inside the Python generator orchestrator, so
`dynamic_script_workflow_v1` (workflow-orchestrator) loops:

1. `aggregate_script_usage` — budget spend (Σ `agent.llm_usage`, goal-loop net-of-cache formula)
2. `evaluate_script` — the activity loads the journal from the BFF and POSTs the whole
   request to the stateless **script-evaluator** Node service, which re-executes the ENTIRE
   script in a `vm.SourceTextModule` sandbox (clock/RNG banned), resolves journaled calls
   from `completedResults`, and returns `{status: need|done|script_error, tasks, phases,
   newLogs}` with only NEW callIds
3. dispatch each new task through the standard `durable/run` machinery
   (`spawn_session_for_workflow` → `call_child_workflow("session_workflow", app_id=…)`)
   under `DYNAMIC_SCRIPT_MAX_CONCURRENCY`
4. `when_any([cancel, control, *outstanding])` → drain ALL completed children →
   `record_script_call_result` (journal row + schema validation + structured-retry
   decision) → loop

Dapr replay = crash resume. **callId** (frozen by
`services/shared/contracts/script-evaluator-evaluate.contract.json`):
`sha256(prompt + NUL + canonicalJSON({schema,model,effort,isolation,agentType,label}))[:40]
+ "_" + occurrence`.

## Where things live

- Engine: `services/workflow-orchestrator/workflows/{dynamic_script_workflow,script_agent_dispatch}.py`
  + activities `evaluate_script`, `script_call_journal`, `aggregate_script_usage`,
  `append_script_logs`; route `POST /api/v2/script-workflows`
- Evaluator: `services/script-evaluator/` (`/evaluate`, `/validate`, `/healthz`; port 3300,
  Service 8080→3300; `--experimental-vm-modules`; zero secret deps)
- BFF: `engineType='dynamic-script'` (spec `{engine, script, meta, defaults?}`);
  `src/lib/server/workflows/dynamic-script-validation.ts`; start branch in `start-run.ts`;
  journal table `workflow_script_calls` (drizzle 0097) + internal routes
  `…/executions/[id]/script-calls[…]` + `…/llm-usage`; run UI `script-run-panel.svelte`
- MCP: `run_workflow_script` (workflow-mcp-server) — saved (`workflowName`) or inline
  (`script`) via `POST /api/internal/agent/workflows/execute-script` (X-Wfb-Session-Id
  REQUIRED for owner attribution). Recursion guard: `ensure-for-workflow` stamps
  `X-Wfb-Script-Depth: 1` on workflow-mcp-server MCP entries of script-spawned sessions →
  the tool is suppressed there.

## Operations

- **Execute**: UI confirm dialog, `POST /api/workflows/[id]/execute {input, budgetTotal?}`,
  or the MCP tool. Instance id `dsw-<meta.name>-exec-<executionId>`.
- **Resume-after-edit**: `POST /api/workflows/executions/[id]/resume {}` — fresh execution
  of the CURRENT script; `done` journal rows import; unchanged callIds resolve with ZERO new
  sessions; only edited calls dispatch. (Verified: full-cache resume = 0 sessions; one-line
  edit = exactly 1 new session.)
- **Skip a call**: `POST …/executions/[id]/script-calls/[callId]/skip` → raises
  `script.call.control` → journal `skipped`, the script sees `null`, siblings continue.
  Skipping an already-resolved call is a benign no-op.
- **Stop**: normal Lifecycle Controller (`POST …/stop {mode}`) — no special handling; child
  instance ids match the `__durable-script__<callId[:16]>__run__<N>` wedge-finalize shape.
- **Cancel event**: `workflow.cancel` external event → pump returns cancelled + persists.

## Gotchas (each cost real debugging time — do not regress)

- **`agentConfig.modelSpec` is the model key dapr-agent-py actually reads**
  (`effective_agent_config.resolve_llm_metadata`; `agents/markdown.ts` maps frontmatter
  `model` → `modelSpec`). The dispatch stamps BOTH `modelSpec` + `model`. Stamping only
  `model` silently falls back to the Anthropic default.
- **Default model**: BFF env `DYNAMIC_SCRIPT_DEFAULT_MODEL` (dev: `zai/glm-5.2`) → sent as
  `defaults.model`, applied ONLY when the resolved runtime is `dapr-agent-py`; per-call
  `agent(..., {model})` always wins. (Cost datum: a trivial turn ≈ 40 tokens on GLM 5.2 vs
  ≈ 480 on Opus.)
- **Terminal persistence is explicit**: a workflow that RETURNS an error dict is Dapr
  `COMPLETED`, and the read-model maps COMPLETED→success blindly. All four terminal paths
  (done / script_error / no-dispatchable-work / cancelled) call `persist_results_to_db`.
- **Budget vs ingestion race**: `agent.llm_usage` ingests asynchronously; budget-bounded
  runs park on `create_timer(DYNAMIC_SCRIPT_USAGE_SETTLE_SECONDS, default 3)` after each
  resolving drain so the next aggregate sees settled usage.
- **In-flight overshoot is BY DESIGN** (Claude Code parity): budget exhaustion stops NEW
  dispatches and makes unresolved `agent()` calls throw `BudgetExhaustedError` inside the
  script; already-running children complete and their tokens count.
- **Evaluator determinism**: `Date.now()`/`Math.random()`/zero-arg `new Date()`/timers/
  `import`/`fetch`/`process` throw in the sandbox — required for replay + resume. The
  sandbox is NOT a security boundary (scripts are workflow-spec trust domain);
  `isolated-vm` is a planned hardening.
- **`journal GET` returns `{scriptCalls: [...]}`** (not `calls`) — the orchestrator client
  and run panel both read that key.
- Dev-rollout verification: check POD-level image+env, not Deployment spec — two
  verification rounds were invalidated by stale-pod generations.

## Verifying (dev)

`node scripts/upsert-dynamic-script-workflow.mjs --file scripts/fixtures/dynamic-scripts/demo-review.js`
then execute; or `scripts/smoke-script-workflow.mjs`. Full battery + expected outcomes:
see the PR descriptions on wfb #446/#448/#449.
