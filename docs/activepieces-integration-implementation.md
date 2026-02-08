# Activepieces Integration/Authentication Implementation

## Date
- February 6, 2026

## Objective
Adopt Activepieces-style integration/authentication management in workflow-builder so users can:
- create/manage reusable connections per integration,
- reference them in workflow nodes,
- preserve auth state in the UI,
- execute steps with stable connection identity,
- and ingest new upstream pieces over time.

## What Was Implemented

### 1. Data Model and Encryption
Added Activepieces-style tables and types:
- `piece_metadata` (cached piece definitions from Activepieces)
- `app_connection` (user-owned encrypted connection records)
- `workflow_connection_ref` (workflow→connection reference index)

Primary schema updates:
- `lib/db/schema.ts`
- `lib/db/index.ts`

Credential encryption/decryption utility:
- `lib/security/encryption.ts`

Connection and auth typing:
- `lib/types/app-connection.ts`

Drizzle migration generated:
- `drizzle/0007_far_penance.sql`
- `drizzle/meta/0007_snapshot.json`
- `drizzle/meta/_journal.json`

### 2. Backend Services
Added DB access/service layers:
- `lib/db/piece-metadata.ts`
- `lib/db/app-connections.ts`
- `lib/app-connections/oauth2.ts`

Key behavior:
- app connection values are stored encrypted in `app_connection.value`.
- sensitive values are removed from list responses.
- workflow integration validation now checks both legacy `integrationId` and AP-style auth templates (`{{connections['externalId']}}`).

### 3. API Surface
Added new API routes:
- `GET/POST /api/app-connections`
- `GET/POST/DELETE /api/app-connections/[connectionId]`
- `POST /api/app-connections/test`
- `POST /api/app-connections/[connectionId]/test`
- `POST /api/app-connections/oauth2/start`
- `GET /api/app-connections/oauth2/callback`
- `GET /api/pieces`
- `GET /api/pieces/[pieceName]`

Files:
- `app/api/app-connections/...`
- `app/api/pieces/...`

### 4. API Client and Compatibility Layer
The existing frontend integration flows were preserved using a compatibility adapter:
- `api.integration.*` now maps to `app_connection` APIs.
- legacy screens/components continue to work while backend uses Activepieces-style connections.

File:
- `lib/api-client.ts`

### 5. Workflow UI Connection State
Node configuration now keeps both:
- `integrationId` (legacy compatibility)
- `auth` template using connection external id: `{{connections['externalId']}}`

Updated files:
- `components/workflow/config/action-config.tsx`
- `components/workflow/node-config-panel.tsx`
- `components/overlays/configuration-overlay.tsx`
- `app/workflows/[workflowId]/page.tsx`

Additional behavior:
- when integrations are auto-fixed/auto-selected, `auth` is also updated.
- when integration is cleared/duplicated/public-sanitized, `auth` is removed where appropriate.

Related files:
- `app/api/workflows/[workflowId]/route.ts`
- `app/api/workflows/[workflowId]/duplicate/route.ts`

### 6. Execution Payload Support
Workflow executor now includes AP-style connection reference in execution payload:
- `connection_external_id` derived from `config.auth`
- retains `integration_id` fallback

File:
- `lib/workflow-executor.ts`

Supporting type update:
- `lib/workflow-definition.ts`

### 7. Upstream Piece Sync Workflow
Added a sync script to ingest upstream piece metadata from Activepieces API into local `piece_metadata`:
- `scripts/sync-activepieces-pieces.ts`
- package script: `pnpm sync:activepieces-pieces`

Supports:
- `--dry-run`
- `--limit=<n>`
- `--only=<comma-separated-piece-names>`
- `--base-url=<url>`
- `--api-key=<key>`

Example:
- `pnpm sync:activepieces-pieces --dry-run --limit=20`

## Authentication Migration Behavior
When anonymous accounts are linked to real users, app connections are reassigned:
- `appConnections.ownerId` migrated from anonymous user id to new user id.

File:
- `lib/auth.ts`

## Validation and Operations

### Checks
- `pnpm type-check`: passed.
- `pnpm db:generate`: passed.

### Database push
- Local host push failed due no local Postgres listener.
- Successfully run through Kubernetes pod:
  - namespace: `workflow-builder`
  - pod: `workflow-builder-devspace-66dfcb9f5d-wmtdg`
  - command: `cd /app && pnpm db:push`
  - result: changes applied

### Formatting/Lint
- `pnpm fix` currently fails in this local Nix environment because `npx ultracite@latest` downloads a dynamically linked Biome binary incompatible with this host setup.

## Hardening And Completeness Updates

### February 8, 2026
Additional work was completed to make the integration safer and closer to upstream Activepieces behavior:

- Fixed an authorization bug in dynamic property options (`POST /api/pieces/options`) to prevent cross-user connection access.
- OAuth2 improvements:
  - callback payload includes `state`
  - UI validates `state` before exchanging/claiming tokens
  - localStorage COOP fallback is keyed by `state` to avoid collisions
  - supports `client_credentials` grant
  - runtime refresh aligns with Activepieces-style semantics and persists refreshed tokens
- Multi-auth: `piece_metadata.auth` can be an object or an array; UI supports selecting among auth methods.
- Piece selection: list/latest selection prefers latest semver rather than `updatedAt` ordering.
- Database constraints:
  - `piece_metadata.platform_id` is `NOT NULL DEFAULT 'OFFICIAL'` and participates in uniqueness
  - `app_connection.owner_id` is `NOT NULL` with `ON DELETE CASCADE`
  - unique `(owner_id, external_id)`
  - migration `0009` includes backfills/dedupe prior to applying constraints
- Reduced secret exposure: app connection `GET` returns redacted data instead of decrypted values.

See `docs/activepieces-auth.md` for the current end-to-end auth flow and operational notes.

## Current Compatibility Strategy
The app now stores and understands Activepieces-style app connections while retaining compatibility with legacy integration usage in node config and execution paths. This allows incremental migration without breaking current UX.

## Next Recommended Enhancements
- Move runtime credential resolution to prefer `connection_external_id` end-to-end in router/executor services.
- Add persistent `workflow_connection_ref` synchronization on workflow save for faster integrity checks and usage analytics.
- Add background/cron sync for `piece_metadata` to track upstream updates continuously.
