export const meta = {
  name: 'ap-chaos-checks',
  description: 'Activepieces piece-runtime chaos checks against live ryzen with real github connection',
  phases: [
    { title: 'Checks', detail: 'cached-failure replay, large-result offload, orchestrator end-to-end' },
  ],
}

const SCHEMA = {
  type: 'object',
  required: ['check', 'verdict', 'evidence'],
  properties: {
    check: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'fail', 'inconclusive'] },
    evidence: { type: 'string', description: 'concrete observed values (HTTP responses, DB rows, kubectl output) supporting the verdict' },
    notes: { type: 'string' },
  },
}

const CTX = [
  'Live ryzen cluster, kube context admin@ryzen. The Activepieces converged piece-runtime is deployed.',
  '- function-router internal URL (port 80): http://function-router.workflow-builder.svc.cluster.local/execute',
  "- To call it, run an ephemeral curl pod: kubectl --context admin@ryzen run <uniqueName> -i --rm --restart=Never -n workflow-builder --image=curlimages/curl:8.10.1 --quiet --command -- sh -c '<script>' (UNIQUE pod name per call; on name collision pick another).",
  '- Real github connection_external_id: conn_sHmSDyCpM18vNwov49kZn (PLATFORM_OAUTH2, user vpittamp).',
  '- Scratch repo: vpittamp/wfb-chaos-check (private; issue #1 already exists from a prior dedupe check). Use the host gh CLI (authed as vpittamp) for GitHub ground truth.',
  '- Postgres exec template: kubectl --context admin@ryzen exec postgresql-0 -n workflow-builder -- sh -c \'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "<SQL>"\'  (POSTGRES_DB defaults to workflow_builder; if empty, try database name workflow_builder).',
  '- piece_execution columns: idempotency_key (PK), workflow_id, execution_id, db_execution_id, node_id, piece_name, action_name, piece_version, connection_external_id, status, attempt, result (jsonb), error, error_class, created_at, updated_at.',
  '- /execute request: {function_slug:"github/<action>", execution_id, workflow_id, node_id, node_name, db_execution_id, idempotency_key, connection_external_id, input:{...}}. github_create_issue input: {repository:{owner,repo}, title, description?}. find_user input: {username}.',
  'Return ONLY the structured verdict. Keep side effects in the scratch repo.',
].join('\n')

phase('Checks')

const results = await parallel([
  () => agent(CTX + '\n\nCHECK: cached permanent-failure replay (gate returns cached failure, no second GitHub call).\nA prior call with idempotency_key "chaos:permanent:attempt-A" already failed permanently (create issue in repo-that-does-not-exist-xyz -> 404 -> piece_execution row status=failed error_class=permanent attempt=1).\nNow: (1) query the piece_execution row for that key (record attempt). (2) RE-CALL /execute with the EXACT same idempotency_key + same input. (3) query the row again.\nExpected: the second response returns the cached failure carrying the 404 error and "deduped":true, WITHOUT a new GitHub call; the row stays failed/permanent (attempt may or may not bump depending on gate semantics — record what you see). Verdict pass if the cached failure is returned (ideally deduped:true) and no new GitHub state was created.',
    { label: 'check:cached-failure-replay', phase: 'Checks', schema: SCHEMA }),

  () => agent(CTX + '\n\nCHECK: large-result offload (>4 MiB result -> artifactRef; full payload in piece_execution.result; readable via BFF internal endpoint).\nTry to produce a piece result whose serialized JSON exceeds 4 MiB so /execute offloads it. Approach: github custom_api_call GET on a large list endpoint (try https://api.github.com/repos/torvalds/linux/commits?per_page=100), or rawGraphqlQuery returning many nodes. custom_api_call input shape: {method:"GET", url:"<full url>"} — if it errors on prop names, query piece_metadata for the custom_api_call inputSchema properties and adjust. If you cannot exceed 4 MiB in 2-3 attempts, FALL BACK to verifying the plumbing: (a) the BFF internal endpoint GET http://workflow-builder.workflow-builder.svc.cluster.local:3000/api/internal/piece-executions/<key> with header "X-Internal-Token: <token>" (token from: kubectl --context admin@ryzen get secret workflow-builder-secrets -n workflow-builder -o jsonpath="{.data.INTERNAL_API_TOKEN}" | base64 -d) returns the stored row; (b) a normal completed call stores its full result in piece_execution.result (select length(result::text) ...).\nUse idempotency_key "chaos:offload:attempt-A", db_execution_id "chaos-offload-1".\nVerdict pass if EITHER a real >4MiB offload produced an artifactRef AND the internal endpoint returned the full row, OR (fallback) the internal endpoint works + result is stored. inconclusive only if neither verifiable.',
    { label: 'check:large-result-offload', phase: 'Checks', schema: SCHEMA }),

  () => agent(CTX + '\n\nCHECK: orchestrator end-to-end — a real SW 1.0 workflow runs a github action as a durable activity with the orchestrator-MINTED idempotency key (NOT hand-supplied to function-router).\nThis is the most important check: prove the FULL orchestrator path.\nSteps: (1) Inspect the workflow-builder repo at /home/vpittamp/repos/PittampalliOrg/workflow-builder/main for the workflow execute endpoint (src/routes/api/workflows/**, src/routes/api/orchestrator/**) and how it calls the orchestrator; also check the orchestrator HTTP API (services/workflow-orchestrator) for a start-execution route reachable at http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080. (2) Find or create a minimal SW 1.0 workflow with ONE github action node, read-only github/find_user{username:"vpittamp"} bound to connection conn_sHmSDyCpM18vNwov49kZn (check existing rows first: select id,name from workflows where spec::text like \'%github/%\' limit 5). (3) Trigger execution through the orchestrator (prefer the orchestrator internal API or the BFF internal execution path; the BFF UI route is session-gated and hard from a pod). (4) Verify a piece_execution row appears with an orchestrator-MINTED key of shape "<workflowId>:<dbExecutionId>:<taskName>" (colon-separated, NOT "chaos:..."), status=completed, and the workflow_executions row shows success.\nCapture the workflow id, execution id, the minted idempotency_key, and final status/output. Verdict pass if a github action ran through the orchestrator producing an orchestrator-minted piece_execution row + successful execution. If triggering is genuinely blocked, document precisely what you tried and mark inconclusive — do NOT fabricate.',
    { label: 'check:orchestrator-e2e', phase: 'Checks', schema: SCHEMA, model: 'opus' }),
])

return results.filter(Boolean)