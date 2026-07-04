import { describe, expect, it, vi } from "vitest";
import {
	ApplicationEnvironmentService,
	type EnvironmentMaintenanceRepository,
	type EnvironmentRepository,
	type EnvironmentRuntimeResolver,
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

	it("delegates environment maintenance to the maintenance port", async () => {
		const maintenance = createMaintenanceRepository({
			backfillDefaultEnvironment: vi.fn(async () => ({
				defaultEnvironmentCreated: true,
				defaultEnvironmentId: "env-default",
				agentsLinked: 2,
				totalAgents: 3,
			})),
			repairBuiltinSandboxEnvironmentImages: vi.fn(async () => ({
				environmentName: "dev",
				scanned: 4,
				updated: 1,
				cleared: 0,
			})),
		});
		const service = new ApplicationEnvironmentService(createRepository(), maintenance);

		await expect(service.backfillDefault()).resolves.toEqual({
			report: {
				defaultEnvironmentCreated: true,
				defaultEnvironmentId: "env-default",
				agentsLinked: 2,
				totalAgents: 3,
			},
		});
		await expect(service.repairBuiltinSandboxImages()).resolves.toEqual({
			report: {
				environmentName: "dev",
				scanned: 4,
				updated: 1,
				cleared: 0,
			},
		});
		expect(maintenance.backfillDefaultEnvironment).toHaveBeenCalledOnce();
		expect(maintenance.repairBuiltinSandboxEnvironmentImages).toHaveBeenCalledOnce();
	});

	it("resolves runtime environments through the runtime resolver port", async () => {
		const runtimeResolver = createRuntimeResolver({
			resolveBySlug: vi.fn(async () => ({
				id: "env-1",
				slug: "dapr-agent",
				version: 3,
				imageTag: "ghcr.io/test/dapr-agent:latest",
				imageSource: "translated" as const,
				imageResolutionWarning: null,
				baseEnvSlug: null,
				config: {
					sandboxMode: "per-run" as const,
					keepAfterRun: true,
					ttlSeconds: 900,
					networking: { type: "unrestricted" as const },
					capabilities: ["python"],
				},
			})),
		});
		const service = new ApplicationEnvironmentService(
			createRepository(),
			undefined,
			runtimeResolver,
		);

		await expect(
			service.resolveRuntimeBySlug({ slug: " dapr-agent " }),
		).resolves.toEqual({
			environment: expect.objectContaining({
				id: "env-1",
				slug: "dapr-agent",
				imageSource: "translated",
			}),
		});
		expect(runtimeResolver.resolveBySlug).toHaveBeenCalledWith("dapr-agent");
	});

	it("resolves runtime environments by id/version through the runtime resolver port", async () => {
		const runtimeResolver = createRuntimeResolver({
			resolveRef: vi.fn(async () => ({
				id: "env-1",
				slug: "dapr-agent",
				version: 4,
				imageTag: "ghcr.io/test/dapr-agent:v4",
				imageSource: "stored" as const,
				imageResolutionWarning: null,
				baseEnvSlug: null,
				config: {
					sandboxMode: "per-run" as const,
					keepAfterRun: false,
					ttlSeconds: 1800,
					networking: { type: "unrestricted" as const },
					capabilities: ["python"],
				},
			})),
		});
		const service = new ApplicationEnvironmentService(
			createRepository(),
			undefined,
			runtimeResolver,
		);

		await expect(
			service.resolveRuntimeByRef({ id: " env-1 ", version: 4 }),
		).resolves.toEqual({
			environment: expect.objectContaining({
				id: "env-1",
				slug: "dapr-agent",
				version: 4,
			}),
		});
		expect(runtimeResolver.resolveRef).toHaveBeenCalledWith({
			id: "env-1",
			version: 4,
		});
	});

	it("preserves nullable id/version runtime resolution for best-effort callers", async () => {
		const runtimeResolver = createRuntimeResolver({
			resolveRef: vi.fn(async () => null),
		});
		const service = new ApplicationEnvironmentService(
			createRepository(),
			undefined,
			runtimeResolver,
		);

		await expect(
			service.resolveRuntimeByRef({ id: "missing", version: null }),
		).resolves.toEqual({ environment: null });
		await expect(service.resolveRuntimeByRef({ id: " " })).rejects.toMatchObject({
			status: 400,
			message: "environment id required",
		});
	});

	it("maps runtime resolver validation and misses to application errors", async () => {
		const service = new ApplicationEnvironmentService(
			createRepository(),
			undefined,
			createRuntimeResolver(),
		);

		await expect(
			service.resolveRuntimeBySlug({ slug: " " }),
		).rejects.toMatchObject({
			status: 400,
			message: "slug query param required",
		});
		await expect(
			service.resolveRuntimeBySlug({ slug: "missing" }),
		).rejects.toMatchObject({
			status: 404,
			message: 'Environment "missing" not found',
		});
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

function createMaintenanceRepository(
	overrides: Partial<EnvironmentMaintenanceRepository> = {},
): EnvironmentMaintenanceRepository {
	return {
		backfillDefaultEnvironment: vi.fn(async () => ({
			defaultEnvironmentCreated: false,
			defaultEnvironmentId: "env-default",
			agentsLinked: 0,
			totalAgents: 0,
		})),
		repairBuiltinSandboxEnvironmentImages: vi.fn(async () => ({
			environmentName: "dev",
			scanned: 0,
			updated: 0,
			cleared: 0,
		})),
		...overrides,
	};
}

function createRuntimeResolver(
	overrides: Partial<EnvironmentRuntimeResolver> = {},
): EnvironmentRuntimeResolver {
	return {
		resolveBySlug: vi.fn(async () => null),
		resolveRef: vi.fn(async () => null),
		...overrides,
	};
}
