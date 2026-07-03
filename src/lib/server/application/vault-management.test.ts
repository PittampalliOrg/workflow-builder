import { describe, expect, it, vi } from "vitest";
import {
	ApplicationVaultService,
	type VaultRepository,
} from "$lib/server/application/vault-management";

describe("ApplicationVaultService", () => {
	it("builds list filters from query params and session project", async () => {
		const repository = createRepository({
			list: vi.fn(async () => [{ id: "vault-1" }]),
		});
		const service = new ApplicationVaultService(repository);
		const query = new URLSearchParams({
			q: "github",
			includeArchived: "true",
		});

		await expect(
			service.list({ query, sessionProjectId: "project-1" }),
		).resolves.toEqual({ vaults: [{ id: "vault-1" }] });
		expect(repository.list).toHaveBeenCalledWith({
			q: "github",
			includeArchived: true,
			projectId: "project-1",
		});
	});

	it("validates create requests and delegates metadata commands", async () => {
		const repository = createRepository({
			create: vi.fn(async () => ({ id: "vault-1" })),
			update: vi.fn(async () => ({ id: "vault-1", name: "New" })),
			archive: vi.fn(async () => true),
		});
		const service = new ApplicationVaultService(repository);

		await expect(
			service.create({ userId: "user-1", body: { name: "" } }),
		).rejects.toMatchObject({
			status: 400,
			message: "name is required",
		});

		await service.create({
			userId: "user-1",
			body: { name: " GitHub ", description: "oauth", projectId: "project-1" },
		});
		await service.update({
			id: "vault-1",
			body: { name: "New", description: null },
		});
		await expect(service.archive({ id: "vault-1" })).resolves.toEqual({
			archived: true,
		});

		expect(repository.create).toHaveBeenCalledWith({
			name: "GitHub",
			description: "oauth",
			projectId: "project-1",
			createdBy: "user-1",
		});
		expect(repository.update).toHaveBeenCalledWith("vault-1", {
			name: "New",
			description: null,
		});
	});

	it("maps missing vaults to 404", async () => {
		const service = new ApplicationVaultService(createRepository());
		await expect(service.get({ id: "missing" })).rejects.toMatchObject({
			status: 404,
			message: "Vault not found",
		});
	});
});

function createRepository(
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
