export const meta = {
  name: 'dapr118-stage2-durabletask-refactor',
  description: 'Investigate + adversarially verify the per-service durabletask refactor for the Dapr 1.18 app-SDK bump',
  phases: [
    { title: 'Investigate', detail: 'per-service durabletask + dapr-agents collision + orchestrator reuse rework (parallel)' },
    { title: 'Verify', detail: 'adversarially verify the orchestrator rework + collision resolution' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'

const CONTEXT = `
Project: workflow-builder at ${REPO}. We are upgrading the Dapr Python app SDK from 1.17.1 to 1.18.0
(the control plane is ALREADY on 1.18 on ryzen). This is "Stage 2": the per-service durabletask refactor.

VERIFIED SPIKE FINDINGS (do not re-derive; build on these):
- dapr 1.18 SDK vendors durabletask at the PRIVATE module \`dapr.ext.workflow._durabletask.internal.orchestrator_service_pb2[_grpc]\`.
- The standalone \`durabletask\` top-level module is GONE from the base dapr SDK, BUT \`durabletask-dapr==0.17.4\` (pulled by \`dapr-agents 1.0.4\`) re-provides a top-level \`durabletask\` package with \`durabletask/internal/orchestrator_service_pb2[_grpc]\`.
- CRITICAL: \`dapr.ext.workflow._durabletask\` and standalone \`durabletask-dapr\` COLLIDE in the protobuf descriptor pool (both register the proto file \`durabletask/internal/orchestrator_service.proto\`); importing BOTH in one process throws \`AddSerializedFile\` duplicate-file error. They cannot coexist.
- \`dapr.ext.workflow._durabletask\`'s \`CreateInstanceRequest\` DROPPED the \`orchestrationIdReusePolicy\` field (and the \`OrchestrationIdReusePolicy\` message) — this is the 1.18 breaking change (create-over-active now ALWAYS conflicts; no IGNORE policy). \`durabletask-dapr 0.17.4\` STILL has the field.
- \`dapr-agents==1.0.3\` HARD-PINS \`dapr==1.17.3\`; the 1.18-compatible bump is \`dapr-agents==1.0.4\`.
- \`dapr.ext.workflow\` (WorkflowRuntime/DaprWorkflowClient) imports fine under BOTH protobuf 6.33.6 (durabletask-dapr forces 6.x) and protobuf 7.35.1 (base dapr 1.18, no durabletask-dapr).

ENVIRONMENT NOTE (critical for testing imports on this NixOS host): grpcio's wheel can't load libstdc++ in a bare \`uv venv\`. To import grpc-dependent modules, set:
  LD_LIBRARY_PATH=/nix/store/hh698a2nnpqr47lh52n26wi8fiah3hid-gcc-13.3.0-lib/lib (or \`find /nix/store -name libstdc++.so.6 | grep gcc.*lib | head -1\`)
Create scratch venvs with \`uv venv /tmp/<name> --python 3.13\` then \`uv pip install --python /tmp/<name>/bin/python ...\`.

Services importing durabletask directly (the grep result):
- services/workflow-orchestrator/app.py (L37-38) + tracing.py (comment only)
- services/dapr-agent-py/src/main.py (L30, 6614, 6828, 6845, 6931, 7067, 7219, 7246, 7474, 7506) + minimal_main.py (L31)
- services/cli-agent-py/src/taskhub.py (L27, 41, 53)
- services/claude-agent-py/src/main.py (L63, 76, 103)
- services/adk-agent-py/src/main.py (L130, 144, 172)
ONLY services/workflow-orchestrator/app.py uses orchestrationIdReusePolicy (L863-864, in _schedule_new_workflow_instance ~L833; _idempotent_schedule ~L890-998).
dapr-agent-py uses dapr_agents.agents.durable.DurableAgent + \`from dapr.ext.workflow import DaprWorkflowClient\` (L7337, 7349). adk-agent-py uses dapr-agents too (pyproject \`dapr-agents>=1.0.2\`).

THE PER-SERVICE PLAN (your job: VALIDATE + make concrete, find holes):
- no-dapr-agents + no-reuse services (cli-agent-py, claude-agent-py): rewrite \`durabletask.internal.X\` → \`dapr.ext.workflow._durabletask.internal.X\` (protobuf 7, single durabletask copy, no collision). Bump dapr-ext-workflow==1.18.0 + dapr>=1.18.
- orchestrator: same import rewrite + DROP the reuse-policy pb construction + rework _idempotent_schedule to CATCH the 1.18 conflict instead of relying on IGNORE.
- dapr-agent-py + adk-agent-py: bump dapr-agents→1.0.4 (pulls durabletask-dapr). RESOLVE the collision (they import BOTH dapr.ext.workflow AND durabletask.* → would collide).
`

phase('Investigate')

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    concreteEdits: { type: 'array', items: { type: 'string' }, description: 'Exact, file-anchored edits to make' },
    risks: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string', description: 'Commands run + their key output proving the conclusions' },
  },
  required: ['summary', 'concreteEdits', 'risks', 'evidence'],
}

const [daprAgents, orchestrator, importMap] = await parallel([
  () => agent(`${CONTEXT}

YOUR TASK (Agent A — dapr-agents 1.0.4 collision resolution): Determine EXACTLY how to make services/dapr-agent-py and services/adk-agent-py work on Dapr 1.18, given they pull dapr-agents 1.0.4 (→ durabletask-dapr, protobuf 6) AND import both \`dapr.ext.workflow\` and \`durabletask.internal.*\`.

1. Create a venv, \`uv pip install "dapr-agents==1.0.4"\` (let it resolve the full set). Record the resolved versions of dapr, dapr-ext-workflow, durabletask-dapr, protobuf.
2. With LD_LIBRARY_PATH set, test the ACTUAL collision: import \`dapr.ext.workflow\` (and dapr_agents.agents.durable.DurableAgent if importable) AND \`durabletask.internal.orchestrator_service_pb2\` in the SAME process. Does it collide? Then test the candidate fix: rewrite dapr-agent-py's imports to use \`dapr.ext.workflow._durabletask.internal.*\` and AVOID importing standalone \`durabletask\` — does dapr-agents 1.0.4 ITSELF import standalone \`durabletask\` internally (grep its installed source) in a way that would still collide when our code imports dapr.ext.workflow?
3. Determine: does dapr-agents 1.0.4 register its DurableAgent workflow via dapr-ext-workflow (so dapr.ext.workflow._durabletask is the live copy) or via durabletask-dapr? Inspect the installed dapr_agents package source.
4. Conclude the EXACT fix for dapr-agent-py + adk-agent-py: which durabletask import path to use, whether durabletask-dapr can be excluded, and whether the collision is actually avoidable. Provide the concrete edits (import rewrites in main.py/minimal_main.py + pyproject dep changes).
Verify your conclusion by importing the proposed final set together in one process and confirming no descriptor collision + the pb symbols our code uses are present.`, { label: 'dapr-agents-collision', phase: 'Investigate', schema: FINDINGS_SCHEMA }),

  () => agent(`${CONTEXT}

YOUR TASK (Agent B — orchestrator reuse-policy rework): services/workflow-orchestrator/app.py is the ONLY service using orchestrationIdReusePolicy. On 1.18, \`dapr.ext.workflow._durabletask\`'s CreateInstanceRequest has NO orchestrationIdReusePolicy field. Design the EXACT rework.

1. Read app.py: _schedule_new_workflow_instance (~L833-877), _idempotent_schedule (~L890-998), _terminate_and_purge_for_reuse (~L927-959), _taskhub_call. Understand how it builds the pb CreateInstanceRequest + sets orchestrationIdReusePolicy(IGNORE) + the existing zombie-divergence/purge-before-reuse logic.
2. In a venv (dapr 1.18 + LD_LIBRARY_PATH), determine HOW the 1.18 "create over an active instance" conflict surfaces to the SDK caller: what exception/error does StartInstance raise (grpc.RpcError? a specific status code/message like "an active workflow with ID ... already exists")? Inspect the _durabletask client.py / worker error handling.
3. Design the rework: rewrite the import to \`dapr.ext.workflow._durabletask.internal.*\`; REMOVE the orchestrationIdReusePolicy construction (field gone); make _schedule_new_workflow_instance / _idempotent_schedule CATCH the conflict error and route through the EXISTING purge-before-reuse path (so the net behavior — idempotent dedup of deterministic-ID instances — is preserved). Preserve the zombie-divergence handling.
4. Provide the concrete, file-anchored edits + a regression-test sketch (reschedule over a terminal-in-DB-but-RUNNING-in-Dapr instance). Flag risks (e.g., distinguishing the "already exists" conflict from other StartInstance errors).
Provide evidence (the exception type/shape you confirmed for the conflict).`, { label: 'orchestrator-reuse-rework', phase: 'Investigate', schema: FINDINGS_SCHEMA }),

  () => agent(`${CONTEXT}

YOUR TASK (Agent C — per-service import map + _durabletask adequacy): For ALL 5 services, confirm that \`dapr.ext.workflow._durabletask.internal.orchestrator_service_pb2[_grpc]\` provides EVERY pb message + grpc stub method our code uses — so the import rewrite is safe (besides the known orchestrationIdReusePolicy drop, which only orchestrator uses).

1. For each service (workflow-orchestrator/app.py, dapr-agent-py/src/main.py + minimal_main.py, cli-agent-py/src/taskhub.py, claude-agent-py/src/main.py, adk-agent-py/src/main.py): extract EVERY pb.<Symbol> and pb_grpc.<Stub>.<method> referenced near the durabletask imports (e.g. CreateInstanceRequest, RaiseEventRequest, GetInstanceRequest, TerminateRequest, PurgeInstancesRequest, TaskHubSidecarServiceStub.StartInstance/RaiseEvent/GetInstance/TerminateInstance/PurgeInstances, durabletask.internal.shared.*, ORCHESTRATION_STATUS_*).
2. In a venv (dapr 1.18 + LD_LIBRARY_PATH), import \`dapr.ext.workflow._durabletask.internal.orchestrator_service_pb2 as pb\` + \`..._grpc as pb_grpc\` + \`dapr.ext.workflow._durabletask.internal.shared\` and verify EACH symbol/method exists (hasattr / DESCRIPTOR.fields). List any MISSING symbol per service.
3. Conclude per service whether the plain import rewrite (durabletask.internal.X → dapr.ext.workflow._durabletask.internal.X) is sufficient or whether a symbol is missing (besides orchestrationIdReusePolicy).
Provide a per-service table in the summary + the missing[] in risks.`, { label: 'import-adequacy-map', phase: 'Investigate', schema: FINDINGS_SCHEMA }),
])

phase('Verify')

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['sound', 'has-holes'] },
    holes: { type: 'array', items: { type: 'string' } },
    refinements: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'holes', 'refinements'],
}

const verify = await agent(`${CONTEXT}

The investigation produced these findings. ADVERSARIALLY VERIFY them — try to find a case where the proposed refactor breaks. Default to skeptical.

=== Agent A (dapr-agents collision) ===
${JSON.stringify(daprAgents, null, 2)}

=== Agent B (orchestrator reuse rework) ===
${JSON.stringify(orchestrator, null, 2)}

=== Agent C (import adequacy) ===
${JSON.stringify(importMap, null, 2)}

Check specifically:
1. Does the dapr-agents collision resolution ACTUALLY avoid the descriptor-pool collision at RUNTIME (not just dep-resolution)? Re-run the critical import test in a venv to confirm. If dapr-agents 1.0.4 internally imports standalone durabletask, does the proposed fix still collide?
2. Does the orchestrator conflict-catch reliably distinguish the "already exists" conflict from other StartInstance failures (so it doesn't purge+reschedule on an unrelated error)? Is the exception shape confirmed against the real 1.18 SDK?
3. Any service where a pb symbol is missing from _durabletask that Agent C overlooked? Re-spot-check 1-2 services.
4. Cross-service consistency: protobuf version conflicts between services sharing a base image? (cli-agent/claude/orchestrator = protobuf 7; dapr-agent-py/adk = protobuf 6 — confirm each service's image is independent so this is fine.)
Run real commands to verify. Report holes + refinements.`, { label: 'adversarial-verify', phase: 'Verify', schema: VERDICT_SCHEMA })

return {
  daprAgents,
  orchestrator,
  importMap,
  verify,
}