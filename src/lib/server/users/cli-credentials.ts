/**
 * Per-user CLI subscription-token storage for `interactive-cli` runtimes.
 *
 * Tokens (e.g. the `sk-ant-oat…` Claude Code OAuth token from
 * `claude setup-token`) are AES-256-CBC encrypted at rest in
 * `user_cli_credentials` (one row per user+provider) and only ever
 * decrypted server-side:
 *   - at spawn time (sessions/spawn.ts) to build `sessionSecretEnv` for the
 *     per-session sandbox pod, and
 *   - never in any API response — the token routes return presence/expiry
 *     metadata only.
 */
import { and, eq, sql } from "drizzle-orm";
import { posix as pathPosix } from "node:path";
import { gunzipSync } from "node:zlib";
import { db } from "$lib/server/db";
import { userCliCredentials } from "$lib/server/db/schema";
import { cliAuthForProvider } from "$lib/server/agents/runtime-registry";
import {
	decryptString,
	encryptString,
} from "$lib/server/security/encryption";
import {
	hostCredStoreEnabled,
	getHostProviderCred,
	captureHostProviderCred,
	hostLeaseAcquire,
	hostLeaseRelease,
} from "$lib/server/users/host-cred-store";

export type CliTokenErrorCode = "CLI_TOKEN_MISSING" | "CLI_TOKEN_EXPIRED";

/**
 * Typed spawn-gate error: thrown by the interactive-terminal spawn path when
 * the session owner has no usable subscription token for the runtime's
 * provider. API handlers map this to HTTP 412 with
 * `{ code, provider, settingsPath: "/settings/cli-tokens" }`.
 */
export class CliTokenError extends Error {
	readonly code: CliTokenErrorCode;
	readonly provider: string;

	constructor(code: CliTokenErrorCode, provider: string, message: string) {
		super(message);
		this.name = "CliTokenError";
		this.code = code;
		this.provider = provider;
	}
}

export type CliCredential = {
	token: string;
	expiresAt: Date | null;
	status: string;
};

export type CliCredentialSummary = {
	provider: string;
	linked: boolean;
	expiresAt: string | null;
	lastValidatedAt: string | null;
	status: string | null;
};

/** Default token lifetime when the caller doesn't supply an expiry — Claude
 * Code subscription OAuth tokens are minted for ~1 year; 363 days leaves a
 * safety margin so we steer re-enrollment before the provider hard-expires. */
const DEFAULT_TTL_DAYS = 363;
const FILE_BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
const FILE_BUNDLE_TAR_MAX_BYTES = 32 * 1024 * 1024;
const AGY_LOGIN_TOKEN_PATH = "antigravity-cli/antigravity-oauth-token";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

function readTarString(buf: Buffer, offset: number, length: number): string {
	const slice = buf.subarray(offset, offset + length);
	const nul = slice.indexOf(0);
	return slice.subarray(0, nul >= 0 ? nul : undefined).toString("utf8").trim();
}

function tarGzHasRegularFile(buf: Buffer, requiredPath: string): boolean {
	let archive: Buffer;
	try {
		archive = gunzipSync(buf, { maxOutputLength: FILE_BUNDLE_TAR_MAX_BYTES });
	} catch {
		throw new Error("Credential bundle must be a valid tar.gz archive.");
	}
	if (archive.length > FILE_BUNDLE_TAR_MAX_BYTES) {
		throw new Error("Credential bundle tar archive is too large.");
	}

	for (let offset = 0; offset + 512 <= archive.length; ) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) return false;

		const name = readTarString(header, 0, 100);
		const prefix = readTarString(header, 345, 155);
		const rawPath = prefix ? `${prefix}/${name}` : name;
		const normalizedPath = pathPosix.normalize(rawPath);
		const typeflag = readTarString(header, 156, 1);
		const sizeText = readTarString(header, 124, 12);
		const size = Number.parseInt(sizeText || "0", 8);
		if (!Number.isFinite(size) || size < 0) {
			throw new Error("Credential bundle contains an invalid tar entry.");
		}

		if (
			(typeflag === "" || typeflag === "0") &&
			normalizedPath === requiredPath &&
			size > 0
		) {
			return true;
		}

		offset += 512 + Math.ceil(size / 512) * 512;
	}

	return false;
}

/**
 * Format guard, generalized over the provider's `cliAuth.credentialKind`:
 *   - env_token (Claude): an opaque OAuth token. Rejects Anthropic API keys
 *     (`sk-ant-api…` would bill the metered API instead of the subscription)
 *     and anything with whitespace / too short.
 *   - file (Codex): the ChatGPT `auth.json` blob. Must parse as JSON and carry
 *     a `tokens` object (the OAuth login) — an API-key-only file
 *     (`auth_mode: "apikey"` / a bare `OPENAI_API_KEY`) is rejected because it
 *     bypasses the user's ChatGPT subscription.
 *   - device_login (Antigravity): nothing is stored — the user authenticates in
 *     the terminal. A PUT is rejected.
 */
export function assertPlausibleCliCredential(
	provider: string,
	token: string,
): void {
	const trimmed = token.trim();
	if (!trimmed) throw new Error("A credential value is required");
	const kind = cliAuthForProvider(provider)?.credentialKind ?? "env_token";

	if (kind === "device_login") {
		throw new Error(
			"This runtime authenticates in the terminal (device-code OAuth). " +
				"There is no token to store — just start a session and complete the login there.",
		);
	}

	if (kind === "file") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(
				"Expected the contents of your auth.json (valid JSON). Run the login command locally, " +
					"then paste the whole ~/.codex/auth.json file.",
			);
		}
		const obj = (parsed ?? {}) as Record<string, unknown>;
		const authMode = typeof obj.auth_mode === "string" ? obj.auth_mode : null;
		const hasTokens = obj.tokens && typeof obj.tokens === "object";
		if (authMode === "apikey" || (!hasTokens && obj.OPENAI_API_KEY)) {
			throw new Error(
				"This auth.json is an API-key login, not a ChatGPT subscription login. " +
					"Run `codex login` (browser ChatGPT OAuth) and paste the resulting auth.json so usage " +
					"stays on your subscription.",
			);
		}
		if (!hasTokens) {
			throw new Error(
				"auth.json is missing the OAuth `tokens` block — re-run `codex login` and paste the fresh file.",
			);
		}
		return;
	}

	if (kind === "file_bundle") {
		// A base64 tar.gz of the CLI's login dir (agy ~/.gemini), auto-captured by
		// the runtime. Validate it decodes to a gzip stream, isn't oversized, and
		// for AGY includes the Antigravity OAuth token rather than a legacy Gemini
		// CLI-only login file.
		let buf: Buffer;
		try {
			buf = Buffer.from(trimmed, "base64");
		} catch {
			throw new Error("Credential bundle must be base64-encoded.");
		}
		if (buf.length < 32) {
			throw new Error("Credential bundle is too small to be a valid login archive.");
		}
		if (buf[0] !== 0x1f || buf[1] !== 0x8b) {
			throw new Error("Credential bundle must be a gzip (tar.gz) archive.");
		}
		if (buf.length > FILE_BUNDLE_MAX_BYTES) {
			throw new Error("Credential bundle is too large (>8 MiB).");
		}
		if (
			provider === "google" &&
			!tarGzHasRegularFile(buf, AGY_LOGIN_TOKEN_PATH)
		) {
			throw new Error(
				"AGY credential bundle is missing the Antigravity OAuth token. " +
					"Start a fresh AGY session and complete the Antigravity login flow.",
			);
		}
		return;
	}

	// env_token
	if (trimmed.startsWith("sk-ant-api")) {
		throw new Error(
			"This looks like an Anthropic API key (sk-ant-api…). API keys are not accepted here — " +
				"they would break subscription auth and bill the metered API instead. Run `claude setup-token` " +
				"locally and paste the sk-ant-oat… subscription OAuth token.",
		);
	}
	if (/\s/.test(trimmed)) {
		throw new Error("Token must not contain whitespace");
	}
	if (trimmed.length < 20) {
		throw new Error("Token looks too short to be a CLI OAuth token");
	}
}

/** Decrypted read for the spawn path. Returns null when no row exists. */
export async function getUserCliCredential(
	userId: string,
	provider: string,
): Promise<CliCredential | null> {
	// Single-store: in a preview, single-use-refresh providers (codex/openai)
	// resolve against the ONE host store instead of a (diverging) local copy, so
	// host + previews share one token lineage. No-op on the host (env unset).
	if (cliCredentialNeedsBootLease(provider) && hostCredStoreEnabled()) {
		const hc = await getHostProviderCred(provider);
		return hc
			? { token: hc.token, expiresAt: hc.expiresAt, status: "active" }
			: null;
	}
	const database = requireDb();
	const [row] = await database
		.select({
			value: userCliCredentials.value,
			expiresAt: userCliCredentials.expiresAt,
			status: userCliCredentials.status,
		})
		.from(userCliCredentials)
		.where(
			and(
				eq(userCliCredentials.userId, userId),
				eq(userCliCredentials.provider, provider),
			),
		)
		.limit(1);
	if (!row) return null;
	return {
		token: decryptString(row.value),
		expiresAt: row.expiresAt ?? null,
		status: row.status,
	};
}

// ---------------------------------------------------------------------------
// Boot-serialization lease for single-use-refresh CLI credentials
// ---------------------------------------------------------------------------
// codex (provider "openai") authenticates via a ChatGPT OAuth auth.json whose
// REFRESH TOKEN IS SINGLE-USE — codex rotates it on every boot-refresh. Two
// concurrent codex pods that both seed the SAME token both refresh it; the loser
// gets "refresh token already used" and the turn stalls. We serialize per-(user,
// provider) codex boots with a DB lease held across the spawn→capture gap: a
// session claims it at spawn (so it resolves the freshest token) and the capture
// route releases it once codex's rotated token is persisted, so the next
// concurrent boot seeds the fresh token. Stale leases (crashed/never-captured
// sessions, or sessions whose codex didn't need to refresh) are stolen after a
// TTL. Acquire is BEST-EFFORT: on timeout the caller proceeds anyway, so a lease
// bug can only add latency, never hard-block a spawn.
const SINGLE_USE_REFRESH_PROVIDERS = new Set(["openai"]);
const LEASE_STALE_MS = 75_000;
const LEASE_ACQUIRE_TIMEOUT_MS = 75_000;
const LEASE_POLL_MS = 1_500;

/** True for providers whose refresh token is single-use (need boot serialization). */
export function cliCredentialNeedsBootLease(provider: string): boolean {
	return SINGLE_USE_REFRESH_PROVIDERS.has(provider);
}

function leaseRows(result: unknown): Array<{ holder_session_id?: string }> {
	if (Array.isArray(result)) return result as Array<{ holder_session_id?: string }>;
	const rows = (result as { rows?: unknown })?.rows;
	return Array.isArray(rows) ? (rows as Array<{ holder_session_id?: string }>) : [];
}

/**
 * Claim the per-(user,provider) boot lease for `sessionId`, waiting (best-effort)
 * until a prior holder releases it or its lease goes stale. No-op + returns true
 * for providers that don't need serialization. Returns true if the lease is held
 * by this session on return; false if it timed out (caller proceeds regardless).
 */
export async function acquireCliBootLease(
	userId: string,
	provider: string,
	sessionId: string,
	opts?: { staleMs?: number; timeoutMs?: number },
): Promise<boolean> {
	if (!cliCredentialNeedsBootLease(provider) || !sessionId) return true;
	const staleSecs = (opts?.staleMs ?? LEASE_STALE_MS) / 1000;
	const deadline = Date.now() + (opts?.timeoutMs ?? LEASE_ACQUIRE_TIMEOUT_MS);
	// Single-store: serialize against the HOST lease row (keyed on the host cred's
	// owner) so host + every preview codex boot share ONE lease. No-op on the host.
	if (hostCredStoreEnabled()) {
		const owner = (await getHostProviderCred(provider))?.ownerUserId;
		if (!owner) return true;
		for (;;) {
			if (await hostLeaseAcquire(owner, provider, sessionId, staleSecs)) return true;
			if (Date.now() >= deadline) return false;
			await new Promise((r) => setTimeout(r, LEASE_POLL_MS));
		}
	}
	const database = requireDb();
	for (;;) {
		// Atomic claim-or-steal: insert; on conflict take over only if we already
		// hold it or the existing lease is stale. A live foreign holder → no row
		// returned (DO UPDATE WHERE false) → we don't have it yet.
		const result = await database.execute(sql`
			INSERT INTO cli_credential_locks (user_id, provider, holder_session_id, acquired_at)
			VALUES (${userId}, ${provider}, ${sessionId}, now())
			ON CONFLICT (user_id, provider) DO UPDATE
				SET holder_session_id = EXCLUDED.holder_session_id, acquired_at = now()
				WHERE cli_credential_locks.holder_session_id = ${sessionId}
				   OR cli_credential_locks.acquired_at < now() - make_interval(secs => ${staleSecs})
			RETURNING holder_session_id
		`);
		if (leaseRows(result)[0]?.holder_session_id === sessionId) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, LEASE_POLL_MS));
	}
}

/** Release the boot lease if held by `sessionId` (no-op otherwise). */
export async function releaseCliBootLease(
	userId: string,
	provider: string,
	sessionId: string,
): Promise<void> {
	if (!cliCredentialNeedsBootLease(provider) || !sessionId) return;
	if (hostCredStoreEnabled()) {
		const owner = (await getHostProviderCred(provider))?.ownerUserId;
		if (owner) await hostLeaseRelease(owner, provider, sessionId);
		return;
	}
	const database = requireDb();
	await database.execute(sql`
		DELETE FROM cli_credential_locks
		WHERE user_id = ${userId} AND provider = ${provider}
		  AND holder_session_id = ${sessionId}
	`);
}

/**
 * Create-or-replace the user's token for a provider. Applies the format
 * guard; defaults `expiresAt` to now + 363 days when not supplied.
 */
export async function upsertUserCliCredential(
	userId: string,
	provider: string,
	token: string,
	expiresAt?: Date | null,
): Promise<CliCredentialSummary> {
	assertPlausibleCliCredential(provider, token);
	// Single-store: a preview's codex token capture writes back to the ONE host
	// row (the operator's lineage), never a diverging local copy.
	if (cliCredentialNeedsBootLease(provider) && hostCredStoreEnabled()) {
		const owner = await captureHostProviderCred(provider, token);
		return {
			provider,
			linked: !!owner,
			expiresAt: (expiresAt ?? null)?.toISOString() ?? null,
			lastValidatedAt: null,
			status: "active",
		};
	}
	const database = requireDb();
	const now = new Date();
	const effectiveExpiresAt =
		expiresAt ?? new Date(now.getTime() + DEFAULT_TTL_DAYS * 86_400_000);
	const encrypted = encryptString(token.trim());
	await database
		.insert(userCliCredentials)
		.values({
			userId,
			provider,
			value: encrypted,
			expiresAt: effectiveExpiresAt,
			lastValidatedAt: null,
			status: "active",
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [userCliCredentials.userId, userCliCredentials.provider],
			set: {
				value: encrypted,
				expiresAt: effectiveExpiresAt,
				lastValidatedAt: null,
				status: "active",
				updatedAt: now,
			},
		});
	return {
		provider,
		linked: true,
		expiresAt: effectiveExpiresAt.toISOString(),
		lastValidatedAt: null,
		status: "active",
	};
}

/** Returns true when a row existed and was deleted. */
export async function deleteUserCliCredential(
	userId: string,
	provider: string,
): Promise<boolean> {
	const database = requireDb();
	const deleted = await database
		.delete(userCliCredentials)
		.where(
			and(
				eq(userCliCredentials.userId, userId),
				eq(userCliCredentials.provider, provider),
			),
		)
		.returning({ id: userCliCredentials.id });
	return deleted.length > 0;
}

/** Presence/expiry metadata only — never the token. Safe for API responses. */
export async function getUserCliCredentialSummary(
	userId: string,
	provider: string,
): Promise<CliCredentialSummary> {
	const database = requireDb();
	const [row] = await database
		.select({
			expiresAt: userCliCredentials.expiresAt,
			lastValidatedAt: userCliCredentials.lastValidatedAt,
			status: userCliCredentials.status,
		})
		.from(userCliCredentials)
		.where(
			and(
				eq(userCliCredentials.userId, userId),
				eq(userCliCredentials.provider, provider),
			),
		)
		.limit(1);
	if (!row) {
		return {
			provider,
			linked: false,
			expiresAt: null,
			lastValidatedAt: null,
			status: null,
		};
	}
	return {
		provider,
		linked: true,
		expiresAt: row.expiresAt?.toISOString() ?? null,
		lastValidatedAt: row.lastValidatedAt?.toISOString() ?? null,
		status: row.status,
	};
}
