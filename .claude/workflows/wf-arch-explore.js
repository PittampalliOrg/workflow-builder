export const meta = {
  name: 'wf-arch-explore',
  description: 'Explore workflow-builder SW1.0 persistence/interpreter + Dapr workflows-as-code surfaces + stacks K8s config',
  phases: [{ title: 'Explore', detail: 'parallel Explore agents over persistence, interpreter, code-workflows, stacks' }],
}

const FINDINGS = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'summary', 'key_files', 'how_it_works', 'constraints_or_gaps', 'relevant_for_alternate_design'],
  properties: {
    area: { type: 'string' },
    summary: { type: 'string', description: '3-6 sentence overview' },
    key_files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'role'],
        properties: { path: { type: 'string' }, role: { type: 'string' } },
      },
    },
    how_it_works: { type: 'string', description: 'detailed mechanism, data flow, code traces with file:line where possible' },
    constraints_or_gaps: { type: 'array', items: { type: 'string' } },
    relevant_for_alternate_design: { type: 'string', description: 'what this implies for a Dapr workflows-as-code alternate, runtime creation, storage/listing' },
  },
}

phase('Explore')

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const STACKS = '/home/vpittamp/repos/PittampalliOrg/stacks/main'

const tasks = [
  {
    label: 'persistence-api',
    prompt: `Explore the workflow-builder repo at ${REPO}. Focus: HOW Serverless Workflow (SW) 1.0 workflow definitions are PERSISTED, created, listed, versioned, and updated.

Investigate:
- The Drizzle schema for workflows: src/lib/server/db/schema.ts — the 'workflows' table (id, name, nodes JSONB, edges JSONB, engine_type, MCP trigger config) and 'workflow_executions'. What columns store the SW 1.0 spec? Is the SW 1.0 spec stored, or derived from nodes/edges at runtime?
- API routes: src/routes/api/workflows/** — create, list, get, update, publish, execute. How does a workflow get from the canvas to the DB to the orchestrator?
- Is there any versioning of workflow definitions? Drafts vs published? Where is the SW 1.0 YAML/JSON spec materialized and where is it sent to the orchestrator?
- How does execution start: what payload does the BFF send to the orchestrator (the SW 1.0 spec inline? a workflow id? nodes/edges)?

Report file:line traces. Be concrete about the data model and the create/list/persist lifecycle.`,
  },
  {
    label: 'sw-build-and-interpret',
    prompt: `Explore the workflow-builder repo at ${REPO}. Focus: HOW the SW 1.0 spec is BUILT from the UI canvas and HOW the orchestrator INTERPRETS it into a running Dapr workflow.

Investigate:
- The SW 1.0 SDK / buildGraph: search src/lib for serverless-workflow, sw 1.0, buildGraph, spec emitter. How do nodes/edges (Svelte Flow) translate into an SW 1.0 spec (states/actions)? Where does that live?
- The "workflow-as-code emitter" — there is already an emitter that inlines called code_function bodies (default ON; slug-only via inlineFunctions=false). Find it. What does it emit (TS? Python? a different SW form?). This is important.
- The orchestrator interpreter: services/workflow-orchestrator/workflows/sw_workflow.py and the Dapr workflow registered as 'sw_workflow_v1'. How does it walk the SW 1.0 spec and execute each node? How are actions mapped to functions (durable/run vs system/* vs activepieces), and how does it use ctx.call_activity / ctx.call_child_workflow?
- How is the SW 1.0 spec passed into the Dapr workflow as input? Is the spec the workflow INPUT (data-driven interpreter) rather than compiled code?

Report file:line traces. Make the data-driven-interpreter model crystal clear, and note exactly where the existing workflow-as-code emitter sits and what it produces.`,
  },
  {
    label: 'dapr-code-workflows',
    prompt: `Explore the workflow-builder repo at ${REPO}. Focus: HOW Dapr workflows are defined AS CODE today (the "workflows as code" methodology), so we can compare against the data-driven SW 1.0 interpreter.

Investigate:
- services/dapr-agent-py and services/claude-agent-py and services/adk-agent-py: the Dapr workflow 'session_workflow' registered via dapr-ext-workflow (WorkflowRuntime / @wfr.workflow decorators). Show the registration pattern: how workflows + activities are declared in Python code, how the worker starts, how WorkflowApp/WorkflowRuntime.start() registers them.
- services/workflow-orchestrator: how does IT register its workflows/activities at startup (main.py / app bootstrap)? Which workflows are registered (sw_workflow_v1, etc.)? Where is the WorkflowRuntime started and how are activities (activities/*.py) registered?
- The dapr-ext-workflow version (1.17.1) constraints: are workflows required to be registered at WORKER STARTUP (i.e., you cannot register a brand-new workflow function at runtime without redeploy)? Look for evidence in how registration works.
- How does ctx.call_child_workflow dispatch across app-ids (the durable/run → session_workflow path)?

Report file:line traces. Be explicit about the registration-at-startup constraint and what it would take to add a NEW code-defined workflow (rebuild/redeploy vs runtime).`,
  },
  {
    label: 'stacks-k8s',
    prompt: `Explore the stacks (GitOps/K8s infra) repo at ${STACKS}. Focus: the Kubernetes/Dapr deployment of the workflow-orchestrator and agent runtimes, and what infra would change to support a Dapr "workflows-as-code" model and/or runtime-created workflows.

Investigate:
- workloads/workflow-orchestrator/** : the Deployment, image pin, Dapr annotations, env, the Dapr Configuration + Components it uses (workflowstatestore actorStateStore=true, statestores, pubsub).
- The Dapr workflow state store component(s) and Configuration objects (stateRetentionPolicy, placement). How is the workflow task hub / placement configured?
- The agent-sandbox / per-session pod deployment surfaces, runtime-registry, and how new agent images/workflows are delivered (commit-pin, kustomize, ArgoCD).
- Anything relevant to: (a) where workflow CODE would live and be built/deployed, (b) how you'd register additional code-defined workflows, (c) whether a separate "code-workflow worker" deployment would be needed, (d) storage options already present (Postgres, Redis) usable for storing workflow definitions.
- Look for how many app-ids/task-hubs exist and the placement service.

List concrete file paths under ${STACKS}. Report what exists and what is missing for the alternate design.`,
  },
]

const results = await parallel(
  tasks.map(t => () => agent(t.prompt, { label: t.label, phase: 'Explore', agentType: 'Explore', schema: FINDINGS }))
)

return results.filter(Boolean)
