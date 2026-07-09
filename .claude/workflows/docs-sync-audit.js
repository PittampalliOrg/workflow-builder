export const meta = {
  name: 'docs-sync-audit',
  description: 'Audit docs across workflow-builder, stacks, and nixos-config shared-skills for drift vs the current AP piece-runtime + agent-MCP system',
  phases: [
    { title: 'Audit', detail: '4 parallel auditors → per-file edit/delete/add plans' },
  ],
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['scope', 'files'],
  properties: {
    scope: { type: 'string' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'action', 'rationale'],
        properties: {
          path: { type: 'string' },
          action: { type: 'string', enum: ['edit', 'delete', 'keep', 'create'] },
          rationale: { type: 'string', description: 'why — cite the specific stale lines/claims or the missing coverage' },
          staleClaims: { type: 'array', items: { type: 'string' }, description: 'exact stale statements found (quote them) with what is now true' },
          proposedChange: { type: 'string', description: 'for edit/create: the concrete content/edits to make. for delete: confirm it is wholly superseded + by what.' },
          deleteRisk: { type: 'string', description: 'for delete only: anything still-useful that would be lost, or "fully superseded — safe"' },
        },
      },
    },
    crossCutting: { type: 'array', items: { type: 'string' }, description: 'global notes — recurring stale terms to grep-replace, naming, links to add' },
  },
}

const SYSTEM = `AUTHORITATIVE CURRENT STATE (as of 2026-06-10, after this session's work — detect docs that contradict or omit this). SSOT doc: workflow-builder/docs/activepieces-integration-architecture.md.

ACTIVEPIECES PIECE-RUNTIME (shipped + ryzen-verified):
- fn-activepieces is DELETED (service dir, image, release pins, skaffold module, Tekton trigger all removed). It was NEVER deployed; its ap_<piece>_<action> Dapr activities were app-scoped dead code. Any doc treating fn-activepieces as deployed/active/a-skaffold-module/the-_default-route is STALE.
- piece-mcp-server is promoted to the CONVERGED per-piece "piece-runtime": ONE image serving POST /execute (deterministic workflow activities), POST /mcp (StreamableHTTP MCP tools), POST /options (canvas dropdowns), GET /health. NOT one container and NOT 45 images — ONE image parameterized by PIECE_NAME env, run as ~47 per-piece Knative Services named ap-<sanitized-piece>-service (scale-to-zero; pinned ∪ workflow-referenced pieces at minScale=1).
- function-registry _default is now {"type":"activepieces"} — function-router computes ap-<piece>-service per piece. Reference-forwarding credentials: for AP routes the router NO LONGER fetches/forwards plaintext; it forwards X-Connection-External-Id and writes an audit-only credential_access_logs row (source=reference_forwarded); the piece-runtime self-resolves via the BFF decrypt endpoint; BFF stays sole decryptor. The CLAUDE.md "function-router is the credential broker" framing was REVISED to "credential audit point" for AP.
- Durability: piece_execution idempotency gate (workflowId:dbExecutionId:taskName), retryable/permanent error classification, AP_RETRY_POLICY in _handle_call_task, DELAY->create_timer + WEBHOOK->wait_for_external_event(ap.resume.<requestId>) pause mapping, >4MiB result offload to artifactRef, Postgres ctx.store.
- All-catalog reconciler (CronJob, every 2 min) provisions every catalog piece; NetworkPolicy piece-runtime-ingress restricts ingress to function-router/agent-namespaces/BFF.
- Deploy gotchas: NODE_OPTIONS=--max-old-space-size=400 + 512Mi limit (converged image OOMs at module load under 256/384Mi); custom_api_call / Property.DynamicProperties actions are NOT driveable (url excluded from generated inputSchema) — use typed actions.

AGENT MCP CONFIG (shipped + ryzen-verified):
- The flat agent-mcp-picker.svelte is DELETED; replaced by src/lib/components/agents/tools-integrations/ (AgentToolsIntegrations + per-server cards + grouped per-tool Allow/Disable + EffectiveToolSurfaceBar + AttachServerSheet + SystemServersNote), hub-consistent.
- Per-agent tool curation = agent_versions.config.mcpServers[].allowedTools (no schema change); two-level model: project mcp_connection.metadata.toolSelection (ceiling, set on Integrations piece detail) ∩ per-agent allowedTools (narrowing). INVARIANT: allowedTools absent = all-enabled, [] = all-disabled.
- The visible explicit/project/auto mode SELECT is replaced by an attach-list + "Include all workspace MCP servers" toggle (mcpConnectionMode derived: off->explicit, on->project; legacy auto still read).
- ?tools= URL allowlist (project ceiling ∩ per-agent allowedTools) enforced at the piece-mcp-server transport on BOTH resolvers (BFF mcp-resolution.ts + orchestrator resolve_mcp_config.py) — this was the load-bearing fix (durable/run previously had ZERO piece-tool enforcement).
- Browser-safe helpers live in src/lib/connections/piece-tools.ts (SvelteKit forbids importing $lib/server into .svelte; pnpm check MISSES this, only vite build catches it).
- Agent-level config is persisted+versioned; per-session ad-hoc override at LAUNCH via the session config drawer (POST agentConfig to /api/v1/sessions or /fork, doesn't mutate the agent); NO mid-session attach (the @-mention pattern is a documented future stretch). goal MCP is auto-wired into MCP-capable sessions (absent on the workflow-step path).

You are READ-ONLY. Produce a precise per-file plan (edit/delete/keep/create) with quoted stale claims + concrete proposed changes. For DELETE, prove the file is WHOLLY superseded and name the successor; be conservative — if a doc has any still-accurate operational value, mark edit not delete. Cite paths.`

phase('Audit')

const [wfb, stacks, skillsA, skillsB] = await parallel([
  () => agent(`${SYSTEM}

AUDIT: workflow-builder repo docs at /home/vpittamp/repos/PittampalliOrg/workflow-builder/main/docs/ (and CLAUDE.md — already partly updated this session; check it for remaining drift). Read EVERY doc. Flag drift vs the current state. Prime suspects:
- docs/activepieces-auth.md — describes the OLD fn-activepieces /options proxy, FN_ACTIVEPIECES_URL, the old credential-broker flow (router fetches plaintext). Needs heavy update or partial supersession by activepieces-integration-architecture.md. Decide edit vs delete (likely EDIT: the OAuth2/connection/encryption parts are still accurate; the fn-activepieces runtime parts are stale).
- docs/mcp-agent-workflows.md — agent MCP wiring; mcpConnectionMode project mode, ap-<piece>-service endpoints. Update for: Tools & Integrations UI, per-agent allowedTools + ?tools=, the attach-list/include-all model, per-session-at-launch vs no-mid-session, the converged piece-runtime serving /mcp.
- docs/services.md, docs/architecture.md, docs/deployment.md, docs/workflow-execution-architecture.md — any fn-activepieces service rows, the _default route, credential-broker framing, container/image counts.
- docs/cma-parity.md — the agent MCP/tools surface description (now Tools & Integrations).
- activepieces-integration-architecture.md is the SSOT (already current) — just confirm cross-links from other docs point to it.
Return the per-file plan. Note any doc with ZERO AP/MCP relevance as keep (don't churn unrelated swebench/goal-loop docs unless they reference deleted things).`,
    { label: 'audit:workflow-builder', phase: 'Audit', schema: PLAN_SCHEMA, agentType: 'Explore' }),

  () => agent(`${SYSTEM}

AUDIT: stacks repo docs at /home/vpittamp/repos/PittampalliOrg/stacks/main/docs/ (read every .md) PLUS scan for stale references in operational notes. Prime suspects:
- gitops-architecture-overview.md, outer-loop-promotion.md, gitops-inner-outer-loop-visualization.md — any fn-activepieces build/promotion rows, service lists, the function-registry routing. Update to: piece-mcp-server is the AP runtime (per-piece ap-<piece>-service Knative + reconciler), fn-activepieces retired, _default=activepieces, NODE_OPTIONS/512Mi piece-runtime requirement.
- dapr-workflows-and-agents-termination.md — does it reference AP execution / mcp servers / the durable/run path correctly?
- hub-spoke-app-placement.md, hub-and-spoke-quickstart.md — any AP service placement that's now per-piece-reconciler-driven.
- CLICKHOUSE_OBSERVABILITY.md / OTEL-STACK.md — piece-mcp-server OTEL identity (per-piece OTEL_SERVICE_NAME) if mentioned.
Also: grep the stacks docs for "fn-activepieces" and report every hit. Return the per-file plan; keep cluster/talos/tailscale/swebench docs untouched unless they name deleted things.`,
    { label: 'audit:stacks', phase: 'Audit', schema: PLAN_SCHEMA, agentType: 'Explore' }),

  () => agent(`${SYSTEM}

AUDIT: nixos-config shared-skills at /home/vpittamp/repos/vpittamp/nixos-config/main/shared-skills/ — focus on the workflow-system skills: workflow-builder/SKILL.md, gitops/SKILL.md, skaffold-dev-loop/SKILL.md. Read each fully + any supporting files in those skill dirs (references/, *.md). Flag drift vs the current state. Prime suspects:
- skaffold-dev-loop: fn-activepieces as a skaffold module / inactive module / SKAFFOLD_ALLOW_INACTIVE — fn-activepieces is DELETED; piece-mcp-server (piece-runtime) is reconciler-owned Knative, NOT a skaffold module. Update the module set + any fn-activepieces deploy examples.
- workflow-builder skill: AP piece actions, MCP servers, agent MCP config (now Tools & Integrations + per-agent allowedTools + ?tools=), function-router credential-broker framing, the durable/run + piece execution path, custom_api_call limitation, piece-runtime cold-start/NODE_OPTIONS.
- gitops skill: AP piece MCP services, fn-activepieces image/env rollout, the activepieces-mcps reconciler, release-pins for piece-mcp-server, function-router routing, the ryzen pin delivery for piece-runtime.
For each skill: list the exact stale lines + the corrected content. Skills are triggered by their description frontmatter — if the description mentions deleted things (fn-activepieces), update it. Return the per-file plan.`,
    { label: 'audit:skills-core', phase: 'Audit', schema: PLAN_SCHEMA, agentType: 'Explore' }),

  () => agent(`${SYSTEM}

AUDIT: the REMAINING nixos-config shared-skills at /home/vpittamp/repos/vpittamp/nixos-config/main/shared-skills/ — dapr-agents-workflow/SKILL.md, evaluations/SKILL.md, plus a quick scan of cluster-desired-state, ryzen-spoke-bootstrap, talos-clusters for any workflow-system drift. Read the relevant ones fully. Flag drift vs the current state. Prime suspects:
- dapr-agents-workflow: how agents get MCP tools (MCPClient + agentConfig.mcpServers), the actorStateStore rule, the converged piece-runtime as the MCP source, per-agent allowedTools, the ?tools= enforcement, agent vs ad-hoc session config. Confirm it doesn't describe a stale AP/MCP wiring.
- evaluations: any AP piece / MCP / fn-activepieces references in the benchmark/eval flow; agent MCP config for solver agents.
- The cluster/spoke/talos skills: only flag if they NAME fn-activepieces or describe the AP/MCP deploy in a now-stale way (likely minimal). 
Also grep all 8 shared-skills dirs for "fn-activepieces" and "agent-mcp-picker" and report every hit with file:line. Return the per-file plan.`,
    { label: 'audit:skills-rest', phase: 'Audit', schema: PLAN_SCHEMA, agentType: 'Explore' }),
])

return { workflow_builder: wfb, stacks: stacks, skills_core: skillsA, skills_rest: skillsB }