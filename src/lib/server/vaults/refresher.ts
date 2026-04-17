import { and, eq, lt, or, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	vaultCredentials,
	vaultCredentialRefreshLog,
} from "$lib/server/db/schema";
import {
	getRefreshMaterial,
	rotateCredential,
} from "./credentials";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

export type RefreshReport = {
	scanned: number;
	refreshed: number;
	failed: number;
	skipped: number;
};

/**
 * Find every mcp_oauth credential whose `expiresAt` is within the refresh
 * threshold and run the OAuth refresh_token grant against each one's token
 * endpoint. Updates `value` + `expiresAt` + `lastRefreshedAt` on success,
 * writes an entry to `vault_credential_refresh_log` either way.
 *
 * The scheduler calls this on a periodic cron (5 min default). Safe to run
 * concurrently — each credential's refresh is independent.
 */
export async function refreshExpiringCredentials(
	options: { leadTimeSeconds?: number } = {},
): Promise<RefreshReport> {
	const database = requireDb();
	const leadTime = options.leadTimeSeconds ?? 10 * 60;
	const threshold = new Date(Date.now() + leadTime * 1000);

	const candidates = await database
		.select({
			id: vaultCredentials.id,
			authType: vaultCredentials.authType,
			expiresAt: vaultCredentials.expiresAt,
			vaultId: vaultCredentials.vaultId,
		})
		.from(vaultCredentials)
		.where(
			and(
				eq(vaultCredentials.authType, "mcp_oauth"),
				eq(vaultCredentials.isArchived, false),
				or(
					isNull(vaultCredentials.expiresAt),
					lt(vaultCredentials.expiresAt, threshold),
				),
			),
		);

	const report: RefreshReport = {
		scanned: candidates.length,
		refreshed: 0,
		failed: 0,
		skipped: 0,
	};

	for (const candidate of candidates) {
		const material = await getRefreshMaterial(candidate.id);
		if (!material) {
			report.skipped++;
			continue;
		}
		const result = await runRefresh(material);
		if (result.ok) {
			await rotateCredential(candidate.vaultId, candidate.id, {
				accessToken: result.accessToken,
				refreshToken: result.refreshToken ?? undefined,
				expiresAt: result.expiresAt ?? undefined,
			});
			await database.insert(vaultCredentialRefreshLog).values({
				credentialId: candidate.id,
				status: "success",
				responseStatus: result.httpStatus,
			});
			report.refreshed++;
		} else {
			await database.insert(vaultCredentialRefreshLog).values({
				credentialId: candidate.id,
				status: "failure",
				errorMessage: result.error,
				responseStatus: result.httpStatus,
			});
			report.failed++;
		}
	}

	return report;
}

type RefreshSuccess = {
	ok: true;
	accessToken: string;
	refreshToken: string | null;
	expiresAt: string | null;
	httpStatus: number;
};

type RefreshFailure = {
	ok: false;
	error: string;
	httpStatus: number | null;
};

type RefreshOutcome = RefreshSuccess | RefreshFailure;

async function runRefresh(material: {
	id: string;
	refreshToken: string;
	metadata: {
		tokenEndpoint: string;
		clientId: string;
		tokenEndpointAuth:
			| { type: "none" }
			| { type: "client_secret_basic"; client_secret: string }
			| { type: "client_secret_post"; client_secret: string };
		scope?: string;
	};
}): Promise<RefreshOutcome> {
	const form = new URLSearchParams();
	form.set("grant_type", "refresh_token");
	form.set("refresh_token", material.refreshToken);
	form.set("client_id", material.metadata.clientId);
	if (material.metadata.scope) form.set("scope", material.metadata.scope);

	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};

	const auth = material.metadata.tokenEndpointAuth;
	if (auth.type === "client_secret_basic") {
		const creds = `${material.metadata.clientId}:${auth.client_secret}`;
		headers.Authorization = `Basic ${Buffer.from(creds).toString("base64")}`;
	} else if (auth.type === "client_secret_post") {
		form.set("client_secret", auth.client_secret);
	}

	try {
		const res = await fetch(material.metadata.tokenEndpoint, {
			method: "POST",
			headers,
			body: form.toString(),
		});
		const text = await res.text();
		if (!res.ok) {
			return { ok: false, error: text.slice(0, 500), httpStatus: res.status };
		}
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch {
			return {
				ok: false,
				error: `non-JSON response: ${text.slice(0, 200)}`,
				httpStatus: res.status,
			};
		}
		const accessToken = parsed.access_token;
		if (typeof accessToken !== "string") {
			return {
				ok: false,
				error: "response missing access_token",
				httpStatus: res.status,
			};
		}
		const expiresIn =
			typeof parsed.expires_in === "number" ? parsed.expires_in : null;
		const expiresAt = expiresIn
			? new Date(Date.now() + expiresIn * 1000).toISOString()
			: null;
		const refreshToken =
			typeof parsed.refresh_token === "string"
				? (parsed.refresh_token as string)
				: null;
		return {
			ok: true,
			accessToken,
			refreshToken,
			expiresAt,
			httpStatus: res.status,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			httpStatus: null,
		};
	}
}
