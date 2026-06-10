# CMA Parity (Managed Agents Console)

This doc captures how each CMA (Claude Managed Agents — `platform.claude.com/dashboard`) surface maps onto our SvelteKit app, what diverges on purpose, and where to find the wiring.

## Principles

1. **Session-centric first.** Session detail is where CMA users spend most of their time, so the event stream + sidebar cards came first.
2. **Workspace scoping is the unifying invariant.** Every user-facing resource carries `project_id`; `hooks.server.ts` resolves scope from the `X-Workspace` header or URL slug into `locals.session.projectId`.
3. **Keep divergences visible.** Workflow editor, sandboxes, observability, workflow-ops stay alongside the CMA-shape surfaces — not hidden.
4. **Event taxonomy is locked.** `agent.{message,thinking,tool_use,mcp_tool_use,custom_tool_use,tool_result,mcp_tool_result,custom_tool_result,thread_context_compacted}` + `session.{status_*,error}` + `span.model_request_{start,end}`. No new types without a UI mapping.
5. **Archive semantics.** Sessions are disposable; agents, environments, vaults, skills are permanent — double-confirm archive on the persistent four.

## Surface map

| CMA page | Our route(s) | Notes |
|---|---|---|
| Sessions list | `/workspaces/[slug]/sessions` | Live filter + sort + agent filter; polls every 3s while any session is running |
| Session detail | `/workspaces/[slug]/sessions/[id]` | SSE event stream, thinking block rendering, deny-reason textarea, file-mount resources panel, human-readable stop reasons, fork-from-here button, reconnect consolidation. Sidebar has Agent / Environment / Vaults / Workflow run / Sandbox / Observability cards |
| Agents list | `/workspaces/[slug]/agents` | Template gallery on empty state; "used by N" drill-down |
| Agent detail | `/workspaces/[slug]/agents/[id]` | Full config (styleGuidelines, maxTurns, timeoutMinutes, cwd, toolChoice, memory backend, plugins); explicit publish-with-changelog flow |
| Agent detail → Tools & Integrations | `/workspaces/[slug]/agents/[id]` (card) | "MCPs and tools" parity (Claude Console). `src/lib/components/agents/tools-integrations/` (replaces the deleted `agent-mcp-picker`): attach-list + "Include all workspace MCP servers" toggle (`mcpConnectionMode` derived) + grouped per-tool `Allow / Disable`. Per-agent curation = `agent_versions.config.mcpServers[].allowedTools` (absent=all, []=none). Effective surface = project ceiling ∩ per-agent narrowing. Per-session override at launch via the session config drawer (doesn't mutate the agent); no mid-session attach. See `docs/activepieces-integration-architecture.md` §5 + `docs/mcp-agent-workflows.md` |
| Integrations hub | `/workspaces/[slug]/connections` | Catalog of Activepieces pieces (Perplexity connectors pattern): search + `All / Connected / Available` pills, capability chips `[Actions ✓][MCP ✓]`, connected-first section. Backed by `piece_metadata`. See `docs/activepieces-integration-architecture.md` §5.1 |
| Integration (piece) detail | `/workspaces/[slug]/connections/[pieceName]` | Per-piece detail subroute: Connect-account CTA (OAuth popup), searchable Actions/Tools list with per-tool `Allow / Disable` (project ceiling → `mcp_connection.metadata.toolSelection`), "available as workflow actions" / "exposed as MCP server" toggles, connection usage counts. See `docs/activepieces-integration-architecture.md` §5.2 |
| Environments | `/workspaces/[slug]/environments` | Template picker on list; detail supports sandboxTemplate + networking + runtime selection |
| Vaults | `/workspaces/[slug]/vaults` | Rotation UI for OAuth refresh tokens, expiration warnings on session detail |
| Files | `/files` | Standalone + session-scoped uploads; SHA-1 dedup; 25 MB cap |
| Skills | `/workspaces/[slug]/skills` | Curated registry (admin-imported) + user-authored custom skills (workspace-scoped, versioned) |
| Usage | `/usage` | Per-day stacked chart, per-agent breakdown, totals + tool-call count |
| Cost | `/workspaces/[slug]/cost` | Per-model and per-agent cost ranking, priceBook reference |
| Settings → API keys | `/settings/api-keys` | `wfb_`-prefixed JWT keys; rotate + revoke |
| Settings → Members | `/settings/members` | Real CRUD (was a stub pre-v3) |
| Settings → Limits | `/settings/limits` | Live workspace load (sessions + tokens/min + tokens/hour per model), auto-refresh 15s |
| Global nav | `src/lib/components/sidebar.svelte` | Workspace switcher chip, `/workspaces` management page, ⌘+K command palette |

## Intentional divergences

These have no CMA equivalent and stay:

- `/workflows/*` — visual DAG editor + SW 1.0 runtime
- `/sandboxes/*` — full OpenShell terminal + file browser + lifecycle
- `/observability/*` — ClickHouse-backed trace explorer (CMA shows only the session-scoped trace)
- `/workflow-ops/*` — Dapr instance inspection
- `/activities`, `/dapr-system` — operator surfaces

The parity work is additive, not substitutive.

## API reference (net-new since CMA parity began)

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/workspaces` | List caller's workspaces |
| `POST /api/v1/workspaces` | Create workspace (caller becomes ADMIN) |
| `PATCH /api/v1/workspaces/[id]` | Rename |
| `GET /api/v1/projects/[projectId]/members` | List members |
| `POST /api/v1/projects/[projectId]/members` | Add existing platform user by email |
| `PATCH /api/v1/projects/[projectId]/members/[memberId]` | Change role |
| `DELETE /api/v1/projects/[projectId]/members/[memberId]` | Remove |
| `POST /api/agent-skills` | Create custom skill (workspace-scoped) |
| `PATCH /api/agent-skills/[id]` | Update; prompt edit bumps version |
| `DELETE /api/agent-skills/[id]` | Delete custom skill |
| `POST /api/settings/api-keys/[keyId]/rotate` | Rotate API key secret in place |
| `POST /api/v1/sessions/[id]/fork` | Fork session at `fromSequence`, replay events into new row |
| `GET /api/v1/limits/live` | Active sessions + per-model rolling-window throughput |
| `GET /api/workflows/executions/[executionId]/sessions` | Sessions spawned by a workflow execution |
| `GET /api/observability/traces?sessionId=X` | Trace explorer filter by session id span attribute |
| `GET /api/observability/phoenix/sessions/[id]` | 302 redirect to Phoenix project session view |

## Workspace scoping pattern

Any list endpoint that aggregates resources MUST follow this shape so it mirrors the scoping already applied to sessions + vaults + agents + environments + skills:

```ts
const scopeFilter = locals.session.projectId
  ? eq(table.projectId, locals.session.projectId)
  : eq(table.userId, locals.session.userId); // fallback only when no active workspace
```

Reference implementations:
- `src/lib/server/sessions/registry.ts` (listSessions)
- `src/lib/server/vaults/registry.ts` (listVaults)
- `src/lib/server/agents/registry.ts` (listAgents)
- `src/lib/server/environments/registry.ts` (listEnvironments)
- `src/lib/server/agent-skills.ts` (listAgentSkills — merges curated global + workspace custom)
- `src/routes/api/v1/usage/+server.ts` (usage/cost aggregates)

## Testing

Smoke coverage of every CMA-parity endpoint's auth boundary lives at `tests/e2e/auth-boundary.spec.ts` (16 cases). Pure-logic unit tests for `bumpVersion`, `slugify`, and the skill search parser live in `src/lib/server/agent-skills.test.ts`. Run:

```bash
pnpm test:unit                                      # vitest, pure logic
pnpm test:e2e                                       # playwright, defaults to localhost:3000
BASE_URL=https://... pnpm test:e2e                  # override to hit a deployed env
```

Full user-facing E2E awaits a reliable auth fixture (API-key or seeded cookie).
