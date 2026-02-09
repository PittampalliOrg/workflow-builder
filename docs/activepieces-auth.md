# Activepieces-Style Auth And Connections (workflow-builder)

This document describes how workflow-builder reproduces Activepieces-style authentication for `piece_metadata` providers/actions via user-owned `app_connection` records, including OAuth2 (authorization code and client credentials), token refresh, and runtime decryption.

## Concepts

- `piece_metadata`: Cached piece definitions (including `auth` schemas) synced from Activepieces.
- `app_connection`: A user-owned connection record. The `value` is stored encrypted and contains credentials/tokens in an Activepieces-compatible shape.
- `externalId`: Stable identifier used by workflows and runtime to reference a connection. In workflow config, it appears as `{{connections['externalId']}}`.

## Data Model

Tables:

- `piece_metadata`
  - `name`, `version`, `platform_id`
  - `auth` (JSONB): piece auth schema. Can be `null`, an object, or an array of auth objects (multi-auth).
- `app_connection`
  - `owner_id` (FK to `users`, `ON DELETE CASCADE`)
  - `external_id` (unique per owner)
  - `piece_name`, `piece_version`
  - `type` (e.g. `OAUTH2`)
  - `value` (JSONB encrypted-at-rest via `EncryptedObject`)

Migrations:

- `drizzle/0009_shallow_multiple_man.sql` enforces constraints and performs backfills/dedupes prior to adding unique indexes.

## Encryption

Connection credentials are encrypted using AES-256-CBC (format aligned to Activepieces):

- Encrypted value type: `{ iv: string, data: string }`
- Env var: `INTEGRATION_ENCRYPTION_KEY` (preferred) or `AP_ENCRYPTION_KEY` (accepted alias)
  - 64-char hex key: `openssl rand -hex 32`
  - 32-char string: treated as binary for upstream compatibility

Implementation: `lib/security/encryption.ts`

## Supported Auth Types (From piece_metadata.auth)

The UI and APIs support these piece auth schemas:

- `SECRET_TEXT`
- `BASIC_AUTH`
- `CUSTOM_AUTH` (arbitrary typed props)
- `OAUTH2`
- `NONE`

Parsing:

- `parsePieceAuthAll(raw)` handles `auth` as either an object or an array and returns all supported configs.
- `parsePieceAuth(raw)` returns the first config for backward compatibility.

Implementation: `lib/types/piece-auth.ts`

## OAuth2 Flows

### Authorization Code (browser redirect + popup)

1. UI collects `client_id`, `client_secret`, and any OAuth2 `props` fields defined in piece metadata.
2. UI calls `POST /api/app-connections/oauth2/start` to generate:
   - authorization URL
   - `state`
   - PKCE verifier/challenge (when enabled by piece metadata; default on unless `pkce: false`)
3. UI opens a popup to the provider’s authorization URL.
4. Provider redirects to `GET /api/app-connections/oauth2/callback?code=...&state=...`.
5. Callback returns HTML that delivers `{ code, state }` to the opener window via:
   - `window.opener.postMessage(...)` (primary)
   - `localStorage.setItem("oauth2_callback_result:<state>", ...)` (fallback for COOP issues)
6. UI validates that returned `state` matches the stored `state`.
7. UI upserts the connection via `POST /api/app-connections` with a value containing:
   - the authorization `code`
   - PKCE `code_verifier`
   - resolved scope
   - client credentials
8. Server exchanges the code at the piece’s `tokenUrl` and stores the claimed tokens encrypted.

Endpoints:

- `app/api/app-connections/oauth2/start/route.ts`
- `app/api/app-connections/oauth2/callback/route.ts`
- `app/api/app-connections/route.ts` (token exchange on upsert)

### Client Credentials (no browser redirect)

If the piece declares client credentials (or supports both), the UI can create a connection without a popup:

1. UI calls `POST /api/app-connections` with `grant_type=client_credentials` and required fields.
2. Server claims a token at the piece’s `tokenUrl` using the client credentials flow.

Implementation:

- `app/api/app-connections/route.ts`
- `lib/app-connections/oauth2.ts` (exchange)

## OAuth2 Refresh Semantics

Refresh behavior is handled at runtime when a connection is used:

- Authorization code:
  - If `refresh_token` exists and token is within a 15 minute expiry buffer, refresh using `grant_type=refresh_token`.
  - If there is no `refresh_token`, treat the token as non-expiring for workflow-builder purposes (no refresh attempt).
- Client credentials:
  - Re-claim tokens using `grant_type=client_credentials` (includes scope and primitive `props`).

Implementation:

- `lib/app-connections/oauth2-refresh.ts`
- `lib/app-connections/resolve-connection-value.ts`

## Runtime Decryption And Token Refresh

There are two primary call paths for “get me credentials for this externalId”:

- Internal runtime (function-router / executor):
  - `GET /api/internal/connections/[externalId]/decrypt`
  - Secured by `X-Internal-Token` header matching `INTERNAL_API_TOKEN`
  - Returns decrypted connection `value`
  - If OAuth2 and expired, refreshes and persists the refreshed encrypted value
- UI runtime (dropdown options proxy):
  - `POST /api/pieces/options`
  - Session-authenticated
  - Looks up connection by `externalId` scoped to the current `owner_id`
  - Decrypts and refreshes (if needed) before proxying to `fn-activepieces /options`

Security note:

- The `pieces/options` path is explicitly owner-scoped to prevent cross-user credential access.

## Environment Variables

Required in most deployments:

- `DATABASE_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `INTEGRATION_ENCRYPTION_KEY` (or `AP_ENCRYPTION_KEY`)

Activepieces integration (depending on deployment):

- `FN_ACTIVEPIECES_URL` (where to proxy dynamic dropdown `options` requests)
- `INTERNAL_API_TOKEN` (required for internal decrypt endpoint)

## Operational Notes

- `pnpm analyze:activepieces-auth` inspects `piece_metadata.auth` coverage. It requires a reachable Postgres (`DATABASE_URL`).
- `pnpm check` may fail on NixOS if Biome is installed via a dynamically linked binary by `ultracite` (use Nix-packaged tooling or run checks in CI).

