export const meta = {
  name: 'swebench-launch-cancel-recon',
  description: 'Map SWE-bench launch + cancel surface + live dev cluster state for a verification run',
  phases: [{ title: 'Recon', detail: 'parallel: launch API, cancel API, dev cluster state' }],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const DEVKC = 'KUBECONFIG=/tmp/talos-spoke-dev/kubeconfig'   // dev API 5.78.189.54; ns workflow-builder; psql via pod postgresql-0 (psql -U postgres -d workflow_builder)

phase('Recon')

const LAUNCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['createEndpoint', 'method', 'howToTrigger', 'fileRefs'],
  properties: {
    createEndpoint: { type: 'string', description: 'HTTP route or mechanism to CREATE/START a benchmark (SWE-bench) run' },
    method: { type: 'string' },
    authHeader: { type: 'string', description: 'auth required (session admin? internal token? header name)' },
    payloadExample: { type: 'string', description: 'concrete JSON body to start a SMALL (1-2 instance) SWE-bench run, with the exact field names' },
    suiteField: { type: 'string', description: 'how the suite is specified (field name + a known-good value like bsuite_swebench_verified / SWE-bench_Verified)' },
    agentField: { type: 'string', description: 'how the solver agent is specified (field + known-good value like agnt_deepseek_v4_pro_swe_smoke)' },
    instanceCountField: { type: 'string', description: 'how to limit instance count to 1-2' },
    howToTrigger: { type: 'string', description: 'end-to-end: from create call to the coordinator actually running instances (what kicks the coordinator)' },
    fileRefs: { type: 'array', items: { type: 'string' }, description: 'file:line references' },
    notes: { type: 'string' },
  },
}

const CANCEL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['runCancelEndpoint', 'fileRefs'],
  properties: {
    runCancelEndpoint: { type: 'string', description: 'HTTP route to CANCEL a benchmark/eval RUN (the coordinator-owned cascade)' },
    runCancelMethod: { type: 'string' },
    coordinatorOwnedBehavior: { type: 'string', description: 'what happens if you try to Stop a single benchmark INSTANCE execution via the generic per-execution stop (the #70 coordinator_owned 409 redirect)' },
    regularStopEndpoints: { type: 'array', items: { type: 'string' }, description: 'endpoints + modes to Stop a regular workflow execution and a session (interrupt/terminate/purge/reset)' },
    authHeader: { type: 'string' },
    fileRefs: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

const DEVSTATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['notes'],
  properties: {
    coordinatorDeploy: { type: 'string', description: 'swebench-coordinator (or evaluation-coordinator) deployment name + image on dev' },
    coordinatorHealthy: { type: 'string', description: 'is it Running/healthy on dev?' },
    recentRuns: { type: 'array', items: { type: 'string' }, description: 'last few benchmark_runs rows: id, status, suite, agent, instance count, created_at' },
    availableSuites: { type: 'array', items: { type: 'string' }, description: 'benchmark suite ids/names present in the dev DB suitable for SWE-bench' },
    availableAgents: { type: 'array', items: { type: 'string' }, description: 'solver agent ids/slugs present in the dev DB (esp. swe/deepseek smoke)' },
    activeRuns: { type: 'array', items: { type: 'string' }, description: 'any currently non-terminal benchmark_runs on dev (so we do not collide)' },
    notes: { type: 'string' },
  },
}

const [launch, cancel, devState] = await parallel([
  () => agent(
    `In the workflow-builder repo at ${REPO}, find EXACTLY how a user/API starts a SWE-bench benchmark run. ` +
    `Look at src/routes/api (benchmarks/evaluations), src/lib/server/benchmarks/service.ts, swebench-coordinator. ` +
    `I need the concrete create/launch endpoint, method, auth, and a minimal JSON payload to start a SMALL run (1-2 SWE-bench instances) ` +
    `using a known-good suite (e.g. bsuite_swebench_verified / SWE-bench_Verified) and the deepseek SWE smoke solver agent (e.g. agnt_deepseek_v4_pro_swe_smoke). ` +
    `Explain end-to-end what kicks the coordinator to actually run instances. Return file:line refs. Do NOT run anything against any cluster.`,
    { label: 'recon:launch', phase: 'Recon', schema: LAUNCH_SCHEMA, agentType: 'Explore' },
  ),
  () => agent(
    `In the workflow-builder repo at ${REPO}, find EXACTLY how to CANCEL things via the vetted Lifecycle Controller. ` +
    `(1) The endpoint+method to cancel a benchmark/eval RUN (coordinator-owned cascade) — see src/lib/server/benchmarks/service.ts cancelBenchmarkRun, src/lib/server/evaluations/service.ts, and the API routes. ` +
    `(2) What happens when you try to generically Stop a single benchmark INSTANCE workflow execution (the #70 coordinator_owned 409 redirect; src/lib/server/lifecycle/ownership.ts). ` +
    `(3) The endpoints+modes to Stop a REGULAR workflow execution and a session (POST /api/workflows/executions/[id]/stop, POST /api/v1/sessions/[id]/stop; modes interrupt/terminate/purge/reset) and their auth. ` +
    `Return file:line refs. Do NOT run anything against any cluster.`,
    { label: 'recon:cancel', phase: 'Recon', schema: CANCEL_SCHEMA, agentType: 'Explore' },
  ),
  () => agent(
    `Inspect the DEV cluster state for a SWE-bench verification. Use the dev kubeconfig by prefixing kubectl with: ${DEVKC} ` +
    `(dev API 5.78.189.54; namespace workflow-builder). The DB is Postgres pod postgresql-0: ` +
    `${DEVKC} kubectl -n workflow-builder exec postgresql-0 -- psql -U postgres -d workflow_builder -P pager=off -c "<SQL>". ` +
    `Find: (a) the swebench/evaluation coordinator deployment name + image + whether it's Running on dev; ` +
    `(b) the last ~5 benchmark_runs rows (id, status, suite id/name, agent, instance count, created_at) — pick relevant columns after inspecting the table; ` +
    `(c) what SWE-bench benchmark suites exist in the DB (table likely benchmark_suites or similar) and which solver agents exist (agents table, esp. deepseek/swe smoke); ` +
    `(d) any currently NON-terminal benchmark_runs (status not in completed/failed/cancelled) so we do not collide. ` +
    `READ-ONLY: only SELECT queries + kubectl get/describe. Do NOT create, cancel, patch, or delete anything. Return concrete ids/values.`,
    { label: 'recon:devstate', phase: 'Recon', schema: DEVSTATE_SCHEMA },
  ),
])

return { launch, cancel, devState }
