# MCP Connections Plan And Work Log

## Objective
Implement a safe dual-track model:
- Keep **Activepieces app connections + Knative serverless execution** for workflows.
- Add **project-scoped MCP connections** for MCP Chat/agents/runtime-managed MCP servers.

## Plan
1. Add persistent DB model for MCP connections.
2. Add backend APIs for listing, catalog discovery, enable/disable, sync, and delete.
3. Add runtime abstraction (Nimble-first with legacy fallback).
4. Add UI in Settings and Connections for MCP connection management.
5. Update MCP Chat server manager to consume managed MCP connections.
6. Preserve workflow execution path and decouple legacy auto-provision side effects.

## Implemented Work
### Database and migration
- Added `mcp_connection` table in `lib/db/schema.ts`.
- Added migration `atlas/migrations/20260219143000_add_mcp_connections.sql`.
- Updated `atlas/migrations/atlas.sum`.

### Backend APIs
- Added new API routes under `app/api/mcp-connections/`:
  - `GET/POST /api/mcp-connections`
  - `GET /api/mcp-connections/catalog`
  - `POST /api/mcp-connections/[id]/status`
  - `POST /api/mcp-connections/[id]/sync`
  - `DELETE /api/mcp-connections/[id]`
- Added MCP connection DB service: `lib/db/mcp-connections.ts`.
- Added catalog resolver: `lib/mcp-connections/catalog.ts`.
- Added DTO serializer: `lib/mcp-connections/serialize.ts`.

### Runtime integration
- Added runtime abstraction under `lib/mcp-runtime/`:
  - `service.ts` (Nimble-first orchestration)
  - `nimble-client.ts`
  - `legacy-client.ts`
  - `types.ts`

### MCP Chat integration
- Refactored MCP Chat server routes:
  - `app/api/mcp-chat/servers/discover/route.ts`
  - `app/api/mcp-chat/servers/status/route.ts`
  - `app/api/mcp-chat/servers/provision/route.ts`
  - `app/api/mcp-chat/servers/test/route.ts`
- Updated MCP Chat state model and manager:
  - `lib/mcp-chat/mcp-servers-store.ts`
  - `components/mcp-chat/server-manager.tsx`
  - `app/mcp-chat/page.tsx`

### UI changes
- Added settings page: `app/settings/mcp-connections/page.tsx`.
- Added settings subnav item: `components/settings/settings-subnav.tsx`.
- Added MCP connections panel: `components/connections/mcp-connections-panel.tsx`.
- Added Connections tab split for App vs MCP: `app/connections/page.tsx`.

### Client API/types
- Added MCP connection client in `lib/api-client.ts` (`api.mcpConnection.*`).
- Added types in `lib/types/mcp-connection.ts`.

### Safety guardrails
- Legacy app-connection-triggered MCP provisioning/cleanup made opt-in only:
  - `MCP_AUTO_PROVISION_ON_CONNECTION_CREATE=true`
  - `MCP_AUTO_CLEANUP_ON_CONNECTION_DELETE=true`
- Files:
  - `app/api/app-connections/route.ts`
  - `app/api/app-connections/[connectionId]/route.ts`

## Validation
- Ran `pnpm fix`.
- Ran `pnpm type-check`.
- Both completed successfully at implementation time.

## Post-Recreation Incident (2026-02-19)
- Symptom: authenticated MCP endpoints returned HTTP 500:
  - `GET /api/mcp-connections`
  - `GET /api/mcp-connections/catalog`
  - `GET /api/mcp-chat/servers/discover`
- Root cause: database schema drift after cluster recreation.
  - Application code expected `public.mcp_connection`.
  - Runtime DB did not have `mcp_connection` yet.
  - This was a migration reconciliation gap in cluster state, not a devspace startup issue.

## Declarative Remediation Path
- Reconcile workflow-builder DB migrations from `stacks/main`:
  - `source deployment/scripts/cluster-menu.sh`
  - `cluster-reconcile-workflow-builder-db` (alias: `clwdb`)
- Full DB reconciliation path remains available:
  - `cluster-reconcile-databases` (alias: `cldb`)

## Runtime Verification Checklist
- Confirm schema object exists:
  - `kubectl exec -n workflow-builder postgresql-0 -- psql -U postgres -d workflow_builder -c "\dt public.mcp_connection"`
- Confirm endpoint recovery (authenticated):
  - `GET /api/mcp-connections` returns `200`
  - `GET /api/mcp-connections/catalog` returns `200`
  - `GET /api/mcp-chat/servers/discover` returns `200`

## Notes
- Workflow execution remains on existing serverless function path.
- MCP connections are now first-class and project-scoped for MCP consumers.

## UI Error Recovery (2026-02-19)
- Symptom in Settings > MCP Connections:
  - `GitHub` and `Google Calendar` showed `Error` despite runtime pods being healthy.
- Immediate runtime state fix:
  - Updated `mcp_connection` rows for `github` and `google-calendar` to `ENABLED`.
  - Cleared `last_error` once service health checks were verified (`/health` 200).

## Durable Sync Fixes
- Updated sync endpoint to use provisioning-aware runtime ensure path:
  - `app/api/mcp-connections/[id]/sync/route.ts`
  - Nimble piece sync now uses `ensurePieceServer(...)` (with active connection hint),
    not discover-only checks.
- Updated runtime discovery fallback behavior:
  - `lib/mcp-runtime/service.ts`
  - If nimble runtime exists but is unhealthy, discovery now checks legacy runtime and
    prefers any healthy provider before returning an unhealthy server.

## Image Publish / Rollout
- Published workflow-builder image:
  - `gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:latest`
  - `gitea.cnoe.localtest.me:8443/giteaadmin/workflow-builder:dev-20260219-2030`
  - Digest: `sha256:8dc5bfb0195cfb34f20c62fad875dbddc904f3cea1c14341fc98c7d7c049ac1c`
- Rolled `workflow-builder` deployment and verified new pod is running that digest.
