export type VaultAuthType = "mcp_oauth" | "bearer" | "basic" | "secret_text";

/**
 * Token endpoint auth style for the `refresh_token` grant. Mirrors CMA's
 * shape so OAuth refresh config is copy-paste compatible.
 */
export type VaultTokenEndpointAuth =
	| { type: "none" }
	| { type: "client_secret_basic"; client_secret: string }
	| { type: "client_secret_post"; client_secret: string };

export type VaultOAuthRefreshMetadata = {
	tokenEndpoint: string;
	clientId: string;
	tokenEndpointAuth: VaultTokenEndpointAuth;
	scope?: string;
};

/**
 * Wire shape for a secret value on CREATE/UPDATE. Never returned from GET —
 * credentials are write-only. The server encrypts and stores in `value` and
 * refresh_token in `refreshMetadata.refreshTokenEncrypted`.
 */
export type VaultCredentialInput = {
	displayName: string;
	authType: VaultAuthType;
	mcpServerUrl?: string;
	// mcp_oauth + bearer:
	accessToken?: string;
	// mcp_oauth only:
	refreshToken?: string;
	expiresAt?: string;
	refreshMetadata?: VaultOAuthRefreshMetadata;
	// basic:
	username?: string;
	password?: string;
	// secret_text:
	secret?: string;
};

export type VaultSummary = {
	id: string;
	name: string;
	description: string | null;
	projectId: string | null;
	credentialCount: number;
	isArchived: boolean;
	createdAt: string;
	updatedAt: string;
};

export type VaultDetail = VaultSummary;

/**
 * Metadata-only view of a credential — values are never returned from the API.
 * `expiresAt` and `lastRefreshedAt` tell the UI whether auto-refresh is
 * healthy.
 */
export type VaultCredentialSummary = {
	id: string;
	vaultId: string;
	displayName: string;
	authType: VaultAuthType;
	mcpServerUrl: string | null;
	expiresAt: string | null;
	lastRefreshedAt: string | null;
	lastUsedAt: string | null;
	isArchived: boolean;
	createdAt: string;
	updatedAt: string;
};
