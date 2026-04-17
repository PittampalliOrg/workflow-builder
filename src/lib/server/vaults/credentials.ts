import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
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
	VaultAuthType,
	VaultCredentialInput,
	VaultCredentialSummary,
	VaultOAuthRefreshMetadata,
} from "$lib/types/vaults";

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

/**
 * Assemble the raw credential payload that `encryptObject` serializes. Shape
 * is authType-dependent:
 *   mcp_oauth  → { accessToken }
 *   bearer     → { accessToken }
 *   basic      → { username, password }
 *   secret_text → { secret }
 *
 * Refresh tokens (mcp_oauth) live separately under
 * `refreshMetadata.refreshTokenEncrypted` so a rotation of the access token
 * doesn't disturb the refresh token and vice versa.
 */
function buildSecretPayload(
	input: VaultCredentialInput,
): Record<string, unknown> {
	switch (input.authType) {
		case "mcp_oauth":
		case "bearer": {
			if (!input.accessToken)
				throw new Error(`accessToken is required for authType=${input.authType}`);
			return { accessToken: input.accessToken };
		}
		case "basic": {
			if (!input.username || !input.password)
				throw new Error("username + password required for basic auth");
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

export async function createCredential(
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

export async function listCredentials(
	vaultId: string,
): Promise<VaultCredentialSummary[]> {
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

export async function getCredential(
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

/**
 * Rotate a credential. Accepts the same input shape as create — only the
 * fields provided are updated. Used by the Rotate button in the UI and by
 * the OAuth auto-refresh scheduler.
 */
export async function rotateCredential(
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
	if (input.mcpServerUrl !== undefined)
		patch.mcpServerUrl = input.mcpServerUrl ?? null;
	if (input.expiresAt !== undefined) {
		patch.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
	}
	// If any secret field is provided, rebuild the encrypted value.
	if (
		input.accessToken ||
		input.username ||
		input.password ||
		input.secret
	) {
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

export async function archiveCredential(
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

export type ResolvedCredential = {
	id: string;
	vaultId: string;
	authType: VaultAuthType;
	mcpServerUrl: string | null;
	accessToken?: string;
	username?: string;
	password?: string;
	secret?: string;
	expiresAt: string | null;
};

/**
 * Decrypt a credential for use at tool-call time. Called only by
 * function-router's vault proxy. Touches `lastUsedAt` on read.
 */
export async function resolveCredential(
	credentialId: string,
): Promise<ResolvedCredential | null> {
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

/**
 * Find the best-matching credential for an MCP server URL across a set of
 * vaults. Used by function-router when an MCP tool fires and the session
 * has vault_ids attached. Exact-match only — no wildcards.
 */
export async function findCredentialForMcpServer(
	vaultIds: string[],
	mcpServerUrl: string,
): Promise<ResolvedCredential | null> {
	const database = requireDb();
	if (vaultIds.length === 0) return null;
	const rows = await database
		.select({ id: vaultCredentials.id })
		.from(vaultCredentials)
		.where(
			and(
				eq(vaultCredentials.mcpServerUrl, mcpServerUrl),
				eq(vaultCredentials.isArchived, false),
				sql`${vaultCredentials.vaultId} IN ${vaultIds}`,
			),
		)
		.limit(1);
	if (rows.length === 0) return null;
	return resolveCredential(rows[0].id);
}

/**
 * Fetch a credential's stored refresh token + metadata for the OAuth
 * auto-refresh scheduler. Returns null if the credential has no refresh
 * metadata or the refresh token can't be decrypted.
 */
export async function getRefreshMaterial(credentialId: string): Promise<{
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
		tokenEndpointAuth: meta.tokenEndpointAuth as VaultOAuthRefreshMetadata["tokenEndpointAuth"],
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
