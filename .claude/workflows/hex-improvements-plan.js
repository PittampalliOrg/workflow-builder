export const meta = {
  name: 'hex-improvements-plan',
  description: 'Design + critique a prioritized hexagonal-architecture improvement plan',
  phases: [
    { title: 'Design', detail: 'Plan agent designs the improvement program' },
    { title: 'Critique', detail: 'adversarial review of the design' },
  ],
}

const WB = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const CONTEXT = `
CONTEXT (verified by prior exploration of ${WB} and ${STACKS}):
The SvelteKit app completed a hex/ports-adapters refactor: 0/411 route server files import db/drizzle; 341/411 go through src/lib/server/application; ports.ts = 5,905 lines / 125 port interfaces; composition root getApplicationAdapters() in application/index.ts (1,712 lines, wires ~45 Postgres* + Dapr*/Kubernetes*/ClickHouse*/Otel*/Legacy* adapters); workflow-data.ts = 5,757-line ApplicationWorkflowDataService god-facade; adapters/ = ~110 files, 43k lines; all 53 drizzle-importing files under adapters/. 91 application services with paired unit tests. Python orchestrator: WORKFLOW_DATA_API_MODE (postgres | http-fallback-db DEFAULT | http strict) x WORKFLOW_DATA_API_TRANSPORT (dapr default | direct); 10 runtime-persistence activities fully off Postgres; all remaining SQL in one module workflow_data_postgres_rollback.py imported only by app.py; strict mode proven by tests/test_workflow_data_activity_migration.py + live preview evidence "hex-strict-0704" (docs/workflow-orchestrator-postgres-inventory.md:1498-1517).

IDENTIFIED IMPROVEMENT AREAS (from the research):
P1. Global import-boundary guard — the weakest link: NO dependency-cruiser and NO eslint no-restricted-imports anywhere; enforcement is only 34 hand-written *-boundary.test.ts files (readFileSync + regex per file) + manual rg scans. A new route importing $lib/server/db would pass CI.
P2. Complete the strict workflow-data cutover — default is still http-fallback-db; strict http is preview-proven only. Path: flip envs to strict, soak, then delete the rollback module + fallback branches.
P3. Decompose quarantine adapters — benchmark-service.ts (6,907 lines), evaluation-service.ts (3,702), mlflow-lifecycle.ts (1,710), benchmark-trace-bundle.ts (1,394) were moved wholesale behind one port; plus ~10 "pending deeper split" transport seams flagged in docs/workflow-orchestrator-postgres-inventory.md (~lines 277, 513, 539, 636, 1338, and 1471-1485 roadmap).
P4. Contract formalization of the process-boundary ports — /api/internal/workflow-data/* (19 routes, consumed by the orchestrator via Dapr invoke) and other /api/internal consumers (ensure-for-workflow, connections decrypt, session event ingest, goals) have no OpenAPI/contract tests pinning both sides; additive-only policy undocumented.
P5. Structural ergonomics — ports.ts (5.9k lines) and ApplicationWorkflowDataService (5.7k) are monoliths; consider non-breaking file splits (ports/<domain>.ts re-exported) and/or facade decomposition.
ADJACENT (not hex, found during research, optional): server-prod.js gracefulShutdown hard-exits process.exit(1) at 10s (line ~363) despite 90s grace → kills live WS terminals/SSE on every rollout; app container has NO readinessProbe (PDB minAvailable:1 exists).
`

phase('Design')

const design = await agent(`${CONTEXT}

You are designing a concrete, prioritized implementation plan for these hexagonal-architecture improvements in ${WB} (app repo) and ${STACKS} (GitOps repo). GROUND EVERY RECOMMENDATION IN THE ACTUAL REPO — read files before prescribing. For each priority produce: exact files to create/modify, the approach, effort band (S/M/L), risk, and verification steps.

Required investigations:
1. P1 guard: Read the actual lint setup (eslint config file(s), package.json scripts, any CI — check .github/workflows/*, and how tests run today). Decide dependency-cruiser vs eslint no-restricted-imports vs a vitest-based structural test (note: repo already uses vitest; also note SvelteKit itself already blocks $lib/server imports from client code, so the guard's real job is: (a) drizzle-orm/$lib/server/db importable ONLY from src/lib/server/application/adapters/**, src/lib/server/db/**, startup.ts, scripts/; (b) src/routes/** must not import application/adapters/** directly — VERIFY whether any route does today; (c) optionally: application/ top-level services must not import $lib/server outside application/). Propose the exact rule config + where it's wired so CI fails on violation. Decide the fate of the 34 hand-written boundary tests (keep/retire).
2. P2 strict cutover: Find where WORKFLOW_DATA_API_MODE / WORKFLOW_DATA_API_TRANSPORT are set in ${STACKS} (ConfigMap-workflow-orchestrator-config.yaml and any overlay variants per env: dev/ryzen/staging). Propose the rollout sequence (which env first, soak criteria — what to watch: orchestrator logs for fallback/psycopg matches, workflow run success rates), and the end-state deletion list in ${WB}/services/workflow-orchestrator (workflow_data_postgres_rollback.py, the 8 flag-gated app.py helpers' fallback branches, the flag itself?) with the tests to update.
3. P3 decomposition: Read docs/workflow-orchestrator-postgres-inventory.md sections around lines 277/513/539/636/1338/1471-1485 to extract the ACTUAL pending-deeper-split list. Look at adapters/benchmark-service.ts and evaluation-service.ts structure (exported class(es), method clusters) enough to propose 3-6 coherent slices each and the repeatable slice recipe (the repo's own commit arc pattern: extract narrow port into ports.ts → move impl into focused adapter file → wire composition root → boundary test). Propose slice ORDER by value/risk.
4. P4 contracts: Look at services/workflow-orchestrator/activities/workflow_data_client.py (the python consumer) and the 19 routes under src/routes/api/internal/workflow-data/. Propose the lightest contract mechanism that pins BOTH sides (e.g. shared JSON schema / zod schemas exported + a python contract test hitting route handlers via fixture payloads, or typed fixtures checked in both repos) — avoid heavyweight OpenAPI tooling unless the repo already has something. Check if zod or similar is already used in the routes.
5. P5 ergonomics: Verify ports.ts/workflow-data.ts internal structure enough to say whether a mechanical non-breaking split (ports/<domain>.ts + re-export barrel) is safe with the current import graph (who imports ports.ts and how). Recommend do-now vs defer.
6. ADJACENT deploy-safety (optional section, small): server-prod.js graceful shutdown fix + readinessProbe in ${STACKS} Deployment-workflow-builder.yaml — one paragraph each.

RETURN: the full prioritized plan (P1→P5 + adjacent), each with concrete file paths, approach, effort, risk, verification. Flag anything you could NOT verify.`, { label: 'design:hex-improvements', phase: 'Design' })

phase('Critique')

const critique = await agent(`${CONTEXT}

A colleague produced the following implementation plan for hexagonal-architecture improvements. Adversarially review it against the ACTUAL repos at ${WB} and ${STACKS} — verify its load-bearing claims (file paths exist, rules are feasible, no existing mechanism already does what it proposes, slice boundaries make sense, the strict-cutover env locations are right). Identify: (a) factual errors, (b) missing improvements the plan should include, (c) over-engineering to cut, (d) ordering/risk problems. Be specific with file:line evidence.

THE PLAN:
${'='.repeat(40)}
` + design + `
${'='.repeat(40)}

RETURN: a verdict per priority (sound / needs-fix with the fix / cut), plus any missed improvements.`, { label: 'critique:hex-improvements', phase: 'Critique' })

return { design, critique }