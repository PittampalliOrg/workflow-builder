import { describe, expect, it, vi } from "vitest";
import {
	ApplicationEnvironmentService,
	type EnvironmentRepository,
} from "$lib/server/application/environment-management";

describe("ApplicationEnvironmentService", () => {
	it("builds list filters from query params and session project", async () => {
		const repository = createRepository({
			list: vi.fn(async () => [{ id: "env-1" }]),
		});
		const service = new ApplicationEnvironmentService(repository);
		const query = new URLSearchParams({
			q: "python",
			tag: "eval",
			includeArchived: "true",
		});

		await expect(
			service.list({ query, sessionProjectId: "project-1" }),
		).resolves.toEqual({ environments: [{ id: "env-1" }] });
		expect(repository.list).toHaveBeenCalledWith({
			q: "python",
			tag: "eval",
			includeArchived: true,
			projectId: "project-1",
		});
	});

	it("normalizes create and update commands before calling repository ports", async () => {
		const repository = createRepository({
			create: vi.fn(async () => ({ id: "env-1" })),
			update: vi.fn(async () => ({ id: "env-1", name: "Updated" })),
		});
		const service = new ApplicationEnvironmentService(repository);

		await service.create({
			userId: "user-1",
			sessionProjectId: "project-1",
			body: {
				name: " Python ",
				description: "test env",
				tags: ["eval", 123],
				config: { image: "python:3.12" },
			},
		});
		await service.update({
			id: "env-1",
			userId: "user-1",
			body: { name: "Updated", tags: ["prod"], changelog: "publish" },
		});

		expect(repository.create).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Python",
				description: "test env",
				tags: ["eval", "123"],
				createdBy: "user-1",
				projectId: "project-1",
				config: expect.objectContaining({ image: "python:3.12" }),
			}),
		);
		expect(repository.update).toHaveBeenCalledWith("env-1", {
			name: "Updated",
			description: undefined,
			avatar: undefined,
			tags: ["prod"],
			config: undefined,
			baseEnvSlug: undefined,
			changelog: "publish",
			publishedBy: "user-1",
		});
	});

	it("maps missing resources and invalid versions to application errors", async () => {
		const service = new ApplicationEnvironmentService(createRepository());

		await expect(service.get({ id: "missing" })).rejects.toMatchObject({
			status: 404,
			message: "Environment not found",
		});
		await expect(
			service.getVersion({ id: "env-1", versionParam: "0" }),
		).rejects.toMatchObject({
			status: 400,
			message: "Invalid version",
		});
	});

	it("returns usages and dockerfile preview read models", async () => {
		const service = new ApplicationEnvironmentService(
			createRepository({
				findUsages: vi.fn(async () => [{ agentId: "agent-1" }]),
				previewDockerfile: vi.fn(async () => "FROM python:3.12"),
			}),
		);

		await expect(service.usages({ id: "env-1" })).resolves.toEqual({
			usages: [{ agentId: "agent-1" }],
			totalAgents: 1,
		});
		await expect(
			service.dockerfilePreview({ id: "env-1" }),
		).resolves.toEqual({ dockerfile: "FROM python:3.12" });
	});
});

function createRepository(
	overrides: Partial<EnvironmentRepository> = {},
): EnvironmentRepository {
	return {
		list: vi.fn(async () => []),
		get: vi.fn(async () => null),
		create: vi.fn(async () => ({ id: "env-1" })),
		update: vi.fn(async () => null),
		archive: vi.fn(async () => false),
		duplicate: vi.fn(async () => null),
		listVersions: vi.fn(async () => []),
		getVersion: vi.fn(async () => null),
		restoreVersion: vi.fn(async () => null),
		findUsages: vi.fn(async () => []),
		previewDockerfile: vi.fn(async () => null),
		...overrides,
	};
}
