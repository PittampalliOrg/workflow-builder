export const meta = {
  name: 'docs-sync-goal-loop',
  description: 'Update docs in workflow-builder, stacks, and shared-skills to reflect the goal-loop system + learnings; flag stale docs',
  phases: [{ title: 'Write', detail: 'three writer agents, one per repo' }],
}

const BRIEF = `SHARED LEARNINGS BRIEF (2026-06-09/10 work; all shipped to main + deployed to dev/ryzen):

A. GOAL LOOP FEATURE (Codex /goal parity; PRs #84,#87,#88 + fixes):
- thread_goals table (migration 0079): one ACTIVE goal per session (partial unique uq_thread_goals_session_active); status active|paused|budget_limited|complete; goalId rotates + accounting resets on replace; replace covers active AND budget_limited rows (re-arm).
- BFF driver src/lib/server/goals/{goal-loop,repo,render}.ts + templates/ (verbatim codex continuation.md + budget_limit.md). Event-driven off appendEvent side-effects: agent.llm_usage accrues budget; session.status_idle{end_turn} injects the next continuation as a user.message (origin=goal-continuation, deterministic sourceEventId goal-continuation:<sid>:<iter>). Exactly-once = atomic iteration claim + idle gate + sourceEventId dedup.
- Completion contract: MCP tools create_goal/update_goal/get_goal in services/workflow-mcp-server (goal-tools.ts), session-scoped via X-Wfb-Session-Id header (stamped in spawn.ts) + AsyncLocalStorage. update_goal accepts ONLY "complete". spawn.ts AUTO-WIRES the goal MCP server into every MCP-capable session (opt-out GOAL_MCP_AUTO_WIRE=false; URL via GOAL_MCP_SERVER_URL).
- Guardrails: tokenBudget (status->budget_limited + exactly one wrap-up turn guarded by budget_steered_at), maxIterations hard cap (stop_reason=iteration_cap), interrupt stop pauses the goal, terminal sessions halt the driver.
- Crash-safety: goal-loop-tick CronJob (stacks, */2) -> POST /api/internal/goal-loop/tick with lost-idle probe (GOAL_LOOP_LOST_IDLE_GRACE_SECONDS=180): the runtime's session-event ingest is fire-and-forget, so an idle event dropped during a BFF outage would freeze the loop; the probe posts anyway (safe: Dapr buffers raised events until next wait_for_external_event).
- BUDGET ACCOUNTING = codex semantics: delta = input_tokens + output_tokens + cache_creation (cache READS excluded). Earlier bug counted cache reads -> 20x over-burn on cached loops.
- API: GET/POST/PATCH /api/v1/sessions/[id]/goal. UI: interactive Goal card (Set goal dialog, Pause/Mark complete/Resume-adjust/New goal) on session detail.
- Codex parity divergences (documented audit): continuation is a visible user.message (codex: hidden developer role); our wrap-up runs as one extra autonomous turn (codex: steering injected mid-turn, no continuations after BudgetLimited); update_goal call itself IS accounted (codex excludes it); wall-clock = now-createdAt (codex: active-time deltas); no plan-mode/feature-flag gates; no accounting-preserving unpause (re-set resets counters); ours adds maxIterations + DB-derived crash-safety codex lacks.

B. SESSION PULSE (PRs #85,#86): vitals strip on session detail (component src/lib/components/sessions/session-pulse.svelte): Tokens (in/out split), Cache-hit % ring, Cost (live $ from GET /api/v1/pricing?model= backed by MODEL_PRICING; 'saved $X via cache'), Context % (provider-truth: latest context_* fields from agent.llm_usage [context_count_method=provider_usage] preferred over the pre-call local_advisory heuristic on agent.context_usage — heuristic undercounts 20-25%), Elapsed (live tick), Turns + LLM calls, Goal loop tile. Context % includes cached tokens (window occupancy) — matches Claude Code's calculateContextPercentages exactly; budget accounting deliberately differs (work metric).

C. USAGE-EVENT CONVENTION (PR #90, dapr-agent-py): ALL adapters now emit agent.llm_usage input_tokens NET of cache reads (disjoint from cache_read_input_tokens). openai_adapter + alibaba_adapter were emitting gross (provider reports inclusive) -> fixed with max(0, gross - cached) + prompt_tokens_details fallback. This convention is a SYSTEM INVARIANT: goal budgets, Pulse cost, and the post-ingest context_* stamp all depend on it. The goal-loop eval (OpenAI gpt-5.5, itsdangerous TDD scenario) caught it: 242 net tokens booked as 17,906.
- context_* stamp on llm_usage (event_publisher post-ingest) = input + cache_read + cache_creation (full window occupancy), source 'provider_usage'.

D. workflow-mcp-server NOW DEPLOYED (was manifest-only): added to kustomization resources + new Service-workflow-mcp-server.yaml (port 3200); DATABASE_URL + INTERNAL_API_TOKEN via envFrom workflow-builder-secrets; hosts goal tools + workflow tools; Dockerfile pnpm pinned @9.

E. OPS LEARNINGS:
- skaffold argo-resume: on exit the hook may silently skip ryzen's app (bare name no-ops) — recover with ARGO_APPS=ryzen-workflow-builder bash skaffold/hooks/argo-resume.sh FROM THE WFB REPO ROOT; symptom = app annotation argocd.argoproj.io/skip-reconcile=true + Deployment stuck on workflow-builder-dev image. Killed skaffold can leave a stale .bare/worktrees/main/index.lock (also in the stacks clone) — remove after verifying no git proc.
- commit-pin push 403 persists: push cached clone with gh-token URL (documented before; reaffirmed).
- Outer-loop (merge to wfb main) builds images + writes DEV pins file + dev overlay; it does NOT write ryzen pins. Ryzen Component consumes ONLY workflow-builder + workflow-mcp-server rows from workflow-builder-images-ryzen.yaml; for ryzen delivery of an outer-loop-built commit: edit pins + run WFB_RENDER_ENVS=ryzen scripts/gitops/render-workflow-builder-release-overlays.sh + commit/push (never rebuild locally what outer-loop built — digest mismatch).
- Per-session sandbox image path on DEV: pins -> render-workflow-builder-release-overlays.sh regenerates workflow-builder-system-overlays/dev/kustomization.yaml which patches sandbox-execution-api SANDBOX_EXECUTION_CLASSES_JSON agentHostImage; base Deployment-sandbox-execution-api.yaml hardcodes a stale tag (inert for dev). Sessions spawned during the rollout window keep the old pod (a reschedule mid-session preserves conversation history — verified live).
- GitHub repo picker: org repos require the per-cluster OAuth app to be GRANTED org access (dev + ryzen are SEPARATE GitHub OAuth apps: 'Workflow Connections (Dev)' Ov23linctlmmlA9F8odt / '(Ryzen)' Ov23liqsg0KjlK52R2at); grant applies live to existing tokens. /api/scm/repos now paginates (5 pages/500 repos; single page silently truncated at 100).
- GOAL EVAL SCENARIOS (reusable regression harness, run via a goal on a live session): (1) 'itsdangerous TDD' — clone, green baseline, PLAN.md with file:line, 4 new tests, full-suite audit (caught the OpenAI accounting bug); (2) 'red-green TDD on pytest-dev/iniconfig' — REQUIRED failing stage at step 2 proves no false completion. Dev agent goal-eval-deepseek (P-1UUm25pvbzh3da4TXJD) exists for these.

STYLE RULES: match each file's existing voice/format; be DENSE (these are operator docs); never invent facts beyond this brief + what you verify in code; cite file paths; keep diffs minimal-but-complete.`

const OUT = {
  type: 'object', additionalProperties: false,
  required: ['changed', 'staleFlagged', 'notes'],
  properties: {
    changed: { type: 'array', items: { type: 'string' }, description: 'files edited/created/deleted with 1-line summary each' },
    staleFlagged: { type: 'array', items: { type: 'string' }, description: 'docs you believe are stale but did NOT delete, with reason' },
    notes: { type: 'string' },
  },
}

const results = await parallel([
  () => agent(`Repo: /home/vpittamp/repos/PittampalliOrg/workflow-builder/main (branch docs/goal-loop-system is checked out — edit in place, do NOT commit).
${BRIEF}

YOUR TASKS:
1. CREATE docs/goal-loop.md: the definitive feature doc — architecture (table/driver/MCP contract/auto-wire/guardrails/crash-safety), the budget-accounting + usage-event conventions (section C is load-bearing), API + UI surfaces, codex-parity divergence table, the two eval scenarios (full objective text so they're rerunnable), operational notes (re-arm semantics, lost-idle probe, reschedule survival). Match the style of docs/workflow-lifecycle-termination.md (dense operator doc).
2. UPDATE CLAUDE.md — it is at 39,595 chars of a 40,000 HARD LIMIT. Add: goal-loop.md to the supplementary docs list; a tight 'Goal Loop' subsection (~12 lines) under or near the session/CMA sections covering the invariants (driver location, MCP contract + auto-wire, budget semantics, tick CronJob, the usage-event net-of-cache invariant); mention Session Pulse + /api/v1/pricing in one or two lines; update the workflow-mcp-server row in the Services table (now deployed, hosts goal tools). PAY for every added char by tightening verbose existing prose (do NOT delete load-bearing invariants). END RESULT MUST BE < 40,000 chars (verify with wc -c).
3. STALE SWEEP of docs/: verify each of architecture.md, deployment.md, quick-start.md, services.md against the current code/CLAUDE.md — delete a doc ONLY if it is clearly superseded/wrong (e.g. devspace-era, retired TS durable-agent, AgentRuntime CR/Kopf era) AND its accurate content exists elsewhere; otherwise fix the worst inaccuracies in place or flag it. Be conservative: deletion requires the doc to be actively misleading.
Run wc -c CLAUDE.md at the end and include the number in notes.`, { label: 'write:wfb-docs', phase: 'Write', schema: OUT }),
  () => agent(`Repo: /home/vpittamp/repos/vpittamp/nixos-config/main/shared-skills (edit in place, do NOT commit).
${BRIEF}

YOUR TASKS:
1. UPDATE workflow-builder/SKILL.md (+ its references/ dir if there is an obvious place): add a Goal Loop section (how to set/manage goals via UI + API + MCP tools, budget semantics incl. net-of-cache invariant, guardrails, tick reaper + lost-idle probe, re-arm, the two eval scenarios with their objective text + the goal-eval-deepseek agent), Session Pulse (tiles + data sources + provider-truth context), and the usage-event convention (all adapters net-of-cache; what to check when budgets/cost/context look wrong for a provider: inspect agent.llm_usage in vs cache_read for subset semantics).
2. UPDATE skaffold-dev-loop/SKILL.md: argo-resume gotcha (exit hook can silently skip ryzen app; recover with ARGO_APPS=ryzen-workflow-builder from the wfb repo root; diagnostic = argocd.argoproj.io/skip-reconcile annotation + Deployment stuck on workflow-builder-dev image); stale index.lock in .bare/worktrees after killed skaffold (both wfb and stacks cached clone).
3. UPDATE gitops/SKILL.md (or its reference files if more apt): ryzen pins consumption scope (Component consumes ONLY workflow-builder + workflow-mcp-server rows; other rows inert), pin-existing-outer-loop-tag procedure for ryzen (edit pins, run the render script, commit/push with gh-token URL; never rebuild a commit outer-loop built), dev sandbox-image delivery chain (pins -> render -> dev overlay SANDBOX_EXECUTION_CLASSES_JSON patch; base manifest tag is inert for dev), GitHub OAuth per-cluster apps + org-grant for the repo picker.
Match each skill's existing structure/tone. Keep additions surgical.`, { label: 'write:skills', phase: 'Write', schema: OUT }),
  () => agent(`Repo: /home/vpittamp/repos/PittampalliOrg/stacks/main (on branch main — edit in place, do NOT commit).
${BRIEF}

YOUR TASKS:
1. Survey AGENTS.md + docs/ for content describing the workflow-builder runtime/lifecycle/CronJobs that the brief makes stale or incomplete; likely candidates: docs/dapr-workflows-and-agents-termination.md (add goal-loop-tick alongside lifecycle-terminal-reaper if CronJobs are enumerated), AGENTS.md if it catalogs workflow-builder workloads.
2. Add brief mentions where the repo documents the workflow-builder deployment surface: workflow-mcp-server now deployed (Deployment+Service in workloads/workflow-builder/manifests, envFrom workflow-builder-secrets, hosts the goal MCP tools), CronJob-goal-loop-tick.yaml (*/2 backstop for the goal loop with lost-idle probe), and the ryzen pins consumption scope + render-script flow if pins are documented.
3. Do NOT touch generated files (anything with a 'Generated by' header, hydrator output, overlays). Only hand-maintained docs. Be conservative; if nothing in a doc is wrong, leave it.`, { label: 'write:stacks-docs', phase: 'Write', schema: OUT }),
])

return results.filter(Boolean)
