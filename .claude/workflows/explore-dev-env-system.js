export const meta = {
  name: 'explore-dev-env-system',
  description: 'Map the vcluster preview system, hexagonal architecture, and iteration tooling',
  phases: [
    { title: 'Explore', detail: '4 parallel read-only explorers' },
  ],
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Detailed markdown narrative of what you found — mechanisms, flows, timings. Write for an architect planning improvements; be specific with file paths.' },
    key_files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, why: { type: 'string' } }, required: ['path', 'why'] } },
    friction_points: { type: 'array', items: { type: 'string' }, description: 'Concrete slowness/awkwardness in the current dev-iteration story, with evidence' },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'key_files', 'friction_points', 'open_questions'],
}

phase('Explore')

const CONTEXT = `Context: The user runs a GitOps hub-and-spoke Kubernetes platform (repo /home/vpittamp/repos/PittampalliOrg/stacks/main, ArgoCD + argocd-agent, Talos clusters: hub, dev, ryzen). Their main product is "workflow-builder" (SvelteKit app + Dapr workflow microservices, repo /home/vpittamp/repos/PittampalliOrg/workflow-builder/main). They recently built vcluster-based preview/dev environments and migrated workflow-builder to hexagonal architecture (ports & adapters). GOAL of this exploration: gather everything needed to design an improved dev-environment system where agentic coding workflows and interactive agent sessions can edit microservices and preview live changes on a running copy of the system as fast as possible. Be very thorough. Your final message is data for an orchestrator, not prose for a human — but make the summary detailed and complete.`

const results = await parallel([
  () => agent(`${CONTEXT}

YOUR AREA: The vcluster-based preview/dev-environment system in the stacks repo.

Read thoroughly (all under /home/vpittamp/repos/PittampalliOrg/stacks/main unless noted):
- packages/components/workloads/workflow-builder-preview-vcluster/ — EVERYTHING: README.md, provision.sh, teardown.sh, runner.sh, deploy-app.sh, vcluster.yaml, kro/ (README + manifests), agent-bootstrap/ (incl. Job-coredns-principal-rewrite.yaml, argocd-agent-bases), app-overlay/Application-preview.tmpl.yaml, preview-surface-exclusions.txt, runner-image/Dockerfile, manifests/ (ServiceAccount-provisioner, RBAC-sandbox-execution-api)
- packages/components/workloads/sandbox-execution-api/ — what is this API, who calls it, how does it relate to preview vclusters?
- packages/components/hub-spoke-appsets/apps/preview-workloads-appset.yaml
- packages/overlays/dev/apps/workflow-builder-preview-vcluster.yaml and packages/overlays/ryzen/apps/workflow-builder-preview-vcluster.yaml
- scripts/gitops/validate-preview-vcluster-surface.sh
- docs/gitops-architecture-overview.md and docs/gitops-inner-outer-loop-visualization.md (preview/vcluster sections)

Answer specifically:
1. End-to-end lifecycle: what triggers creation of a preview vcluster, what runs inside it (full workflow-builder stack? which services? shared vs per-preview Postgres/Dapr/NATS?), how long provisioning takes (any documented timings), how teardown happens.
2. How code changes reach a preview: does it deploy a built image (from where — GHCR? Tekton?), a git ref, or live-synced source? Is there any hot-reload path into the vcluster?
3. How a human or agent accesses the preview (URLs, Tailscale, ingress, port-forward) and how the preview surface differs from real dev (exclusions file).
4. How argocd-agent participates (agent-bootstrap) — is each vcluster enrolled as a spoke?
5. What kro/ is for — is there a ResourceGraphDefinition making previews declarative?
6. Who/what calls provision.sh/runner.sh today — CI? sandbox-execution-api? a human?`, { label: 'explore:preview-vcluster', phase: 'Explore', schema: SCHEMA, agentType: 'Explore', effort: 'high' }),

  () => agent(`${CONTEXT}

YOUR AREA: The hexagonal (ports & adapters) architecture of workflow-builder and the microservice inventory, in /home/vpittamp/repos/PittampalliOrg/workflow-builder/main.

Read thoroughly:
- docs/hexagonal-architecture.md, docs/architecture.md (and any other docs/ that describe services or dev workflow, e.g. anything about local dev, CLAUDE.md at repo root)
- src/lib/server/application/ports.ts and the surrounding application/ + adapters/ directory trees — enumerate the ports and each port's adapters (real vs in-memory/fake if any)
- The full deployable inventory: find all Dockerfiles, package.json scripts, skaffold.yaml / docker-compose / dev scripts in the repo. What services exist (SvelteKit BFF, workflow-orchestrator, function-router, workers, anything Python)? Which are in this repo vs elsewhere?
- Test setup: how are adapters swapped in tests (vitest config, test doubles)? Is there a mode that runs the app with in-memory adapters (no Postgres/Dapr/NATS)?
- Config seams: how does the app choose adapters at runtime (env vars, DI container, factory)? Look for composition-root / container / bootstrap wiring.
- Recent 'strict workflow-data mode' and 'dev-first' work — search for workflow-data strict mode, readinessProbe mentions.

Answer specifically:
1. Catalog of ports and adapters (name, purpose, real impl, fake impl if any).
2. Which external dependencies (Postgres, Dapr sidecar, NATS, LLM APIs, sandbox-execution-api) are behind ports vs still hard-wired.
3. What the fastest existing 'run the app locally' path is (npm run dev? against what backends?) and what breaks without the cluster.
4. Build story per service: Dockerfile locations, build times if documented, whether Vite HMR / node --watch is exploitable in-cluster.`, { label: 'explore:hexagonal-wfb', phase: 'Explore', schema: SCHEMA, agentType: 'Explore', effort: 'high' }),

  () => agent(`${CONTEXT}

YOUR AREA: The current inner-loop and outer-loop iteration tooling in the stacks repo, and the agentic-workflow execution infrastructure.

Read thoroughly (under /home/vpittamp/repos/PittampalliOrg/stacks/main):
- Skaffold inner loop: search for skaffold.yaml / skaffold references, scripts/ryzen-sync.sh, scripts/benchmark-ryzen-hot-edit.sh, any docs describing the Skaffold no-commit scratch loop on ryzen
- Outer loop: scripts/gitops/trigger-tekton-builds.sh, render-workflow-builder-release-overlays.sh, release-pin files, how images flow GHCR→dev/staging vs ryzen active-development kustomization; look at docs/gitops-inner-outer-loop-visualization.md and docs/gitops-architecture-overview.md fully
- Agentic infra: packages/components/workloads/openshell-agent-runtime/ (what agent sessions look like, the script ConfigMap), anything about managed agents on dev, sandbox-execution-api relationship to agents, swebench runtime if it shows how agents get sandboxes
- Spegel P2P image mirror component (image pull speed), buildah cache PVCs (build speed)
- Any Kargo/promoter, hydrator, or promotion machinery relevant to how fast a change lands on a cluster

Answer specifically:
1. Today's fastest edit→running-pod path and its steps/latency (Skaffold on ryzen), and the slowest (Tekton build → pin bump → sync) — with documented or inferable timings.
2. How agent sessions run today (openshell-agent-runtime): where does the agent execute, what repo access does it have, can it build images or kubectl into a cluster?
3. What machinery exists for per-branch/per-PR environments beyond the preview vcluster, if any.
4. Where the latency actually is: image build, registry push/pull, ArgoCD sync interval, Dapr/sidecar restarts, DB migrations.`, { label: 'explore:iteration-loops', phase: 'Explore', schema: SCHEMA, agentType: 'Explore', effort: 'high' }),

  () => agent(`${CONTEXT}

YOUR AREA: Recent history and direction-of-travel. Use git log/show in BOTH repos (read-only).

In /home/vpittamp/repos/PittampalliOrg/stacks/main and /home/vpittamp/repos/PittampalliOrg/workflow-builder/main:
- git log --oneline --since='2026-05-15' (both repos) and identify every commit/PR touching: preview vcluster, dev environments, hexagonal/ports/adapters, strict workflow-data mode, sandbox-execution-api, openshell-agent-runtime, skaffold, agent sessions, kro
- For the most significant ~10 commits, git show --stat (and read key hunks) to understand what changed and why (PR numbers in subjects help)
- Look for in-flight/unfinished work: TODOs in the preview-vcluster README, feature branches (git branch -a | grep -i -E 'preview|vcluster|hex'), recent doc updates describing intended next steps

Answer specifically:
1. Timeline of how the preview-vcluster system was built up and what its authors said it is for (commit messages, PR titles).
2. Timeline of the hexagonal migration in workflow-builder — is it complete? What was the stated motivation?
3. Any explicitly stated next steps / roadmap items in either repo about dev environments, agent-driven development, or previews.
4. Anything recently REVERTED or abandoned in this space (so we don't re-propose it).`, { label: 'explore:recent-history', phase: 'Explore', schema: SCHEMA, agentType: 'Explore', effort: 'high' }),
])

const [preview, hexagonal, loops, history] = results
return { preview, hexagonal, loops, history }