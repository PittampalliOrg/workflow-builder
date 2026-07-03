import type {
	VaultAuthType,
	VaultCredentialInput,
	VaultCredentialSummary,
} from "$lib/types/vaults";
import type { VaultRepository } from "$lib/server/application/vault-management";

export class ApplicationVaultCredentialError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ApplicationVaultCredentialError";
	}
}

export type ResolvedVaultCredential = {
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

export type VaultCredentialRefreshReport = {
	scanned: number;
	refreshed: number;
	failed: number;
	skipped: number;
};

export type VaultCredentialRefreshSuccess = {
	ok: true;
	accessToken: string;
	refreshToken: string | null;
	expiresAt: string | null;
	httpStatus: number;
};

export type VaultCredentialRefreshFailure = {
	ok: false;
	error: string;
	httpStatus: number | null;
};

export type VaultCredentialRefreshOutcome =
	| VaultCredentialRefreshSuccess
	| VaultCredentialRefreshFailure;

export type VaultCredentialRepository = {
	listCredentials(vaultId: string): Promise<VaultCredentialSummary[]>;
	getCredential(
		vaultId: string,
		credentialId: string,
	): Promise<VaultCredentialSummary | null>;
	createCredential(
		vaultId: string,
		input: VaultCredentialInput,
	): Promise<VaultCredentialSummary>;
	rotateCredential(
		vaultId: string,
		credentialId: string,
		input: Partial<VaultCredentialInput>,
	): Promise<VaultCredentialSummary | null>;
	archiveCredential(vaultId: string, credentialId: string): Promise<boolean>;
	resolveCredential(
		credentialId: string,
	): Promise<ResolvedVaultCredential | null>;
	findCredentialForMcpServer(
		vaultIds: string[],
		mcpServerUrl: string,
	): Promise<ResolvedVaultCredential | null>;
	refreshSingleCredential(
		vaultId: string,
		credentialId: string,
	): Promise<VaultCredentialRefreshOutcome & { skipped?: boolean }>;
	refreshExpiringCredentials(options?: {
		leadTimeSeconds?: number;
	}): Promise<VaultCredentialRefreshReport>;
};

export class ApplicationVaultCredentialService {
	constructor(
		private readonly credentials: VaultCredentialRepository,
		private readonly vaults: Pick<VaultRepository, "get">,
	) {}

	async list(input: {
		vaultId: string;
	}): Promise<{ credentials: VaultCredentialSummary[] }> {
		return {
			credentials: await this.runRepositoryCall(() =>
				this.credentials.listCredentials(input.vaultId),
			),
		};
	}

	async create(input: {
		vaultId: string;
		body: unknown;
	}): Promise<{ credential: VaultCredentialSummary }> {
		await this.requireVault(input.vaultId);
		const parsed = validateCredentialInput(asRecord(input.body));
		if (typeof parsed === "string") {
			throw new ApplicationVaultCredentialError(400, parsed);
		}
		return {
			credential: await this.runRepositoryCall(() =>
				this.credentials.createCredential(input.vaultId, parsed),
			),
		};
	}

	async get(input: {
		vaultId: string;
		credentialId: string;
	}): Promise<{ credential: VaultCredentialSummary }> {
		const credential = await this.runRepositoryCall(() =>
			this.credentials.getCredential(input.vaultId, input.credentialId),
		);
		if (!credential) {
			throw new ApplicationVaultCredentialError(404, "Credential not found");
		}
		return { credential };
	}

	async update(input: {
		vaultId: string;
		credentialId: string;
		body: unknown;
	}): Promise<{ credential: VaultCredentialSummary }> {
		const credential = await this.runRepositoryCall(() =>
			this.credentials.rotateCredential(
				input.vaultId,
				input.credentialId,
				parseCredentialPatch(asRecord(input.body)),
			),
		);
		if (!credential) {
			throw new ApplicationVaultCredentialError(404, "Credential not found");
		}
		return { credential };
	}

	async archive(input: {
		vaultId: string;
		credentialId: string;
	}): Promise<{ archived: true }> {
		const archived = await this.runRepositoryCall(() =>
			this.credentials.archiveCredential(input.vaultId, input.credentialId),
		);
		if (!archived) {
			throw new ApplicationVaultCredentialError(404, "Credential not found");
		}
		return { archived: true };
	}

	async refreshOne(input: {
		vaultId: string;
		credentialId: string;
	}): Promise<VaultCredentialRefreshOutcome & { skipped?: boolean }> {
		return this.runRepositoryCall(() =>
			this.credentials.refreshSingleCredential(
				input.vaultId,
				input.credentialId,
			),
		);
	}

	async refreshExpiring(input: {
		leadTimeSeconds?: number;
	}): Promise<{ report: VaultCredentialRefreshReport }> {
		return {
			report: await this.runRepositoryCall(() =>
				this.credentials.refreshExpiringCredentials({
					leadTimeSeconds: input.leadTimeSeconds,
				}),
			),
		};
	}

	async resolveForMcpServer(input: {
		body: unknown;
	}): Promise<{ credential: ResolvedVaultCredential | null }> {
		const body = asRecord(input.body);
		const vaultIds = Array.isArray(body.vaultIds)
			? body.vaultIds.filter((value): value is string => typeof value === "string")
			: [];
		const mcpServerUrl =
			typeof body.mcpServerUrl === "string" ? body.mcpServerUrl : "";
		if (!mcpServerUrl) {
			throw new ApplicationVaultCredentialError(
				400,
				"mcpServerUrl is required",
			);
		}
		if (vaultIds.length === 0) return { credential: null };
		return {
			credential: await this.runRepositoryCall(() =>
				this.credentials.findCredentialForMcpServer(vaultIds, mcpServerUrl),
			),
		};
	}

	private async requireVault(vaultId: string): Promise<void> {
		const vault = await this.runRepositoryCall(() => this.vaults.get(vaultId));
		if (!vault) throw new ApplicationVaultCredentialError(404, "Vault not found");
	}

	private async runRepositoryCall<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (err) {
			throw toApplicationError(err);
		}
	}
}

function validateCredentialInput(
	body: Record<string, unknown>,
): VaultCredentialInput | string {
	const authType = body.authType;
	if (
		authType !== "mcp_oauth" &&
		authType !== "bearer" &&
		authType !== "basic" &&
		authType !== "secret_text"
	) {
		return "authType must be one of mcp_oauth, bearer, basic, secret_text";
	}
	const displayName =
		typeof body.displayName === "string" && body.displayName.trim()
			? body.displayName.trim()
			: "";
	if (!displayName) return "displayName is required";
	if (
		(authType === "mcp_oauth" || authType === "bearer") &&
		typeof body.accessToken !== "string"
	) {
		return `accessToken is required for authType=${authType}`;
	}
	if (
		authType === "basic" &&
		(typeof body.username !== "string" || typeof body.password !== "string")
	) {
		return "username + password required for basic auth";
	}
	if (authType === "secret_text" && typeof body.secret !== "string") {
		return "secret is required for secret_text";
	}
	return {
		displayName,
		authType,
		mcpServerUrl:
			typeof body.mcpServerUrl === "string" ? body.mcpServerUrl : undefined,
		accessToken:
			typeof body.accessToken === "string" ? body.accessToken : undefined,
		refreshToken:
			typeof body.refreshToken === "string" ? body.refreshToken : undefined,
		expiresAt:
			typeof body.expiresAt === "string" ? body.expiresAt : undefined,
		refreshMetadata:
			body.refreshMetadata && typeof body.refreshMetadata === "object"
				? (body.refreshMetadata as VaultCredentialInput["refreshMetadata"])
				: undefined,
		username: typeof body.username === "string" ? body.username : undefined,
		password: typeof body.password === "string" ? body.password : undefined,
		secret: typeof body.secret === "string" ? body.secret : undefined,
	};
}

function parseCredentialPatch(
	body: Record<string, unknown>,
): Partial<VaultCredentialInput> {
	const input: Partial<VaultCredentialInput> = {};
	if (typeof body.displayName === "string") input.displayName = body.displayName;
	if (typeof body.mcpServerUrl === "string" || body.mcpServerUrl === null) {
		input.mcpServerUrl = (body.mcpServerUrl as string) ?? undefined;
	}
	if (typeof body.accessToken === "string") input.accessToken = body.accessToken;
	if (typeof body.refreshToken === "string")
		input.refreshToken = body.refreshToken;
	if (typeof body.expiresAt === "string") input.expiresAt = body.expiresAt;
	if (body.refreshMetadata && typeof body.refreshMetadata === "object") {
		input.refreshMetadata =
			body.refreshMetadata as VaultCredentialInput["refreshMetadata"];
	}
	if (typeof body.username === "string") input.username = body.username;
	if (typeof body.password === "string") input.password = body.password;
	if (typeof body.secret === "string") input.secret = body.secret;
	return input;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toApplicationError(err: unknown): ApplicationVaultCredentialError {
	if (err instanceof ApplicationVaultCredentialError) return err;
	const maybe = err as { status?: unknown; body?: unknown; message?: unknown };
	const status = typeof maybe.status === "number" ? maybe.status : 500;
	const message =
		isRecord(maybe.body) && typeof maybe.body.message === "string"
			? maybe.body.message
			: typeof maybe.message === "string"
				? maybe.message
				: String(err);
	return new ApplicationVaultCredentialError(status, message);
}
