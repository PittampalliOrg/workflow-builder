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
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { userCliCredentials } from "$lib/server/db/schema";
import { cliAuthForProvider } from "$lib/server/agents/runtime-registry";
import {
	decryptString,
	encryptString,
} from "$lib/server/security/encryption";

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

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
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
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(
				"Expected a JSON bundle of your agy login files. Log in locally with `agy`, then run the " +
					"export command shown above and paste its whole output.",
			);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("The agy credential bundle must be a JSON object of { file: contents }.");
		}
		const bundle = parsed as Record<string, unknown>;
		const required = ["oauth_creds.json", "antigravity-cli/antigravity-oauth-token"];
		const missing = required.filter((k) => typeof bundle[k] !== "string" || !bundle[k]);
		if (missing.length) {
			throw new Error(
				`The agy bundle is missing ${missing.join(" + ")}. Sign in locally with \`agy\` first, ` +
					"then re-run the export so the bundle includes your ~/.gemini login files.",
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
