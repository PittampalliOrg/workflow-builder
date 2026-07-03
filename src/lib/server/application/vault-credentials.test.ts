import { describe, expect, it, vi } from "vitest";
import {
	ApplicationVaultCredentialService,
	type VaultCredentialRepository,
} from "$lib/server/application/vault-credentials";
import type { VaultRepository } from "$lib/server/application/vault-management";
import type { VaultCredentialSummary } from "$lib/types/vaults";

describe("ApplicationVaultCredentialService", () => {
	it("validates credential creates before delegating", async () => {
		const credentials = createCredentialRepository();
		const vaults = createVaultRepository({
			get: vi.fn(async () => ({ id: "vault-1" })),
		});
		const service = new ApplicationVaultCredentialService(credentials, vaults);

		await expect(
			service.create({
				vaultId: "vault-1",
				body: { authType: "bearer", displayName: "GitHub" },
			}),
		).rejects.toMatchObject({
			status: 400,
			message: "accessToken is required for authType=bearer",
		});

		await expect(
			service.create({
				vaultId: "vault-1",
				body: {
					authType: "bearer",
					displayName: " GitHub ",
					accessToken: "token",
					mcpServerUrl: "http://mcp",
				},
			}),
		).resolves.toMatchObject({
			credential: { id: "credential-1" },
		});

		expect(credentials.createCredential).toHaveBeenCalledWith("vault-1", {
			authType: "bearer",
			displayName: "GitHub",
			accessToken: "token",
			mcpServerUrl: "http://mcp",
			expiresAt: undefined,
			password: undefined,
			refreshMetadata: undefined,
			refreshToken: undefined,
			secret: undefined,
			username: undefined,
		});
	});

	it("maps missing vault and credential rows to not found errors", async () => {
		const credentials = createCredentialRepository();
		const service = new ApplicationVaultCredentialService(
			credentials,
			createVaultRepository(),
		);

		await expect(
			service.create({
				vaultId: "missing",
				body: { authType: "secret_text", displayName: "Secret", secret: "x" },
			}),
		).rejects.toMatchObject({ status: 404, message: "Vault not found" });

		await expect(
			service.get({ vaultId: "vault-1", credentialId: "missing" }),
		).rejects.toMatchObject({
			status: 404,
			message: "Credential not found",
		});
	});

	it("delegates list, update, archive, and refresh commands", async () => {
		const credentials = createCredentialRepository({
			listCredentials: vi.fn(async () => [credentialSummary()]),
			rotateCredential: vi.fn(async () => credentialSummary()),
			archiveCredential: vi.fn(async () => true),
			refreshSingleCredential: vi.fn(async () => ({
				ok: true as const,
				accessToken: "token",
				refreshToken: null,
				expiresAt: null,
				httpStatus: 200,
			})),
			refreshExpiringCredentials: vi.fn(async () => ({
				scanned: 1,
				refreshed: 1,
				failed: 0,
				skipped: 0,
			})),
		});
		const service = new ApplicationVaultCredentialService(
			credentials,
			createVaultRepository({ get: vi.fn(async () => ({ id: "vault-1" })) }),
		);

		await expect(service.list({ vaultId: "vault-1" })).resolves.toMatchObject({
			credentials: [{ id: "credential-1" }],
		});
		await expect(
			service.update({
				vaultId: "vault-1",
				credentialId: "credential-1",
				body: { displayName: "New" },
			}),
		).resolves.toMatchObject({ credential: { id: "credential-1" } });
		await expect(
			service.archive({ vaultId: "vault-1", credentialId: "credential-1" }),
		).resolves.toEqual({ archived: true });
		await expect(
			service.refreshOne({ vaultId: "vault-1", credentialId: "credential-1" }),
		).resolves.toMatchObject({ ok: true, httpStatus: 200 });
		await expect(
			service.refreshExpiring({ leadTimeSeconds: 60 }),
		).resolves.toEqual({
			report: { scanned: 1, refreshed: 1, failed: 0, skipped: 0 },
		});

		expect(credentials.rotateCredential).toHaveBeenCalledWith(
			"vault-1",
			"credential-1",
			{ displayName: "New" },
		);
		expect(credentials.refreshExpiringCredentials).toHaveBeenCalledWith({
			leadTimeSeconds: 60,
		});
	});

	it("resolves MCP credentials from internal request bodies", async () => {
		const credentials = createCredentialRepository({
			findCredentialForMcpServer: vi.fn(async () => ({
				id: "credential-1",
				vaultId: "vault-1",
				authType: "bearer" as const,
				mcpServerUrl: "http://mcp",
				accessToken: "token",
				expiresAt: null,
			})),
		});
		const service = new ApplicationVaultCredentialService(
			credentials,
			createVaultRepository({ get: vi.fn(async () => ({ id: "vault-1" })) }),
		);

		await expect(
			service.resolveForMcpServer({
				body: { vaultIds: ["vault-1", 42], mcpServerUrl: "http://mcp" },
			}),
		).resolves.toMatchObject({
			credential: { id: "credential-1", accessToken: "token" },
		});
		expect(credentials.findCredentialForMcpServer).toHaveBeenCalledWith(
			["vault-1"],
			"http://mcp",
		);

		await expect(
			service.resolveForMcpServer({ body: { vaultIds: ["vault-1"] } }),
		).rejects.toMatchObject({
			status: 400,
			message: "mcpServerUrl is required",
		});
	});
});

function createCredentialRepository(
	overrides: Partial<VaultCredentialRepository> = {},
): VaultCredentialRepository {
	return {
		listCredentials: vi.fn(async () => []),
		getCredential: vi.fn(async () => null),
		createCredential: vi.fn(async () => credentialSummary()),
		rotateCredential: vi.fn(async () => null),
		archiveCredential: vi.fn(async () => false),
		resolveCredential: vi.fn(async () => null),
		findCredentialForMcpServer: vi.fn(async () => null),
		refreshSingleCredential: vi.fn(async () => ({
			ok: false as const,
			error: "missing",
			httpStatus: null,
		})),
		refreshExpiringCredentials: vi.fn(async () => ({
			scanned: 0,
			refreshed: 0,
			failed: 0,
			skipped: 0,
		})),
		...overrides,
	};
}

function credentialSummary(
	overrides: Partial<VaultCredentialSummary> = {},
): VaultCredentialSummary {
	return {
		id: "credential-1",
		vaultId: "vault-1",
		displayName: "GitHub",
		authType: "bearer",
		mcpServerUrl: "http://mcp",
		expiresAt: null,
		lastRefreshedAt: null,
		lastUsedAt: null,
		isArchived: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function createVaultRepository(
	overrides: Partial<VaultRepository> = {},
): VaultRepository {
	return {
		list: vi.fn(async () => []),
		get: vi.fn(async () => null),
		create: vi.fn(async () => ({ id: "vault-1" })),
		update: vi.fn(async () => null),
		archive: vi.fn(async () => false),
		...overrides,
	};
}
