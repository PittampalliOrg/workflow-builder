export const meta = {
  name: 'debug-repo-not-found',
  description: 'Root-cause why an attached GitHub repo never reached a SWE-bench DeepSeek agent sandbox',
  phases: [
    { title: 'Investigate' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
}

const REPO = '/home/vpittamp/repos/PittampalliOrg/workflow-builder/main'
const SEED = `
CONTEXT (verified facts from prior investigation — do NOT re-derive, build on these):
- Repo root: ${REPO}. Branch main is locally STALE at f626a09f; origin/main HEAD = edd1efae (the merged feature "GitHub repos in agent runs + first-class OAuth repo picker + warm").
- The user ran the session on the DEV cluster (NOT ryzen). Dev k8s API (5.78.213.88:6443) is UNREACHABLE from here; dev is observable only via the hub ArgoCD ('kubectl --context hub -n argocd ...') and via the authenticated dev BFF at https://workflow-builder-dev.tail286401.ts.net (browser-only, you cannot reach it from Bash).
- Dev's wfb image pin = git-edd1efae (stacks release-pins/workflow-builder-images.yaml), app spoke-dev-workflow-builder = Synced/Healthy. dapr-agent-py-sandbox pin on dev is also git-edd1efae. So the feature IS deployed on dev.
- The session in question: id LJ3HMBBpNxEx9Nm37pexA, title "idpbuilder", agent "SWE-bench Solver (DeepSeek V4 Pro)" (provider deepseek, runtime dapr-agent-py). It ran via durable/run -> session_workflow in a per-session agent-sandbox pod.
- DECISIVE OBSERVED FACT: that session's resources list is EMPTY ([]), and its event log has ZERO resource_* events (no session.resource_mounted, no session.resource_mount_failed). So the clone broker NEVER RAN for this session.
- The agent's turn-1 output described /sandbox as a fresh sandbox containing: .venv (Python 3.13), .git (two checkpoints: "initial workspace" and "a bash call"), .claude, .agents, .codex, .uv — and "No source code, project files, or repository content yet".

KEY CODE (already read — cite/build on, don't just re-read):
- src/lib/server/sessions/repositories.ts (mountSessionRepositories / mountSingleRepository): clones via daprFetch to getWorkspaceRuntimeUrl()+"/api/workspaces/command" with {executionId: target.executionId, workspaceRef, cwd: rootPath}. Best-effort: on failure emits session.resource_mount_failed; on success emits session.resource_mounted + sets mountedAt. Default mountPath = rootPath + "/" + repoName (e.g. /sandbox/idpbuilder).
- src/lib/server/sandboxes/provision.ts (provisionSessionSandbox): POSTs getWorkspaceRuntimeUrl()+"/api/workspaces/profile" {executionId: session.id, sandboxTemplate, keepAfterRun:true} -> returns {sandboxName, workspaceRef, rootPath}. getWorkspaceRuntimeUrl() default = http://workspace-runtime.workflow-builder.svc.cluster.local:8001 (env WORKSPACE_RUNTIME_URL).
- src/routes/api/v1/sessions/+server.ts: parseRepositoryResources reads BOTH resolvedAgent.config.repositories AND body.resources; builds github_repository rows; ~line 223 provisions sandbox; ~line 266 calls mountSessionRepositories(session.id, {executionId: session.id, workspaceRef, rootPath}).
- src/routes/workspaces/[slug]/sessions/new/+page.svelte line 92: POSTs "resources: repositories.length>0 ? repositories : undefined".
- src/lib/components/sessions/repositories-editor.svelte: empty state shows ONLY an "Add repository" button. Clicking it reveals GithubRepoPicker + a "GitHub URL" input; the user must then click an inner "Add" button (disabled until repoUrl is non-empty) which does onChange([...value, next]) to commit the row into the repositories array. If that inner Add is never clicked, repositories stays [].
`

const FINDING = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'conclusion', 'confidence', 'evidence', 'filesRead'],
  properties: {
    question: { type: 'string' },
    conclusion: { type: 'string', description: 'Direct answer to the assigned question' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Concrete evidence: file:line refs, code quotes, command output' },
    filesRead: { type: 'array', items: { type: 'string' } },
    caveats: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  additionalProperties: false,
  required: ['agrees', 'reasoning'],
  properties: {
    agrees: { type: 'boolean' },
    reasoning: { type: 'string' },
    correctedConclusion: { type: 'string', description: 'If you disagree, the corrected conclusion' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

phase('Investigate')
const QUESTIONS = [
  {
    key: 'rootcause',
    q: `Confirm (or refute) that the reason this session's agent didn't find the repo is simply that NO repository resource was ever attached to the session (so the clone broker never ran). Adversarially consider alternative explanations: (a) a bug in src/routes/api/v1/sessions/+server.ts that drops body.resources before persisting; (b) the SWE-bench/DeepSeek agent creation path bypassing the session-create resource materialization entirely (e.g. created via a benchmark/coordinator path, or an agent-config path that ignores resources); (c) resources persisted but to a different session row. Read +server.ts resource materialization end-to-end, the registry addResource, and how a "SWE-bench Solver" interactive session is created from /sessions/new. State the single most likely reason the resources array is empty.`,
  },
  {
    key: 'reachability',
    q: `THE CRITICAL QUESTION. When a "SWE-bench Solver" DeepSeek session (runtime dapr-agent-py) runs via durable/run -> session_workflow in a per-session agent-sandbox pod, what filesystem do its bash/file/OpenShell tools operate on for "/sandbox"? Is it (A) the SAME workspace-runtime/openshell sandbox that provisionSessionSandbox creates via /api/workspaces/profile keyed by executionId=session.id (the SAME place repositories.ts clones into via /api/workspaces/command), or (B) a DIFFERENT, agent-sandbox-pod-local filesystem? The agent reported /sandbox containing baked .venv/.claude/.agents/.codex/.uv + checkpoints — determine if that is the openshell-sandbox image content of a workspace-runtime sandbox OR an agent-sandbox pod. Read the dapr-agent-py runtime's OpenShell/tool wiring (services/dapr-agent-py/src/**), how it resolves its sandbox/executionId, services/*/sandbox-execution-api if present, the seed-openshell-config init container, and CLAUDE.md's Agent Runtime Model. CONCLUDE: if a repo were correctly attached and cloned via /api/workspaces/command(executionId=session.id), would it appear in THIS agent's /sandbox? Answer YES (reaches it) or NO (sandbox mismatch — feature broken for this agent class) with the mechanism.`,
  },
  {
    key: 'delivery',
    q: `Investigate the clone DELIVERY path's health on the DEV cluster specifically. (1) Is the workspace-runtime service/deployment that getWorkspaceRuntimeUrl() targets actually running on dev? You cannot kubectl dev directly, but you CAN use 'kubectl --context hub -n argocd ...' to inspect dev app health, and read the stacks repo at ~/.cache/skaffold/stacks-ryzen (origin/main) for the dev workspace-runtime pin/manifests. (2) Does workspace-runtime even still exist as a component, or was it decommissioned (check CLAUDE.md / memory references to workspace-runtime removal)? (3) If workspace-runtime is dead on dev, what would mountSingleRepository's daprFetch to /api/workspaces/command do — fail (emit resource_mount_failed) or hang? Note: for THIS session there were ZERO resource events, so the clone was never even attempted — but determine whether the delivery path is healthy for FUTURE correctly-attached repos on dev.`,
  },
]

const findings = await parallel(QUESTIONS.map(item => () =>
  agent(`${SEED}\n\nYOUR ASSIGNED QUESTION (${item.key}):\n${item.q}\n\nYou have Read, Grep, Glob, Bash. Read real files under ${REPO}; query the hub ArgoCD and the stacks cache clone where useful. Return a precise, evidence-backed finding.`,
    { label: `investigate:${item.key}`, phase: 'Investigate', schema: FINDING })
    .then(f => ({ key: item.key, finding: f }))
)).then(rs => rs.filter(Boolean))

phase('Verify')
// Adversarially verify the riskiest claim: the sandbox-reachability conclusion.
const reach = findings.find(f => f.key === 'reachability')
let reachVerdict = null
if (reach) {
  reachVerdict = await agent(
    `${SEED}\n\nAn investigator concluded the following about whether a cloned repo would reach the SWE-bench DeepSeek (dapr-agent-py) agent's /sandbox:\n\nCONCLUSION: ${reach.finding.conclusion}\nCONFIDENCE: ${reach.finding.confidence}\nEVIDENCE: ${(reach.finding.evidence||[]).join(' | ')}\n\nYour job: try to REFUTE this. Independently read the dapr-agent-py runtime sandbox wiring + provision.ts + repositories.ts + sandbox-execution-api + CLAUDE.md Agent Runtime Model. Is the claim that the clone-target sandbox (workspace-runtime, executionId-keyed) is the SAME-or-DIFFERENT filesystem as the agent's /sandbox actually correct? Pay special attention to: does dapr-agent-py route OpenShell tool calls to workspace-runtime/openshell-agent-runtime with the SAME executionId/sandboxName the BFF used, or does it run bash in-pod? Default to agrees=false if the evidence is not airtight.`,
    { label: 'verify:reachability', phase: 'Verify', schema: VERDICT })
}

phase('Synthesize')
const synth = await agent(
  `${SEED}\n\nINVESTIGATOR FINDINGS:\n${findings.map(f => `### ${f.key}\nconclusion: ${f.finding.conclusion}\nconfidence: ${f.finding.confidence}\nevidence: ${(f.finding.evidence||[]).join(' | ')}\ncaveats: ${f.finding.caveats||''}`).join('\n\n')}\n\nADVERSARIAL VERDICT on the reachability finding: ${reachVerdict ? JSON.stringify(reachVerdict) : 'n/a'}\n\nSynthesize the definitive answer for the user, who asked: "debug why my session where I added the idpbuilder repo resulted in the agent not finding the repo." Produce:\n1. PRIMARY ROOT CAUSE (why THIS session's agent didn't find the repo) — be direct.\n2. SECONDARY/LATENT ISSUE — would the feature even work for a SWE-bench DeepSeek (dapr-agent-py) agent if the repo HAD been attached correctly? (Resolve the sandbox-reachability question, honoring the adversarial verdict — if the verdict refuted the finding, say the question is unresolved/risky rather than overclaiming.)\n3. CONCRETE FIX/NEXT STEPS — ranked, specific (UI commit-step, and if there's a sandbox-mismatch, the architectural fix needed). Keep it tight and actionable.`,
  { label: 'synthesize', phase: 'Synthesize' })

return { findings, reachVerdict, synthesis: synth }