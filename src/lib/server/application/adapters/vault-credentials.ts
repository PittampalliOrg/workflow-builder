import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	vaultCredentialRefreshLog,
	vaultCredentials,
	type VaultCredential,
} from "$lib/server/db/schema";
import {
	decryptObject,
	decryptString,
	encryptObject,
	encryptString,
	type EncryptedObject,
} from "$lib/server/security/encryption";
import type {
	ResolvedVaultCredential,
	VaultCredentialRefreshOutcome,
	VaultCredentialRefreshReport,
	VaultCredentialRepository,
} from "$lib/server/application/vault-credentials";
import type {
	VaultAuthType,
	VaultCredentialInput,
	VaultCredentialSummary,
	VaultOAuthRefreshMetadata,
} from "$lib/types/vaults";

export class PostgresVaultCredentialRepository
	implements VaultCredentialRepository
{
	async createCredential(
		vaultId: string,
		input: VaultCredentialInput,
	): Promise<VaultCredentialSummary> {
		const database = requireDb();
		const secretPayload = buildSecretPayload(input);
		const encryptedValue = encryptObject(secretPayload);
		const refreshMetadata =
			input.authType === "mcp_oauth" && input.refreshMetadata
				? encryptRefreshMetadata(input.refreshMetadata, input.refreshToken)
				: null;
		const [row] = await database
			.insert(vaultCredentials)
			.values({
				vaultId,
				displayName: input.displayName,
				authType: input.authType,
				value: encryptedValue,
				mcpServerUrl: input.mcpServerUrl ?? null,
				refreshMetadata,
				expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
			})
			.returning();
		return rowToSummary(row);
	}

	async listCredentials(vaultId: string): Promise<VaultCredentialSummary[]> {
		const database = requireDb();
		const rows = await database
			.select()
			.from(vaultCredentials)
			.where(
				and(
					eq(vaultCredentials.vaultId, vaultId),
					eq(vaultCredentials.isArchived, false),
				),
			)
			.orderBy(asc(vaultCredentials.displayName));
		return rows.map(rowToSummary);
	}

	async getCredential(
		vaultId: string,
		credentialId: string,
	): Promise<VaultCredentialSummary | null> {
		const database = requireDb();
		const [row] = await database
			.select()
			.from(vaultCredentials)
			.where(
				and(
					eq(vaultCredentials.vaultId, vaultId),
					eq(vaultCredentials.id, credentialId),
				),
			)
			.limit(1);
		return row ? rowToSummary(row) : null;
	}

	async rotateCredential(
		vaultId: string,
		credentialId: string,
		input: Partial<VaultCredentialInput>,
	): Promise<VaultCredentialSummary | null> {
		const database = requireDb();
		const [existing] = await database
			.select()
			.from(vaultCredentials)
			.where(
				and(
					eq(vaultCredentials.vaultId, vaultId),
					eq(vaultCredentials.id, credentialId),
				),
			)
			.limit(1);
		if (!existing) return null;

		const patch: Partial<VaultCredential> & { updatedAt: Date } = {
			updatedAt: new Date(),
		};
		if (input.displayName !== undefined) patch.displayName = input.displayName;
		if (input.mcpServerUrl !== undefined) {
			patch.mcpServerUrl = input.mcpServerUrl ?? null;
		}
		if (input.expiresAt !== undefined) {
			patch.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
		}
		if (input.accessToken || input.username || input.password || input.secret) {
			const merged: VaultCredentialInput = {
				displayName: existing.displayName,
				authType: existing.authType as VaultAuthType,
				...input,
			};
			patch.value = encryptObject(buildSecretPayload(merged));
			patch.lastRefreshedAt = new Date();
		}
		if (input.refreshMetadata !== undefined || input.refreshToken !== undefined) {
			const baseMetadata =
				input.refreshMetadata ??
				(existing.refreshMetadata as VaultOAuthRefreshMetadata | null) ??
				undefined;
			patch.refreshMetadata = baseMetadata
				? encryptRefreshMetadata(baseMetadata, input.refreshToken)
				: null;
		}
		const [row] = await database
			.update(vaultCredentials)
			.set(patch)
			.where(eq(vaultCredentials.id, credentialId))
			.returning();
		return row ? rowToSummary(row) : null;
	}

	async archiveCredential(
		vaultId: string,
		credentialId: string,
	): Promise<boolean> {
		const database = requireDb();
		const [row] = await database
			.update(vaultCredentials)
			.set({ isArchived: true, updatedAt: new Date() })
			.where(
				and(
					eq(vaultCredentials.vaultId, vaultId),
					eq(vaultCredentials.id, credentialId),
				),
			)
			.returning({ id: vaultCredentials.id });
		return Boolean(row);
	}

	async resolveCredential(
		credentialId: string,
	): Promise<ResolvedVaultCredential | null> {
		const database = requireDb();
		const [row] = await database
			.select()
			.from(vaultCredentials)
			.where(eq(vaultCredentials.id, credentialId))
			.limit(1);
		if (!row) return null;
		const payload = decryptObject(row.value as EncryptedObject);
		await database
			.update(vaultCredentials)
			.set({ lastUsedAt: new Date() })
			.where(eq(vaultCredentials.id, credentialId));
		return {
			id: row.id,
			vaultId: row.vaultId,
			authType: row.authType as VaultAuthType,
			mcpServerUrl: row.mcpServerUrl ?? null,
			accessToken:
				typeof payload.accessToken === "string"
					? (payload.accessToken as string)
					: undefined,
			username:
				typeof payload.username === "string"
					? (payload.username as string)
					: undefined,
			password:
				typeof payload.password === "string"
					? (payload.password as string)
					: undefined,
			secret:
				typeof payload.secret === "string"
					? (payload.secret as string)
					: undefined,
			expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
		};
	}

	async findCredentialForMcpServer(
		vaultIds: string[],
		mcpServerUrl: string,
	): Promise<ResolvedVaultCredential | null> {
		const database = requireDb();
		if (vaultIds.length === 0) return null;
		const rows = await database
			.select({ id: vaultCredentials.id })
			.from(vaultCredentials)
			.where(
				and(
					eq(vaultCredentials.mcpServerUrl, mcpServerUrl),
					eq(vaultCredentials.isArchived, false),
					inArray(vaultCredentials.vaultId, vaultIds),
				),
			)
			.limit(1);
		if (rows.length === 0) return null;
		return this.resolveCredential(rows[0].id);
	}

	async refreshSingleCredential(
		vaultId: string,
		credentialId: string,
	): Promise<VaultCredentialRefreshOutcome & { skipped?: boolean }> {
		const database = requireDb();
		const material = await this.getRefreshMaterial(credentialId);
		if (!material) {
			return {
				ok: false,
				error: "no refresh material - credential is not mcp_oauth or has no refresh token",
				httpStatus: null,
				skipped: true,
			};
		}
		const result = await runRefresh(material);
		if (result.ok) {
			await this.rotateCredential(vaultId, credentialId, {
				accessToken: result.accessToken,
				refreshToken: result.refreshToken ?? undefined,
				expiresAt: result.expiresAt ?? undefined,
			});
			await database.insert(vaultCredentialRefreshLog).values({
				credentialId,
				status: "success",
				responseStatus: result.httpStatus,
			});
		} else {
			await database.insert(vaultCredentialRefreshLog).values({
				credentialId,
				status: "failure",
				errorMessage: result.error,
				responseStatus: result.httpStatus,
			});
		}
		return result;
	}

	async refreshExpiringCredentials(
		options: { leadTimeSeconds?: number } = {},
	): Promise<VaultCredentialRefreshReport> {
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

		const report: VaultCredentialRefreshReport = {
			scanned: candidates.length,
			refreshed: 0,
			failed: 0,
			skipped: 0,
		};

		for (const candidate of candidates) {
			const material = await this.getRefreshMaterial(candidate.id);
			if (!material) {
				report.skipped++;
				continue;
			}
			const result = await runRefresh(material);
			if (result.ok) {
				await this.rotateCredential(candidate.vaultId, candidate.id, {
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

	private async getRefreshMaterial(credentialId: string): Promise<{
		id: string;
		mcpServerUrl: string | null;
		refreshToken: string;
		metadata: VaultOAuthRefreshMetadata;
	} | null> {
		const database = requireDb();
		const [row] = await database
			.select()
			.from(vaultCredentials)
			.where(eq(vaultCredentials.id, credentialId))
			.limit(1);
		if (!row || !row.refreshMetadata) return null;
		const meta = row.refreshMetadata as Record<string, unknown>;
		const encrypted = meta.refreshTokenEncrypted as EncryptedObject | undefined;
		if (!encrypted) return null;
		const refreshToken = decryptString(encrypted);
		const metadata: VaultOAuthRefreshMetadata = {
			tokenEndpoint: String(meta.tokenEndpoint ?? ""),
			clientId: String(meta.clientId ?? ""),
			tokenEndpointAuth:
				meta.tokenEndpointAuth as VaultOAuthRefreshMetadata["tokenEndpointAuth"],
			scope: typeof meta.scope === "string" ? (meta.scope as string) : undefined,
		};
		if (!metadata.tokenEndpoint || !metadata.clientId) return null;
		return {
			id: row.id,
			mcpServerUrl: row.mcpServerUrl ?? null,
			refreshToken,
			metadata,
		};
	}
}

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

function rowToSummary(row: VaultCredential): VaultCredentialSummary {
	return {
		id: row.id,
		vaultId: row.vaultId,
		displayName: row.displayName,
		authType: row.authType as VaultAuthType,
		mcpServerUrl: row.mcpServerUrl ?? null,
		expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
		lastRefreshedAt: row.lastRefreshedAt
			? row.lastRefreshedAt.toISOString()
			: null,
		lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
		isArchived: row.isArchived,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

function buildSecretPayload(
	input: VaultCredentialInput,
): Record<string, unknown> {
	switch (input.authType) {
		case "mcp_oauth":
		case "bearer": {
			if (!input.accessToken) {
				throw new Error(`accessToken is required for authType=${input.authType}`);
			}
			return { accessToken: input.accessToken };
		}
		case "basic": {
			if (!input.username || !input.password) {
				throw new Error("username + password required for basic auth");
			}
			return { username: input.username, password: input.password };
		}
		case "secret_text": {
			if (!input.secret) throw new Error("secret is required for secret_text");
			return { secret: input.secret };
		}
		default:
			throw new Error(`unknown authType: ${(input as { authType: string }).authType}`);
	}
}

function encryptRefreshMetadata(
	metadata: VaultOAuthRefreshMetadata,
	refreshToken?: string,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...metadata };
	if (refreshToken) {
		out.refreshTokenEncrypted = encryptString(refreshToken);
	}
	return out;
}

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
}): Promise<VaultCredentialRefreshOutcome> {
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
