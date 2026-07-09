export const meta = {
  name: 'phase2-recon',
  description: 'Map exact anchors for CLI/JuiceFS resume hardening (Phase 2) across BFF, cli-agent-py, DB schema, stacks monitoring',
  phases: [{ title: 'Recon' }],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string', description: 'concise prose summary of what was found' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'lines', 'what', 'recommendation'],
        properties: {
          file: { type: 'string' },
          lines: { type: 'string', description: 'line range, e.g. 129-160' },
          what: { type: 'string', description: 'what this code does — quote the key lines' },
          recommendation: { type: 'string', description: 'exact insertion point + how to change/test it' },
        },
      },
    },
  },
}

const tasks = [
  {
    label: 'resume-precondition',
    prompt: `Read in ${REPO}: src/routes/api/v1/sessions/+server.ts (lines 90-200), src/lib/server/sessions/spawn.ts (lines 240-400), src/lib/server/sessions/agent-workflow-host.ts (lines 300-410). 
GOAL: document EXACTLY how an interactive-cli session RESUME works today and the precondition that gates it. Specifically:
- The precondition that currently restricts resume to status==='terminated' (find the exact check + line). Is it in the route or a lib function?
- How resumeFromSessionId flows: route -> spawn.ts -> agent-workflow-host.ts -> the subPath re-mount of the JuiceFS transcript store.
- What session fields exist (status values, resumedFromSessionId, runtime family detection — how do we know a session is interactive-cli / claude-code-cli / codex-cli / agy-cli?).
- Recommend: a pure predicate canResumeCliSession(session) living in src/lib/server/sessions/ that ALSO allows resuming a crashed/failed (non-graceful) session, plus exact wiring point. Quote the exact current precondition lines.`,
  },
  {
    label: 'lifecycle-reconciler',
    prompt: `Read in ${REPO}: src/lib/server/lifecycle/index.ts, reaper.ts, cascade.ts, resolvers.ts, ownership.ts (whole files, they are small/medium). Also src/lib/server/lifecycle/cascade.test.ts and resolvers.test.ts headers for the test harness pattern (how do these tests run — vitest? what imports?).
GOAL: find where the lifecycle controller observes a NON-GRACEFUL sandbox exit for a still-active session, and where an auto-resume reconciler decision would hook in. Specifically:
- The reaper's reconcile loop: how it detects DB-active-but-Dapr/sandbox-terminal sessions; what data it has per session (status, runtime, sandbox exit reason, exit code).
- How 'graceful' vs 'non-graceful' termination is currently distinguished (look for end_turn, terminated, failed, crash, exit code).
- The exact place to add: a pure decideAutoResume({session, exit, autoResumeEnabled, restartCount, maxRestarts}) -> {shouldResume, reason} function + where to call it.
- The test harness: how to write a NEW vitest unit test in src/lib/server/lifecycle/ (file naming, imports, run command). Quote a few lines of an existing *.test.ts.`,
  },
  {
    label: 'cli-agent-py-transcript',
    prompt: `Read in ${REPO}: services/cli-agent-py/src/main.py (startup/lifespan + any FastAPI app init), services/cli-agent-py/src/cli_lifecycle.py, services/cli-agent-py/src/session_supervisor.py, services/cli-agent-py/src/output_sync.py, and services/cli-agent-py/src/session_workflow.py (lines 1-60 and 680-730). Also look at services/cli-agent-py/tests/conftest.py and one test file header to learn the pytest harness.
GOAL: find (a) how cli-agent-py detects/uses the per-session JuiceFS transcript store mount (env vars, mount path, symlink setup), and the per-message durability path that MUST be preserved; (b) the best place for a HARD STARTUP ASSERTION that fails loud when an interactive-cli class runs WITHOUT a transcript store CSI mount (so it doesn't silently fall back to ephemeral emptyDir and lose durability). 
Specifically: what env var / mount path signals the transcript store is active? Is there a CLI_* or TRANSCRIPT_* env? Where is the transcript dir symlinked into the mount? Recommend a pure, unit-testable function transcript_store_required(env)/assert_transcript_store(env) + where to call it at startup. Quote exact lines + the test harness (how cli-agent-py tests import modules + run).`,
  },
  {
    label: 'db-schema-flags',
    prompt: `Read in ${REPO}: src/lib/server/db/schema.ts — focus on the 'sessions' table and the 'agents' table definitions (find them by name). 
GOAL: identify where to store (1) a per-agent 'auto-resume' enable flag, (2) a per-session restart/resume COUNT, and (3) a max-restart budget. 
Report: the exact columns that already exist on sessions (status, agentConfig/config JSONB?, resumedFromSessionId, metadata JSONB?, usage, runtime) and on agents (config JSONB?, runtime). Is there a JSONB metadata/config column on each where we can stash autoResume/maxRestarts/restartCount WITHOUT a migration? Quote the relevant drizzle column definitions. Also note how agentConfig is read in src/lib/server/sessions/spawn.ts for CLI sessions. Recommend the least-invasive storage (prefer existing JSONB config/metadata over a new migration).`,
  },
  {
    label: 'stacks-monitoring',
    prompt: `Read in ${STACKS}: find the juicefs store bootstrap manifest (search: find . -iname '*juicefs*'). Read Job-juicefs-store-bootstrap.yaml (or similar). Then find existing monitoring patterns: search for kind PrometheusRule, ServiceMonitor, and CronJob manifests that query Postgres or emit metrics (grep -rl 'PrometheusRule\\|ServiceMonitor\\|kind: CronJob' packages/ | head). Read ONE example PrometheusRule and ONE example monitoring CronJob to learn the house style + where they live + how they're wired into a kustomization.
GOAL: recommend a NEW stacks manifest that monitors/alerts on jfs_blob table growth + per-subtree size in the 'juicefs' Postgres DB, in the existing house style (PrometheusRule alert and/or a CronJob that runs a SQL size query). Report: where juicefs DB/secret config lives (metaurl/connection), the kustomization file to add the new manifest to, and whether Postgres PITR/backup is configured anywhere (search 'pg_dump\\|WAL\\|pgbackrest\\|CloudNativePG\\|VolumeSnapshot' in packages/). Quote exact file paths + a snippet of the example PrometheusRule/CronJob.`,
  },
]

const results = await parallel(
  tasks.map((t) => () =>
    agent(t.prompt, { label: t.label, phase: 'Recon', schema: SCHEMA, agentType: 'Explore' })
      .then((r) => ({ label: t.label, ...r }))
  )
)

return results.filter(Boolean)
