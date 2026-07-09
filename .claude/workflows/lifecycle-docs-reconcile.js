export const meta = {
  name: 'lifecycle-docs-reconcile',
  description: 'Update + cull docs across workflow-builder, stacks, and nixos shared-skills to reflect the shipped lifecycle stop/terminate/purge work (PR1-PR4)',
  phases: [{ title: 'Reconcile' }],
}

const WFB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'
const SKILLS = '/home/vpittamp/repos/vpittamp/nixos-config/main/shared-skills'

const SYSTEM = `CURRENT SYSTEM — the "lifecycle stop/terminate/purge cutover" shipped across PR1-PR4 (all merged except wfb #65 open). This is the SOURCE OF TRUTH for what docs must reflect:

- Single vetted server-side **Lifecycle Controller** in the BFF: src/lib/server/lifecycle/{cascade,resolvers,index,reaper}.ts. Entry: stopDurableRun(target,{mode}); target.kind ∈ workflowExecution|session|evalRun; mode ∈ interrupt|terminate|purge|reset. Fail-closed (HTTP 409 if the durable tree is not confirmed terminal). Generalized from (and now shared with) the benchmark cancellation cascade (cleanupBenchmarkDurableWorkflowCascade).
- User stop surfaces all route through it: POST /api/v1/sessions/[id]/stop and POST /api/workflows/executions/[id]/stop; session interrupt; workflow execution terminate; eval cancel. Delete/Archive are BLOCKED (409 "Stop the run first") while a run is active. UI: Stop / Stop & Reset buttons on the session-detail + workflow-run pages; the sessions-list "Archive" row action was relabeled "Delete" (it always hard-DELETEd).
- Auth: /api/workflow-ops/* now requires platform admin (was an UNAUTHENTICATED JSON API). The dead, unauthenticated DELETE /api/orchestrator/workflows/[id] route + dead api-client methods (workflows.terminateExecution, orchestrator.terminate/raiseEvent) were REMOVED.
- Orchestrator (workflow-orchestrator): _workflow_http_post forwards query params; purge_workflow is recursive-by-default + forwards force (purge-force, Dapr 1.17.9); _idempotent_schedule purge-before-reuse is GUARDED to only the DB-terminal-but-Dapr-non-terminal divergence (it NEVER kills a legitimately running instance). **terminate_durable_runs_by_parent_execution was RETIRED** (it only ever fanned out to the legacy claude-code-agent app-id) — the BFF controller now does explicit per-session app-id fan-out; same-task-hub children rely on Dapr's native recursive cascade.
- sandbox-execution-api: stopped blindly 409-adopting an existing Sandbox CR — it now stamps an owner-run-id annotation and adopts only the SAME run, else deletes+recreates (no inherited stale pod state).
- dapr-agent-py: cancel-key write/read now AGREE for durable/run (check reads candidate keys, stripping __turn__N / :turn-N) so a mid-turn user.interrupt/session.terminate actually halts.
- claude-agent-py: management PARITY with dapr-agent-py — POST /api/v2/agent-runs/{id}/{terminate,pause,resume} + DELETE purge (via DaprWorkflowClient), cancellation persistence, a between-turn cooperative-cancel check, and TERMINAL_CONTROL_EVENT_TYPES.
- GitOps safety nets (stacks, PR4): workflow-builder-sandbox-gc CronJob (age-based GC of orphaned per-session agent-host Sandbox CRs in the workflow-builder namespace, excludes SandboxWarmPool-owned); **unified Dapr stateRetentionPolicy = 168h** across the parent (workflow-orchestrator-no-tracing) AND the per-session child Configs (workflow-builder-agent-runtime, openshell-sandbox-dapr) — closing the cascade-termination race (children were auto-purged before the parent finished); lifecycle-terminal-reaper CronJob -> POST /api/internal/lifecycle/reap-terminal (reconciles DB rows stuck non-terminal vs terminal/gone Dapr instances, purges orphans, SKIPS while a benchmark run/lease is active); runbooks/phase0-lifecycle-clean-slate.{sh,md} (guarded, dry-run-by-default one-time purge — NOT auto-run).
- SSOT design doc: workflow-builder docs/workflow-lifecycle-termination.md.

NOW-STALE (supersede / remove references): the old "Safety nets on the agent side" with the in-workflow session-turn timer (removed); the host-monitor default-"warn" framing as the only stop watchdog; the "manual SQL/scripts are the only cleanup" framing (now automated by the reaper + GC CronJobs); split-brain 168h-vs-30m retention (now unified); the per-agent AgentRuntime CRD + Kopf agent-runtime-controller (retired earlier).

RULES: Edit ONLY documentation/skill markdown — never touch code, manifests, or config. Match each file's existing voice/structure; update only the parts the lifecycle work changed (don't rewrite unrelated sections). DELETE a doc ONLY if it is now clearly superseded/contradicted by the current system (be conservative — when unsure, UPDATE rather than delete; keep docs about unrelated subsystems). Do NOT git commit or push (the parent reviews + commits). Return a concise changelog: files UPDATED (one line each on what changed), files DELETED (one line each on why), files KEPT-AS-IS.`

phase('Reconcile')

const reports = await parallel([
  () => agent(`${SYSTEM}

YOUR AREA: the workflow-builder repo at ${WFB} — its CLAUDE.md AND the docs/ folder. You OWN CLAUDE.md entirely (including its "> Supplementary docs" list).
Tasks:
1. CLAUDE.md: update the lifecycle-relevant sections to the current system — the vetted Lifecycle Controller + /stop routes + modes; the retired terminate_durable_runs_by_parent_execution + per-app-id fan-out; purge recursive/force forwarding; the idempotent purge-before-reuse divergence guard; sandbox 409-no-adopt; dapr-agent-py cancel-key fix; claude-agent-py management parity; the PR4 GitOps safety nets (workflow-builder-sandbox-gc, unified 168h retention, lifecycle-terminal-reaper + /api/internal/lifecycle/reap-terminal); and the Troubleshooting entries that are now automated/changed (the manual purge/reconcile is now the reaper+GC; the cancel-key; retention now unified). Reference docs/workflow-lifecycle-termination.md as the lifecycle SSOT in the supplementary-docs list (it's already pointed-to but flagged "DESIGN PROPOSAL, not yet implemented" — change that to implemented).
2. docs/workflow-lifecycle-termination.md: change status from "DESIGN PROPOSAL, not yet implemented" to IMPLEMENTED (PR1-PR4 shipped: wfb #62/#63/#64, stacks #2523, wfb #65), and update the phased plan/"remaining" sections to reflect what actually shipped.
3. docs/dapr-workflow-purge-runbook.md and docs/swebench-dapr-workflow-operations.md: update to the new vetted method (the Lifecycle Controller / /stop, the reaper + GC CronJobs, unified retention, purge-force) — keep the operator-runbook value but point at the automated/vetted paths.
4. DELETE clearly-superseded docs and remove their lines from CLAUDE.md's supplementary-docs list: per-agent-runtime.md (AgentRuntime CRD + Kopf controller RETIRED), agent-runtime-standardization-plan.md (the standardization plan is completed), system-review-2026-06-05.md (a point-in-time review now superseded). For agent-runtime-comparison.md, architecture.md, services.md, deployment.md: UPDATE any stale lifecycle/termination/retired-fan-out references; do NOT delete. KEEP (don't delete): activepieces-auth, cma-parity, hooks-and-plugins, tiered-crawl-pipeline, mcp-agent-workflows, callable-agents, workflow-artifacts, durable-session-runtime-contract, quick-start, benchmark-statistics, swebench-* (unless they specifically describe removed lifecycle mechanics — then update).
Be precise; cite the current system. Return the changelog.`, { label: 'docs:workflow-builder', phase: 'Reconcile' }),

  () => agent(`${SYSTEM}

YOUR AREA: the stacks repo at ${STACKS} — its docs/ folder + AGENTS.md.
Tasks:
1. docs/dapr-workflows-and-agents-termination.md is the DIRECTLY relevant doc — update it thoroughly to reflect the current system: the BFF Lifecycle Controller as the vetted stop method, the retired terminate_durable_runs_by_parent_execution, the PR4 GitOps safety nets you can see in packages/components/workloads/workflow-builder/manifests (workflow-builder-sandbox-gc CronJob, lifecycle-terminal-reaper CronJob -> /api/internal/lifecycle/reap-terminal, the UNIFIED 168h stateRetentionPolicy across parent+child Configs), and the runbooks/phase0-lifecycle-clean-slate.{sh,md}. Remove/replace any now-wrong claims (e.g. split-brain 168h-vs-30m retention, "no workflow-builder-ns Sandbox GC", manual-only cleanup).
2. docs/code-eval-capacity-cleanup.md: update if it references the workflow-builder lifecycle/cleanup behaviors that changed; else keep.
3. Scan stacks AGENTS.md + other docs/*.md for stale references to the workflow-builder termination/retention/sandbox-GC behavior and update them. Be conservative: only touch what the lifecycle work changed; DELETE a stacks doc only if it is now clearly entirely superseded (most stacks docs are about hub/spoke/tailscale/gitops and are NOT in scope — keep them).
Return the changelog.`, { label: 'docs:stacks', phase: 'Reconcile' }),

  () => agent(`${SYSTEM}

YOUR AREA: the nixos shared-skills at ${SKILLS} (these are Claude Code skills; SKILL.md is the entrypoint, with references/ + runbooks/ subdirs).
Tasks:
1. shared-skills/workflow-builder/ (SKILL.md + references/): update to reflect the current system — add/refresh guidance on the vetted stop/terminate/purge (the Lifecycle Controller, POST /api/v1/sessions/[id]/stop + /api/workflows/executions/[id]/stop with modes interrupt|terminate|purge|reset, fail-closed 409, delete-blocked-while-active, the Stop/Stop&Reset UI), the agent-runtime cancel semantics (dapr-agent-py cancel-key, claude-agent-py parity), and the orchestrator/sandbox behaviors (purge recursive/force, retired terminate_durable_runs_by_parent_execution, 409-no-adopt). If there's a references file on workflow ops/troubleshooting, fold in the reaper + Sandbox-GC CronJobs + unified retention + the phase-0 runbook + docs/workflow-lifecycle-termination.md pointer.
2. shared-skills/gitops/ and shared-skills/evaluations/: where they reference workflow/agent termination, cleanup, retention, or stuck-state recovery for workflow-builder, update to the current automated lifecycle (reaper + Sandbox-GC CronJobs, unified 168h retention, the controller). Don't broaden scope beyond lifecycle-relevant mentions.
3. Do NOT delete skills (they cover current subsystems) unless a file is genuinely, wholly stale re: the new system. If you CREATE any new file, say so explicitly in the changelog (the parent must git add it — flakes ignore untracked files). Do NOT git commit.
Return the changelog, and explicitly list any NEW files created.`, { label: 'docs:nixos-skills', phase: 'Reconcile' }),
])

return { reports: reports.filter(Boolean) }
