import { describe, expect, it, vi } from "vitest";
import {
	ApplicationCapabilityBundleService,
	type CapabilityBundleCreateRecord,
	type CapabilityBundleDetail,
	type CapabilityBundleRepository,
	type CapabilityBundleUpdateRecord,
} from "$lib/server/application/capability-bundles";

describe("ApplicationCapabilityBundleService", () => {
	it("normalizes create requests before calling the repository", async () => {
		const repository = fakeRepository();
		const service = new ApplicationCapabilityBundleService(repository);

		await service.createBundle({
			body: {
				name: " Coding Tools ",
				description: "Useful tools",
				tags: ["coding", 42],
				config: {
					tools: ["shell", 12],
					builtinTools: ["read"],
					plugins: ["github"],
					ignored: "drop me",
				},
			},
			userId: "user-1",
			projectId: "project-1",
		});

		expect(repository.createBundle).toHaveBeenCalledWith(
			expect.objectContaining({
				slugBase: "coding-tools",
				name: "Coding Tools",
				description: "Useful tools",
				tags: ["coding", "42"],
				createdBy: "user-1",
				projectId: "project-1",
				config: {
					tools: ["shell", "12"],
					builtinTools: ["read"],
					plugins: ["github"],
				},
			}),
		);
		const record = vi.mocked(repository.createBundle).mock.calls[0]?.[0];
		expect(record?.configHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("defaults blank names and honors explicit project and slug values", async () => {
		const repository = fakeRepository();
		const service = new ApplicationCapabilityBundleService(repository);

		await service.createBundle({
			body: {
				name: "   ",
				slug: "custom-bundle",
				projectId: "project-body",
				config: null,
			},
			userId: "user-1",
			projectId: "project-session",
		});

		expect(repository.createBundle).toHaveBeenCalledWith(
			expect.objectContaining({
				slugBase: "custom-bundle",
				name: "Untitled bundle",
				description: null,
				tags: [],
				projectId: "project-body",
				config: {},
			}),
		);
	});

	it("normalizes update requests and creates a retry-safe config hash", async () => {
		const repository = fakeRepository();
		const service = new ApplicationCapabilityBundleService(repository);

		await service.updateBundle({
			id: "bundle-1",
			body: {
				name: "Updated",
				description: null,
				tags: ["new"],
				changelog: "add plugin",
				config: {
					plugins: ["jira", 9],
					hooks: { stop: "noop" },
				},
			},
			userId: "user-2",
		});

		expect(repository.updateBundle).toHaveBeenCalledWith(
			"bundle-1",
			expect.objectContaining({
				name: "Updated",
				description: null,
				tags: ["new"],
				changelog: "add plugin",
				publishedBy: "user-2",
				config: {
					plugins: ["jira", "9"],
					hooks: { stop: "noop" },
				},
			}),
		);
		const record = vi.mocked(repository.updateBundle).mock.calls[0]?.[1];
		expect(record?.configHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("delegates reads and archive commands to the repository", async () => {
		const repository = fakeRepository();
		const service = new ApplicationCapabilityBundleService(repository);

		await service.listBundles({ projectId: null, includeArchived: true });
		await service.getBundle({ id: "bundle-1" });
		await service.archiveBundle({ id: "bundle-1" });

		expect(repository.listBundles).toHaveBeenCalledWith({
			projectId: null,
			includeArchived: true,
		});
		expect(repository.getBundle).toHaveBeenCalledWith("bundle-1");
		expect(repository.archiveBundle).toHaveBeenCalledWith("bundle-1");
	});
});

function fakeRepository(): CapabilityBundleRepository {
	const detail: CapabilityBundleDetail = {
		id: "bundle-1",
		slug: "bundle",
		name: "Bundle",
		description: null,
		tags: [],
		projectId: null,
		currentVersion: 1,
		isArchived: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		config: {},
		configHash: "hash",
		changelog: null,
	};
	return {
		listBundles: vi.fn(async () => [detail]),
		getBundle: vi.fn(async () => detail),
		createBundle: vi.fn(async (_input: CapabilityBundleCreateRecord) => detail),
		updateBundle: vi.fn(
			async (_id: string, _input: CapabilityBundleUpdateRecord) => detail,
		),
		archiveBundle: vi.fn(async () => true),
	};
}
