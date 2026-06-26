# Agentic Deploy → Inspect Loop — research + direction

**Status:** RESEARCH / DESIGN. Surveys industry best practices + open-source projects for *agent-based sandbox development wired to fast deployment with deployment feedback and deployed-app inspection inside the agent loop (via a workflow)*, then maps them to our stack and recommends a phased architecture. Prompted by the goal of a workflow that edits the **workflow-builder app itself**, live on the ryzen cluster.

## Context / what we're trying to accomplish

We want a workflow-builder **workflow** where an agent:
1. clones an app (starting with workflow-builder itself),
2. makes a change in a sandbox,
3. **deploys it fast** to a live environment (ryzen),
4. gets **deployment feedback** (did it build / sync / become healthy?),
5. **inspects the deployed app** (navigate it, screenshot, assert on the rendered UI),
6. and **loops** — eventually GAN-style (plan scrutiny + independent evaluator gating).

**Hard constraint discovered while scoping this** (see also `docs/interactive-cli-sessions.md`, the skaffold skill): our agent sandbox pods are **unprivileged** — no `kubectl`, no cluster RBAC (the `agent-runtime` / `sandbox-execution-api` SAs can't patch Deployments, `pods/exec`, or ArgoCD apps), no Docker/BuildKit, no ghcr push. And ryzen runs the **prod** workflow-builder pod (image + nginx, ArgoCD-managed at sync-wave 60), **not** a vite/HMR dev pod. So "a workflow that runs `skaffold dev`" is not directly possible; the loop must be built from what a low-privilege in-cluster agent can do **plus a small, deliberately-scoped deploy capability**.

## The canonical loop (what the industry converges on)

Across coding agents (Devin, Cursor, OpenHands, GitHub Copilot coding agent), preview-environment platforms, and "self-healing CI/CD" writing, the same shape recurs — an **Observe → Analyze → Act** loop:

> **edit → deploy to an isolated environment → deployment feedback → inspect the running app → evaluate → iterate**

It decomposes into three reusable sub-patterns:

1. **Preview environment per change.** Every PR/change gets its own URL; feedback collapses from hours to minutes vs. shared staging. When a preview deploys, a webhook fires → a runner executes tests/assertions against the *preview URL* → status posts back. (Vercel previews + webhooks; Argo CD **ApplicationSet Pull Request generator** for per-PR `Application`s with `prune:true` auto-teardown; **vCluster** for a full virtual cluster per PR; **Kargo** for staged promotion/gating.)
2. **Inner-loop file-sync into a hot dev process.** For *seconds*-fast iteration you don't rebuild — you sync changed source into an already-running dev server (e.g. Vite HMR) over `kubectl exec`/tar. (Skaffold `sync`, Tilt `live_update`, DevSpace sync, Okteto "shift the inner loop to the cluster", Telepresence/mirrord traffic intercepts.) **This is exactly our skaffold setup**: `skaffold/workflow-builder.skaffold.yaml` syncs `src/**` into `/app` of a `vite dev` pod → HMR in ~2–5s.
3. **Browser-in-the-loop verification.** The agent opens the running app, captures a screenshot **and** the accessibility tree / DOM / console, asserts, and feeds the observation back into the next turn. This is now standard:
   - **OpenHands** runtime = a sandbox with bash + Jupyter + a **Playwright-controlled Chromium**; every browser action returns HTML + DOM + a11y tree + screenshot as an "observation" in the event stream. V1 splits **local agent + remote runtime** over REST/WebSocket (agent logic local/low-latency, tool execution isolated).
   - **Cursor cloud agents** (Feb 2026) give each agent a **full desktop + browser** ("computer use") to open the app, click, and *visually verify* changes; env setup + a verification command live in `.cursor/environment.json`.
   - **Devin** exposes an **interactive browser** in its session UI.
   - **Playwright MCP** is the portable primitive: `browser_navigate` / `browser_snapshot` (a11y-tree mode) / `browser_take_screenshot` (vision mode) — "open `https://preview-…/checkout`, screenshot the form, describe layout issues."

**Self-healing / agentic CI-CD** (Dagger blueprints, Nx Self-Healing CI, Datadog Bits, GitHub Copilot coding agent, "CA/CD") is the same loop with the *act* step routed back through a PR — observe pipeline/deploy outcome → analyze → propose a fix → re-run. The throughline: **deployment + the deployed app are first-class signals in the agent loop, not a terminal step.**

## Open-source / tooling landscape

### Agent sandboxes (the "edit + run code safely" substrate)
| Project | OSS? | Isolation | Cold start | Snapshot | Notes for us |
|---|---|---|---|---|---|
| **kubernetes-sigs/agent-sandbox** | ✅ | pod (+ gVisor opt.) | pod-sched | (PVC) | **What we already use.** Per-session Sandbox CRs. |
| **E2B** | ✅ (runtime) + SaaS | Firecracker | ~150ms | FS + process | Great SDKs; K8s-orchestrated underneath. |
| **Daytona** | ✅ | (micro-VM) | ~90ms | FS | Pivoted to agent infra; fastest provisioning. |
| **microsandbox** | ✅ | libkrun (own kernel) | <200ms | — | Self-hosted, hardware-isolated, you own ops. |
| **Modal Sandboxes** | SaaS | — | sub-sec | FS + memory | Tunnelling for external connections. |
| **Together / Fly Machines / Runloop / Sprites** | SaaS | micro-VM | sub-sec–2.7s | FS/memory | Together explicitly offers **live preview hosts**. |
| DIY | — | **gVisor / Kata / Firecracker** on K8s | — | — | You patch CVEs, image cache, per-sandbox netpol yourself. |

Trend: checkpoint/restore (FS + memory snapshot) is becoming table stakes — relevant to our JuiceFS-clone fork seeding and warm-pool work.

### Inner-loop "edit → live on cluster" tools
| Tool | Mechanism | Fit |
|---|---|---|
| **Skaffold** | build + `sync` (tar over `kubectl exec`) → HMR; ArgoCD pause/resume | **Our current host dev loop.** |
| **Tilt** | `live_update`, web UI, Starlark | richest live-update + UI |
| **DevSpace / Okteto** | file-sync into a swapped dev pod | "inner loop on the cluster" |
| **Telepresence / mirrord** | intercept cluster traffic → local/remote process | run the changed service against real deps |

### Preview-env / GitOps deploy
**Argo CD ApplicationSet PR generator** (per-PR `Application`, auto-teardown on close), **vCluster** (virtual cluster per PR), **Kargo** (promotion/gating), Crossplane (env-as-code). Managed: Uffizzi, Bunnyshell, Signadot, Release, Qovery, Shipyard.

### Browser-in-the-loop
**Playwright MCP** (snapshot + vision), **browser-use**, OpenHands' Playwright runtime, Cursor computer-use, Devin interactive browser, Shipyard's "Playwright MCP screenshots of your deployed app".

## Where we already are vs. the canonical loop

We have **most of the loop** already — the gap is the *deploy* edge.

| Loop stage | Our existing capability |
|---|---|
| edit in sandbox | ✅ `agent-sandbox` + JuiceFS `/sandbox/work`; **fork-from-node** to skip the build (`docs/workflow-resume-from-step.md`) |
| build/test/preview | ✅ deterministic `prebuild_ui` (build on local scratch) + serve static; cliWorkspace commands |
| **inspect deployed app** | ✅ **Playwright-MCP critic** (`docs/playwright-mcp-critic`…), `browser_video_sync` `.webm`, `browser/validate` screenshots, run-page Browser tab |
| evaluate / GAN | ✅ contract + independent critic + `read_verdict` aggregation (`docs/generator-critic-multi-agent.md`, `docs/goal-loop.md`) |
| **deployment feedback** | ✅-ish **GitOps inventory + deployment notifications** (toast/bell on live image-tag change) + Argo Events activity stream (`/admin/gitops/system`) |
| **deploy (the act)** | ❌ **the gap** — unprivileged agent can't deploy. Today only **git push → existing auto-promote** closes the *live* loop (~15–18 min, build-dominated); no fast inner-loop deploy from a workflow; no per-run preview env. |

So this is not a green-field build — it's **closing one edge** (agent-driven deploy) and wiring our existing deployment-feedback + browser-inspection signals back into the loop.

## Options for the deploy edge (the decision this unblocks)

| Option | How | Speed | New infra / privilege | Verdict |
|---|---|---|---|---|
| **A. GitOps push → auto-promote** | agent commits+pushes a change (branch/PR or main) → existing Tekton→GHCR→ArgoCD → poll live URL | ~15–18 min | **none** (just `GITHUB_TOKEN`, already ambient) | **P0 proof** — works today, zero privilege |
| **B. Per-run ephemeral preview env** | spin a per-run dev pod/namespace (vite HMR) seeded from the agent's workspace; agent inspects its own preview URL; teardown on run end | minutes | scoped deployer + a preview template (ApplicationSet-style) | **target architecture** (industry standard) |
| **C. Skaffold-style live sync** | a long-lived dev pod (vite HMR) on ryzen + agent `kubectl cp`s the edited file in → HMR | **seconds** | a **dev pod** + a *narrow* SA (`pods get/exec` in one ns) + `kubectl` in the deploy image | **fastest inner loop** |
| **D. Full `skaffold run` (privileged)** | deployer image (skaffold+kubectl+buildkit) + broad RBAC + ghcr push | ~outer-loop | heaviest + most security-sensitive | not recommended |

## Recommendation (phased)

**P0 — Prove the structure now (Option A).** A workflow: `clone_repo` → `edit` (agent makes one *visible* UI change, e.g. a wordmark/marker string) → `commit_push` (to a branch + PR, or a throwaway branch) → trigger/await auto-promote → `verify_live` (curl `https://workflow-builder-ryzen.tail286401.ts.net/` + grep the marker, or a Playwright-MCP visit). This proves clone→edit→deploy-live→inspect with **zero new privilege** and reuses the `pr-heavy-review` clone/push pattern + our deployment-notification inventory diff as the "deployed" signal. Slow, but it validates the whole loop shape.

**P1 — Fast inner loop (Option C, the skaffold-faithful version).** Stand up, behind a deliberate self-update opt-in:
- a **per-app dev pod** (the existing `skaffold/dev/workflow-builder` overlay — `vite dev`, `runAsUser:0`, ArgoCD paused for that app), and
- a **narrowly-scoped `wfb-deployer` ServiceAccount** (only `get/list pods` + `pods/exec` in the `workflow-builder` ns — *not* cluster-admin, no ArgoCD patch needed once the dev pod exists), and
- `kubectl` in the deploy step's image.

Then a workflow node does what Skaffold's `sync` does — `kubectl cp` the changed `src/**` into the dev pod's `/app` → Vite HMR → live in seconds → the Playwright-MCP critic navigates the **live preview URL** and asserts. This mirrors Skaffold sync + Cursor/OpenHands browser-in-loop, and keeps privilege minimal + auditable. (The run-page Browser tab already renders the critic's screenshots/`.webm`.)

**P2 — Per-run isolation (Option B) + GAN.** Promote P1 to a **preview-env-per-run** (own pod/namespace per run, ApplicationSet-style, torn down on run end — matching the industry "preview per change" isolation) and layer the GAN loop on top: **plan scrutiny** before edits + an **independent evaluator** gating on (a) deployment health/feedback and (b) browser assertions against the live preview, with our existing contract/critic/`read_verdict` machinery. This is the "more full GAN style workflow that evaluates the changes and scrutinizes the plan" the user described.

**Security stance.** A self-update workflow that mutates the running app is legitimately privileged — but scope it like a preview environment, not a CI bot: a dedicated SA with the *minimum* verbs in *one* namespace, opt-in per workflow, never granted to the general agent-runtime SA. Prefer acting on an isolated per-run target (P2) over the shared live deployment.

## Sources
- [Top AI Code Sandbox Products 2025 — Modal](https://modal.com/blog/top-code-agent-sandbox-products) · [AI Agent Sandboxes Compared — Ry Walker](https://rywalker.com/research/ai-agent-sandboxes) · [How to sandbox AI agents in 2026 (Firecracker/gVisor/runtimes)](https://manveerc.substack.com/p/ai-agent-sandboxing-guide) · [Daytona vs microsandbox](https://pixeljets.com/blog/ai-sandboxes-daytona-vs-microsandbox/)
- [OpenHands Runtime Architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime) · [OpenHands Agent SDK paper](https://arxiv.org/html/2511.03690v1)
- [Cursor cloud agent environments](https://cursor.com/blog/cloud-agent-development-environments) · [Cursor agents control their own computers](https://cursor.com/blog/agent-computer-use) · [Cursor background agent docs](https://docs.cursor.com/background-agent) · [Devin session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)
- [Playwright MCP](https://playwright.dev/docs/getting-started-mcp) · [Playwright MCP screenshots of your app — Shipyard](https://shipyard.build/blog/playwright-mcp-screenshots/)
- [Preview environments guide — Signadot](https://www.signadot.com/articles/comprehensive-guide-to-preview-environments/) · [Argo CD PR preview envs — Codefresh/Octopus](https://codefresh.io/blog/creating-temporary-preview-environments-based-pull-requests-argo-cd-codefresh/) · [Ephemeral PR envs w/ Crossplane+Argo+vCluster](https://2024.platformcon.com/talks/ephemeral-pull-request-environments-with-crossplane-argo-cd-and-vclusterpro)
- [Preview Environments: what teams get wrong — Autonoma](https://getautonoma.com/blog/preview-environments) · [AI agents in CI/CD: issue → prod — DeployHQ](https://www.deployhq.com/blog/ai-agents-cicd-pipelines-github-issue-to-production-deploy)
- [Building self-healing CI/CD for agentic AI — Optimum](https://optimumpartners.com/insight/how-to-architect-self-healing-ci/cd-for-agentic-ai/) · [From pipelines to agents: self-healing CI/CD — Microsoft](https://techcommunity.microsoft.com/blog/azureinfrastructureblog/from-pipelines-to-agents-self-healing-cicd-workflow/4519494) · [Skaffold alternatives (Tilt/DevSpace/Okteto/Telepresence) — Northflank](https://northflank.com/blog/skaffold-alternatives)
