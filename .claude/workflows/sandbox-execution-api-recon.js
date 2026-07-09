export const meta = {
  name: 'sandbox-execution-api-recon',
  description: 'Map sandbox-execution-api usage and agent-sandbox prior art across repos',
  phases: [{ title: 'Recon', detail: '4 parallel explore agents' }],
}
phase('Recon')
const results = await parallel([
  () => agent(`Explore /home/vpittamp/repos/PittampalliOrg/stacks/main (read-only). Map EVERY reference to sandbox-execution-api:
1. Read all files under packages/components/workloads/sandbox-execution-api/ — report the Deployment (image, env vars, args, ports), Service, and especially the Role/RoleBinding RBAC (which k8s resources/verbs the api and the sandbox-execution-worker ServiceAccounts get — this tells us what the API actually does to the cluster).
2. Which environments deploy it: grep overlays/kustomizations (packages/overlays/*, workflow-builder-system*, hub-spoke-appsets) for sandbox-execution-api — list which clusters (ryzen/dev/staging/hub) include it.
3. Consumers inside stacks: packages/components/workloads/workflow-builder/manifests/Deployment-workflow-builder.yaml (which env vars point at sandbox-execution-api and what they're named), packages/components/workloads/kueue-capacity/manifests/capacity-observer/observer.py (how/why it references the API), release-pins files (image pinning flow), and the Tekton outer-loop references (TriggerBinding/EventListener) — is sandbox-execution-api one of the built images?
4. Read docs/dapr-workflows-and-agents-termination.md and docs/goals/swebench-concurrency-admission.md sections that mention sandbox-execution-api — summarize the architectural role they describe.
Be thorough ("very thorough" breadth). Return a structured report with file:line citations. Your final text is raw data for the orchestrator, not prose for a human.`, { label: 'stacks-usage' }),
  () => agent(`Explore the workflow-builder application repo (read-only). First run: ls /home/vpittamp/repos/PittampalliOrg/workflow-builder to find worktrees (likely 'main'). Then in the active worktree:
1. Locate the sandbox-execution-api service SOURCE CODE (search for 'sandbox-execution' / 'sandbox_execution' dirs, Dockerfiles, pyproject/package.json). Report its full API surface: every HTTP/gRPC endpoint (method, path, semantics) — sandbox creation, exec, status, logs, deletion, anything else.
2. How does it implement sandboxes — does it create k8s Pods/Jobs directly, use Kueue, use any CRD? How does it report sandbox STATUS (polling pods? watch? DB rows?)? Does it have a worker component (sandbox-execution-worker) and what does the worker do?
3. Find ALL clients/callers of this API across the repo: swebench coordinator/evaluator, workflow-orchestrator, runtimes (dapr-agent-py/claude-agent-py), UI/Benchmarks surfaces, env vars like SANDBOX_EXECUTION_API_URL. For each caller: which endpoints it calls and why.
4. Note anything about sandbox lifecycle guarantees: timeouts, readiness (e.g. sandbox_readiness_timeout), cleanup, warm pools, snapshotting.
Be very thorough. Return a structured report with file paths. Your final text is raw data for the orchestrator.`, { label: 'wfb-source' }),
  () => agent(`Explore prior agent-sandbox experimentation (read-only):
1. /home/vpittamp/repos/PittampalliOrg/agent-sandbox — what is this clone (git log -5, git remote -v, current branch/tag)? Summarize the project layout: CRDs (Sandbox, SandboxTemplate, SandboxClaim?), controller, any REST/exec gateway or client SDK, status fields on the Sandbox CRD (read the CRD types / api types), shutdown/suspend/resume features, and the version it's at.
2. /home/vpittamp/repos/PittampalliOrg/stacks/125-agent-sandbox — this is a stacks worktree/branch named 125-agent-sandbox. Run: git -C /home/vpittamp/repos/PittampalliOrg/stacks/125-agent-sandbox log --oneline -15 and git diff main...HEAD --stat (or appropriate) to see what was prototyped. Summarize what integration was attempted (manifests added, which components, was it ever merged?).
3. Check whether stacks/main ALREADY deploys anything agent-sandbox related: rg -l 'agent-sandbox|agents.x-k8s.io|SandboxTemplate|kind: Sandbox' /home/vpittamp/repos/PittampalliOrg/stacks/main.
Return a structured report with file paths and findings. Your final text is raw data for the orchestrator.`, { label: 'prior-art' }),
  () => agent(`Cross-repo consumer sweep (read-only). Run rg -l --no-messages 'sandbox-execution|sandbox_execution|SANDBOX_EXECUTION' across /home/vpittamp/repos/PittampalliOrg/ EXCLUDING stacks/ and workflow-builder/ (other agents cover those), e.g. check SWE-bench, evals, dapr-swe, dapr-agent-py, claude-code-src, openshell-deepagent, workflow-examples, deployment. For each hit: what role does sandbox-execution-api play there (client? docs? config?). Also search those repos for 'agent-sandbox' / 'agents.x-k8s.io' to find other prior art. Keep it focused — just identify consumers and their endpoints used. Return a structured list with repo/file paths. Your final text is raw data for the orchestrator.`, { label: 'cross-repo' }),
])
return {
  stacksUsage: results[0],
  wfbSource: results[1],
  priorArt: results[2],
  crossRepo: results[3],
}