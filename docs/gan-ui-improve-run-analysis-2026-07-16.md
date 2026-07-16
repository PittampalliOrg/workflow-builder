# GAN UI-Improvement Workflow — Deep Debug (2026-07-16)

Trace-grounded post-mortem of the `gan-ui-logic-test` / `gan-ui-improve` GAN
workflows, centered on the one successful end-to-end run, with a corrected
failure taxonomy, prioritized workflow improvements, and a v2 design that
integrates with `docs/host-preview-development-lifecycle.md`.

**Method.** Full per-session transcript dumps (session_events: messages, tool
calls/results, llm_usage) for all 10 agent sessions of the successful run and
all 4 sessions of the 3 cancelled contrast runs; bridge (`agent-browser-mcp`)
logs; DB forensics; bridge/BFF/orchestrator source reads; then a 22-agent
analysis fan-out (per-session analysts on the primary model, investigation +
adversarial-verification passes) whose claims were cross-checked against the
raw evidence. Every load-bearing claim below is verified against primary
evidence, and four of the going-in assumptions were **refuted**.

---

## 1. The run, as it actually happened

`gan-ui-logic-test` execution `Ee3DOt2Tk9ntOz5XX8hYr`, dev, 2026-07-16
16:29:43 → 17:02:30 UTC (32m47s), status `success`. Config: coder
`glm-coder-host`, critic `glm-browser-agent` (both GLM 5.2 / zai on
`agent-runtime-pool-coding`), routes `["/dashboard"]`, refs
`["/workspaces/default/workflows", "/capacity/active"]`, maxIterations 2,
voters 2.

| # | call | wall | LLM iters | in-tok | out-tok | what really happened |
|---|------|-----:|----------:|-------:|--------:|---------------------|
| 0 | audit_baseline | 123s | 9 | 37.8k | 1.0k | ✅ Authed browser, 8 tool calls (within the ~10 budget), 3 real issues, health 7/10 |
| 1 | plan | 401s | 22 | 118.4k | 8.8k | ✅ Cloned the real repo (anonymously — it's public), read ~20 real SvelteKit files, wrote a genuine contract with real OKLCH/shadcn tokens — **all of it died with the pod** |
| 2 | contract_review | 158s | 9 | 8.2k | 2.7k | ⚠️ Couldn't read contract.json (tried `file:///sandbox/work/contract.json` through the **browser** → `ERR_FILE_NOT_FOUND`); agreed=true based on the prompt-embedded proposal summary |
| 3 | refine #1 | 81s | 6 | 4.9k | 1.3k | ❌ Fresh pod: no `/sandbox/work`, no repo. Honestly returned "UNRESOLVED — could not read a contract" |
| 4-5 | critique #1.1/#1.2 | 132/159s | 7/8 | 64k | 2.3k | ✅ Browser worked (all calls 0.6–3.9s); real element-level inspections; correctly rejected the non-proposal (scores 0, 1) |
| 6 | refine #2 | 253s | 15 | 20.9k | 5.3k | ⚠️ Reconstructed a proposal **from the critics' feedback text**; wrote its own contract.json; file paths hallucinated as Next.js `app/*.tsx`; poked `wfb_goal` MCP tools for grounding |
| 7-8 | critique #2.1/#2.2 | 379/610s | 7/4 | 14.8k | 2.5k | ❌ **Both graded blind** — every browser call timed out (wedged shared Chrome). #2.1 passed 8/10 anyway from proposal text; #2.2 defaulted-to-reject at 7 |
| 9 | synthesize | 54s | 1 | 6.7k | 2.1k | ✅ Faithful merge of audit + refine#2 proposal into the 10-item report (inheriting the wrong paths) |

Totals: **88 LLM calls, 275.6k input / 26.1k output tokens, 1.37M cache-read,
~981s cumulative LLM time in a 1,967s run.** All 10 structured outputs
validated on the first attempt; zero schema retries; zero recovery attempts;
session dispatch waits 1–3s (pool healthy — it had been rollout-restarted at
16:25, four minutes before this run).

Where the wall-clock went: plan 20%, iteration-2 critics 30% (of which ~10
minutes was **dead browser-timeout wait**, the single longest pole being
critique #2.2's three 180s `open` timeouts), everything else well-behaved.

Where the money went: **plan is 43% of input tokens and 34% of output — and
its product (real source grounding + real contract) was completely discarded**
by the pod-isolation break described below.

---

## 2. What worked (keep these)

1. **The orchestration spine is solid.** Ten agent dispatches, two parallel
   fan-outs, loop control, schema-forced structured outputs (10/10 first-try
   valid via the StructuredOutput tool — the schema-conformance problem that
   plagued the CLI GAN harness is fully solved on dapr-agent-py), graceful
   continuation past a degraded step, and a clean final return. Zero retries,
   zero engine errors.
2. **The baseline audit pattern.** Bounded prompt ("max ~10 tool calls, open
   each route ONCE, then STOP") kept GLM 5.2 disciplined: 8 browser calls, no
   loops. Its three findings were real (all-error recent-runs, ephemeral-agent
   clutter, and the 404 — see §3.4 for the twist) and correctly prioritized.
   Target-auth worked: `[target-auth] cookie wb_access_token set … exec=Ee3DOt2…`.
3. **Voting critics caught both failure modes they were designed for.**
   Iteration 1: both critics did genuine element-level live inspections
   (sub-4s calls) and unanimously rejected the UNRESOLVED non-proposal with
   *specific* evidence. Iteration 2: when both went blind, one critic obeyed
   "default to reject when unsure" (score 7, explicit "I cannot confirm the
   proposal maps to a real design system … I default to reject") — and
   unanimity-required acceptance meant that one honest vote correctly kept
   `accepted=false`. The anti-sycophancy design paid for itself: the other
   blind critic scored it 8/PASS.
4. **Honest-failure behavior.** refine#1 didn't fabricate — it reported the
   missing inputs and stopped. (GLM 5.2 later *did* fabricate under softer
   pressure — see §3.2 — but the "when blocked, diagnose and STOP" instruction
   demonstrably works when the blockage is total.)
5. **GLM 5.2 as browser critic on the curated 22-tool surface.** When the
   browser is healthy it produces detailed, accurate, element-level
   observations (nav sections, columns, badge palettes, filter chips) — the
   iteration-1 verdicts and the audit read like a competent human QA pass.

---

## 3. What didn't work — corrected taxonomy

### 3.1 LOGIC (workflow design) — the biggest class

**L1. File-based context handoff assumes a shared filesystem that host pool
pods do not have.** The GANs.md pattern ("agents pass Markdown files on local
disk") was ported without its substrate. Each `agent()` call in the logic test
passes only `{agent, label, schema}` — no `workspaceRef`, no shared isolation —
so every call lands on a fresh/other `agent-runtime-pool-coding` sandbox:

- plan: `Successfully wrote 74 lines to /sandbox/work/contract.json (created)`
  (its pod, `ws-c5ur9q2she4g`), validated in place: `VALID JSON / 8 acceptance criteria`.
- refine#1 (other pod): `ls /sandbox/work` → `No such file or directory`.
- contract_review (browser-only agent — it has **no file tools at all**) tried
  `browser_agent_browser_open {"url":"file:///sandbox/work/contract.json"}` →
  `ERR_FILE_NOT_FOUND` (this is also the bridge's mysterious
  `[target-auth] host mismatch: opened=` line — a `file://` URL has an empty host).

Consequence chain: refine#1 UNRESOLVED → iteration 1 wasted → refine#2
reconstructed the proposal from critic prose → **the plan session's 118k-token
real grounding never reached the deliverable**. The one context channel that
*did* work — prompt-embedding (`issuesText`, `proposalText`, critic feedback) —
is what actually carried the run.

**L2. The refine prompt has no bootstrap and no fallback.** It says "Read
/sandbox/work/contract.json + your cloned source under /sandbox/work/repo" —
but only the *plan* prompt contains clone instructions. The negotiate prompt
hedges ("if unreadable, judge the proposal summary below"); the refine prompt
doesn't. Three prompt-level bugs compound: (a) refine assumes state it was
never given; (b) plan's `[ -w /sandbox/work ]` test ran *before* any mkdir, so
a merely-nonexistent directory diverted the clone to pod-local `/tmp/work`;
(c) nothing re-establishes grounding when it's missing.

**L3. Critics grade an UNAPPLIED proposal against a live, unchanged page — a
category error.** GANs.md's evaluator grades *applied work* via live QA. Here
the live app can never show the improvement, so "interact with the routes,
then grade whether the proposal WOULD meet the contract" collapses into
text-review-with-extra-steps. It worked by luck in iteration 1 (the live view
exposed the proposal's emptiness), and it means browser time is mostly spent
re-verifying the baseline. The full `gan-ui-improve` (HMR-synced edits, critics
grade the actual new page) does not have this flaw — the logic test's
read-only framing does.

**L4. No deterministic gate in the logic test.** `gan-ui-improve` has the
proven clone+overlay+check+boundaries+test-unit gate; the logic test's only
signal is subjective critic score — exactly the axis GANs.md says needs a hard
artifact check. A gate as simple as "every proposed file path must exist in
the repo" would have caught the `app/*.tsx` hallucination deterministically,
for free.

**L5. Planner/Generator role blending.** The "plan" prompt asks for
`proposedChanges[]` (concrete file-level edits) — Generator work — in the same
breath as the contract — Planner work. GANs.md keeps the Planner high-level
precisely so hallucinated implementation detail can't cascade; here the
blended role made file-path fiction part of the *contract-adjacent* artifact.

**L6. One run-scoped browser for all critics** — see E1 for the mechanism; the
*logic* half of the issue is that the workflow deliberately fans out parallel
voters but gives them a serialized, shared, stateful resource. Two "independent"
inspections in iteration 1 were literally the same Chrome — they interleaved in
lockstep (same URLs, seconds apart), and each critic's snapshot could have
captured the *other* critic's page had their route orders diverged. Independence
of votes is currently an illusion at the observation layer.

### 3.2 QUALITY (model behavior)

**Q1. Blind critic #2.1 passed anyway.** Despite "Judge independently; default
to reject when unsure," the score-8 critic wrote "NOTE: I could not observe
the live app … I judged purely against the proposal text" and passed. Under
identical blindness, #2.2 rejected. GLM 5.2's compliance with skepticism
instructions is coin-fliply fragile at exactly the moment it matters.

**Q2. Confident misattribution of tool failures.** Both blind critics reported
the failure as "network policy-denied from this sandbox" / "the app is
entirely unreachable" — the app was up and other sessions were using it; the
wedged bridge session was the cause. refine#2 then *echoed* the misdiagnosis
("network is policy-denied", the app's 403 auth-guard response misread) into
its grounding note, and the final report shipped with "network policy-denied"
baked into its executive summary. One agent's wrong excuse became the next
agent's fact — prompt-chaining propagates misdiagnosis.

**Q3. Fabricated-but-plausible file paths.** refine#2, with no source access,
invented a complete Next.js file layout (`app/dashboard/page.tsx`,
`RecentRunsTable.tsx`) for a SvelteKit app (75 `+page.svelte` routes, zero
`.tsx`). It *did* flag the uncertainty in prose — but structured fields don't
carry the hedge, and rank-1..10 of the final report cite fictional paths.

**Q4. Final deliverable quality: 2/10 items genuinely actionable.** Judged
against the real repo: rank 3 (search+filter on dashboard runs) and half of
rank 5 (runs empty-state) are real gaps. Rank 4's "System status KPI strip"
**already exists** on the shipped dashboard (since 2026-05); rank 2's
"reusable DataTable primitive" doesn't exist anywhere in the codebase; rank 1
chases a 404 that isn't a defect (below). The report reads as strong, specific
work — and is mostly templated SaaS-dashboard advice wearing this app's
vocabulary (learned secondhand from the critics' live descriptions).

### 3.3 ENVIRONMENT (infra/config)

**E1. The shared browser session wedged mid-run — root cause is the
auto-capture idle-stop, not critic-vs-critic contention.** All 62 bridge MCP
sessions of the run keyed to ONE browser (`browser=wfb-Ee3DOt2…`). Timeline:
contract_review's browsing started auto-capture (video+HAR) at 16:39:23; the
iteration-1 critics used the same session fine until 16:45:19; then refine#2
ran — a >5-minute browserless gap — so the bridge's
`AUTO_CAPTURE_IDLE_MS=300000` idle-stop fired ≈16:50:19 and spawned an
ephemeral child in the SAME daemon session to run `record_stop`/`har_stop`
(each with a 300s timeout; `bridge.mjs` `stopCapture()`). Finalizing ~11
minutes of recording took until 16:52:19 (video) / 16:54:19 (HAR). The
agent-browser daemon serializes commands per session, so the iteration-2
critics' opens (first at 16:51:28) queued behind it and hit their 180s client
timeouts; the timed-out-but-still-queued commands then kept the session wedged
for the rest of the run (every later call failed: 180s/30s/15s/10s/20s). Both
critics were blind from first call to last.
  The same wedge signature (idle 180s+ browser timeouts) appears in contrast
runs JjufA-run1 and t8tBF — this is a recurring failure mode of *shared
run-scoped browser + auto-capture + mid-run idle gaps*, and it will bite ANY
workflow whose browser usage is bursty with >5-min gaps.

**E2. Zombie pool sessions starve everything (pre-16:25 window).** The
`site-demo-video` zombie (`…lt2UART…`) is *still* non-terminal
(`rescheduling`, 19h+), and a second zero-event zombie exists
(`fcbad7f5…`, exec JPzI877E). DB forensics across the three cancelled contrast
runs shows monotonic degradation while the zombies sat in the pool: dispatch
latency 12–13s (JjufA) → 25–26s (J1tSH) → 30–31s (t8tBF), with t8tBF's last
screenshot hanging 10.5 minutes until the operator cancelled — and then
completing successfully 6.5 minutes *after* cancellation (artifact posted
16:27:18), right after the 16:25 pool restart. Post-restart, the successful
run dispatched in 1–3s. Lesson stands: **skip ≠ kill; always terminate the
underlying session workflow** (v1.0-beta1 terminate + pool restart), and the
idle reaper still doesn't collect actively-rescheduling zombies.

**E3. GITHUB_TOKEN is absent from the pool env** — the plan clone succeeded
only because the repo is public (anonymous HTTPS clone with an empty
`x-access-token`). Any private-repo variant of this workflow fails at plan.

### 3.4 Corrections to the going-in assumptions (all four verified against evidence)

| Handoff assumption | Verdict | What the evidence shows |
|---|---|---|
| JjufA failed because `sandbox:{}` dropped target-auth headers → browser stuck on /auth/sign-in | **REFUTED** (for this run) | Both JjufA attempts were *fully authenticated* end-to-end (real dashboard content, clean console). run0 died to `auto_terminate_after_end_turn` without ever calling StructuredOutput (turn-budget exhaustion, no salvage path); run1 hit the E1 wedge signature (4 × 180s timeouts). |
| `sandbox:{…}` override drops mcpServers headers (BFF bug) | **NOT REPRODUCIBLE IN CODE** | Full trace of ensure-for-workflow + orchestrator dispatch: `sandbox` and `agentConfig.mcpServers` are disjoint wire fields that never merge; adding `sandbox:{}` yields a byte-identical agentConfig. The **real adjacent hazard**: `ensure-for-workflow/+server.ts` (~L395–436) silently falls back to the header-less python-built config if the named-agent DB load / bundle-flatten *throws* (console.warn only) — a DB hiccup (e.g. under zombie-era load) produces exactly the "headers never arrived" symptom, intermittently. That silent fallback should be a hard fail or at least a session event. |
| GLM coder couldn't clone ("network policy-denied") → check egress NetworkPolicy | **REFUTED** | No clone failure exists anywhere in the workflow's DB history. Exactly one clone was ever attempted (plan, Ee3DOt2) and it **succeeded**. refine#1/#2 never *attempted* a clone (their prompts contain no clone instructions — L2). "Policy-denied" was the model's misreading of the app's 403 auth guard (Q2). There is no egress NetworkPolicy in the namespace. |
| Baseline audit found a critical `/capacity/active` 404 | **TRUE BUT MISLEADING** | The run *input* listed `/capacity/active` as a reference route; the real route is workspace-scoped `/workspaces/{slug}/capacity/active` (which works, and which run0 of JjufA actually visited with data). The "critical 404" is a typo in the workflow's default `referenceRoutes`, and the final report's #1 recommendation chases it. Garbage route in → confident critical finding out. |

---

## 4. Prioritized workflow improvements (each tied to evidence)

**P0 — state handoff: stop assuming shared disk (L1, L2).** For host-mode
runs, pass artifacts through the *script*: agent A returns the contract as
structured output → the script embeds it verbatim in downstream prompts (this
run's accidental prompt-embedding channel is what worked; make it the design).
For preview/JuiceFS runs, keep file handoff but pass `workspaceRef: workspace`
+ `isolation:'shared'` on every call (as `gan-ui-improve` already does) and
add a cheap deterministic existence check between phases. Never let a prompt
claim state ("your cloned source") the orchestration didn't create.

**P1 — per-critic browser lanes (L6, E1).** Stamp `X-Wfb-Browser-Lane:
per-node` on the critic agent (the mechanism is shipped and proven —
`glm-browser-probe-agent` has the header; `glm-browser-agent` doesn't), so
each critic node gets its own BrowserStation Chrome, its own auth, its own
capture. This simultaneously fixes: vote independence, snapshot
cross-contamination, and the idle-stop wedge (a lane's capture lifecycle
belongs to one node, so another node's silence can't trigger a mid-use stop).
Farm capacity: raise dev `maxReplicas` from 2 to ≥ voters+1 (stacks overlay —
edit the RENDERER, not the rendered file). Fallback if lanes are unavailable:
run critics sequentially, or voters=1 + a browserless text-critic second vote.

**P2 — disable auto-capture for GAN critic sessions, or make idle-stop
non-wedging (E1).** Options in order of preference: (a) per-run header to opt
out of auto video+HAR for grading sessions (they don't need artifacts every
iteration); (b) idle-stop runs its `record_stop` in a *cloned* context or
marks the session busy-checkable so new opens fail fast with a retryable
"finalizing" error instead of 180s hangs; (c) raise `AUTO_CAPTURE_IDLE_MS`
above the longest expected coder turn (crude but effective: 20 min).

**P3 — deterministic reality gate for proposals (L4).** In read-only mode:
after each refine, a `workspace/command` (or script-side check against a
`filesRead` manifest) verifies every `proposedChanges[].file` exists at HEAD;
failure short-circuits with the diff of real paths — exactly like the build
gate pattern. In applied mode: keep the existing GATE_COMMAND. This converts
Q3 from a silent deliverable-poisoner into a bounced iteration.

**P4 — blindness must zero the vote (Q1, Q2).** Two layers: (a) prompt: "If
you could not load the pages, set meets_criteria=false, score=0, and set
blocked=true — a grade without observation is invalid"; (b) schema+script:
add `observedRoutes[]`/`blocked` to VERDICT_SCHEMA and have the script treat
votes with `blocked=true` or empty observations as *abstentions* (re-dispatch
once on a fresh lane) rather than counting them. Never let "I couldn't see it,
docked one point, PASS" be expressible.

**P5 — turn-budget salvage (JjufA run0).** `auto_terminate_after_end_turn`
killing a session that never emitted StructuredOutput wastes the whole call.
The runtime should force a final "emit your structured output NOW with
whatever you have" turn when the budget is about to expire (dapr-agent-py
change), and the script should treat a schema-empty retry as resume-with-notes
rather than restart-from-scratch.

**P6 — kill the zombies + fix the silent config fallback (E2, 3.4).**
Operational: terminate the two still-non-terminal zombie sessions
(v1.0-beta1 terminate; pool restart if they re-hydrate). Code: make the
ensure-for-workflow named-agent resolution failure loud (session event +
fail-fast option), so header-less fallback can never masquerade as an
agent-config bug again; teach the idle reaper to collect `rescheduling`
sessions with no event progress for N minutes.

**P7 — fix the run input** (`referenceRoutes`): `/capacity/active` →
`/workspaces/default/capacity/active`. Also default `evaluationRoutes` and
refs to slug-scoped real routes. Cheap; removes a false "critical" finding
from every future audit.

**P8 — GITHUB_TOKEN for coder sandboxes (E3)** if private repos are ever in
scope; today's public-repo success is an accident of repo visibility.

---

## 5. v2 design — `gan-ui-improve` on the host-preview development lifecycle

The logic test validated dispatch/schemas/voting/loop control. The real GAN
must run where edits are *applied* — and the two-tier
`preview-development-lifecycle` (host parent) + `microservice-dev-session`
(vCluster child, `zai/glm-5.2` via `dapr-agent-py-juicefs`) is the right
substrate: it already provides the app-live preview, HMR receiver
(`/__export`+`/__sync`), durable approval, snapshot→draft-PR promotion, and
generation-fenced teardown.

**Shape (one host workflow, one in-preview child):**

1. **Host: provision** via `preview/environment-launch` (catalog-driven).
   The preview service catalog must include the **browser-critic capability**
   (agent-browser-mcp or BrowserStation lanes as a preview service) — this is
   the only integrate-well path; in-preview injection is blocked by the
   ValidatingAdmissionPolicy, and host→vcluster browsing is (correctly)
   network-isolated.
2. **In-preview child: the GAN loop** as a dynamic script:
   - *Audit* (browser critic, in-vcluster URL, bounded prompt) → structured.
   - *Plan* (coder on `dapr-agent-py-juicefs` with `workspaceRef` **shared
     JuiceFS workspace** — file handoff is real here) reads live source via
     `/__export`, writes contract.json; **the script also carries the contract
     in structured output** (belt and suspenders per P0).
   - *Negotiate* (≤2 rounds) — critic reviews the contract *text from the
     script*, not a file it may not see.
   - *Refine loop*: generator `/__export` → edit `src/` → `/__sync` (HMR) →
     **deterministic gate** (existing GATE_COMMAND) → **voting critics on
     per-node browser lanes** grading the LIVE synced page (no category
     error — the improvement is applied). Blindness = abstention + one
     re-dispatch (P4). Unanimous-with-threshold to accept.
   - *Re-audit* → before/after health delta (closed evaluation loop).
3. **Host: durable approval** (existing `preview.development.control`) →
   `dev/preview-snapshot` + `dev/preview-promote` → draft PR receipt verified
   by the physical broker → teardown.

**Policy/budget tiers.** The $9-vs-$200 GANs.md trade is real but should be a
dial: `tier=smoke` (1 iteration, 1 critic, no re-audit — ~30 min, proves
wiring), `tier=standard` (3 iterations, 2 lane critics, gate — the default),
`tier=exhaustive` (6 iterations, 3 critics + design-token two-pass +
restart-authority for the critic). The 33-minute logic test cost ~276k
input/26k output GLM tokens; a standard preview run is dominated by generator
turns and gate builds (~7 min/iteration observed in P2 work), so budget ≈
1–2h/standard, multi-hour only for exhaustive.

**What v2 deliberately keeps from this run:** bounded browser prompts,
StructuredOutput everywhere, unanimity voting, honest-failure instruction,
prompt-embedded context as the primary channel with files as an optimization.

---

## 6. Codified: run post-mortems as a platform workflow ("Deep analysis" v2)

This debugging session itself followed a repeatable shape: collect-once
(deterministic trace/DB dump) → parallel per-session analysts → adversarial
verification of load-bearing claims → synthesis. The platform already has the
delivery vehicle: the runs-page **Deep analysis** button seeds and executes the
`trace-deep-analysis` dynamic-script workflow
(`src/lib/server/observability/trace-analysis-workflow.ts`, `SCRIPT_VERSION`-
gated upsert, `trace_*` MCP tools auto-wired into script sessions, 400k budget,
`TraceAnalysisReport` schema rendered by `trace-deep-report.svelte`).

**Replace v1's four digest-reading lenses with the post-mortem harness — same
name, same output contract, zero UI/API changes:**

1. *Collect* — one collector agent: `trace_get_digest` + session inventory →
   structured skeleton (sessions, durations, tokens, issues, critical path).
2. *Analyze* — fan out **per-session transcript analysts**
   (`trace_get_llm_turn`, scoped `trace_search_spans`/`trace_get_logs`),
   budget-capped (`budget.remaining()`; analyze top-N sessions by
   duration+tokens when large), each returning findings with verbatim quotes
   and a LOGIC/QUALITY/ENVIRONMENT classification. Keep two cheap fixed lenses
   (cost, reliability) fed from the collector skeleton instead of re-fetching.
3. *Verify* — adversarial refuters on high-severity findings only (≤4). This
   pass is what mattered today: it downgraded "critic held the browser" to
   "idle-stop wedged the browser", refuted the auth-header and clone-egress
   theories, and caught that a "critical 404" was an input typo.
4. *Synthesize* — unchanged `TraceAnalysisReport` schema (findings +
   improvements incl. `revisedScript` for one-click apply).

Why per-session analysts are non-negotiable: v1's lens reviewers read the
digest; **every decisive finding in this report lives in per-turn transcript
content** (the UNRESOLVED proposal, the blind critic's "I judged purely
against the proposal text", the `file://` ERR_FILE_NOT_FOUND, the fabricated
paths). A digest-level review would have scored this run "success, healthy".

Implementation: rewrite `ANALYSIS_SCRIPT`, bump `SCRIPT_VERSION` to `v2` — the
per-project upsert reseeds on next button press. The same saved workflow row
remains runnable ad hoc with any `executionId` (and optional contrast IDs) as
input, which *is* the codified version of this session's harness.

---

## 7. Evidence index

- Transcript dumps, bridge logs, agent configs, timing tables:
  session `gan-evidence/` (durable copy) — per-session TSVs keyed by node hash.
- Key primary quotes: plan write (`Successfully wrote 74 lines to
  /sandbox/work/contract.json`); refine#1 (`UNRESOLVED — could not read a
  contract`); critic #2.2 reasoning (`The browser MCP is entirely unresponsive
  now … Let me evaluate based on the proposal itself`); critic #2.1 vote
  (`NOTE: I could not observe the live app … docked only for the unverified
  live grounding` — score 8, PASS); bridge (`[auto-capture] video
  stopped+persisted (idle)` 16:52:19, `HAR stopped+persisted (idle)` 16:54:19);
  JjufA run0 (`session.status_terminated {"reason":"auto_terminate_after_end_turn"}`).
- Analysis fan-out: 22 agents (10 transcript analysts on the primary model, 8
  investigators + 4 verifiers; two junk "test" structured outputs from the
  cost-reduced verifier pass were discarded and re-verified by hand — itself a
  live demonstration of P4's "schema-valid ≠ grounded").
