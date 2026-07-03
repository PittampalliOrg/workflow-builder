import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationAgentRuntimeControlService } from "$lib/server/application/agent-runtime-control";
import type {
	AgentRuntimeRepository,
	AgentRuntimeWarmPoolClient,
	WorkspaceProjectRepository,
} from "$lib/server/application/ports";

function agentRuntimeRepository(): AgentRuntimeRepository {
	return {
		listProjectAgents: vi.fn(async () => [
			{
				id: "agent-1",
				projectId: "project-1",
				slug: "browser",
				runtimeAppId: null,
				isArchived: false,
			},
			{
				id: "agent-archived",
				projectId: "project-1",
				slug: "archived",
				runtimeAppId: null,
				isArchived: true,
			},
		]),
		getAgentBySlug: vi.fn(async ({ slug }) =>
			slug === "missing"
				? null
				: {
						id: "agent-1",
						projectId: "project-1",
						slug,
						runtimeAppId: slug === "shared" ? "agent-runtime-shared-browser" : null,
						isArchived: false,
					},
		),
		listRecentlyActiveAgentSlugs: vi.fn(async () => ["active"]),
	};
}

function warmPoolClient(): AgentRuntimeWarmPoolClient {
	return {
		listWarmPools: vi.fn(async () => [
			{
				name: "agent-runtime-browser",
				namespace: "workflow-builder",
				labels: { "agents.x-k8s.io/slug": "browser" },
				annotations: {},
				desiredReplicas: 1,
				replicas: 1,
				readyReplicas: 1,
				sandboxTemplateRefName: "agent-runtime-browser",
			},
			{
				name: "agent-runtime-archived",
				namespace: "workflow-builder",
				labels: { "agents.x-k8s.io/slug": "archived" },
				annotations: {},
				desiredReplicas: 1,
				replicas: 1,
				readyReplicas: 1,
				sandboxTemplateRefName: "agent-runtime-archived",
			},
		]),
		getWarmPool: vi.fn(async (name) =>
			name === "agent-runtime-missing-pool"
				? null
				: {
						name,
						namespace: "workflow-builder",
						labels: { "agents.x-k8s.io/slug": "browser" },
						annotations: { managed: "true" },
						desiredReplicas: 1,
						replicas: 1,
						readyReplicas: 1,
						sandboxTemplateRefName: name,
					},
		),
		getRuntimePod: vi.fn(async (runtimeSlug) => ({
			name: `agent-runtime-${runtimeSlug}-pod`,
			namespace: "workflow-builder",
			containers: [
				{ name: "chromium", ready: true },
				{ name: "playwright-mcp", ready: true },
			],
		})),
		wakeRuntime: vi.fn(async (runtimeSlug) => ({
			phase: "Active",
			replicas: 1,
			readyReplicas: 1,
			source: `woke:${runtimeSlug}`,
		})),
		sleepRuntime: vi.fn(async () => undefined),
		setWarmPoolReplicas: vi.fn(async () => undefined),
	};
}

function workspaceProjects(role: "ADMIN" | "VIEWER" = "ADMIN"): WorkspaceProjectRepository {
	return {
		getProjectMemberRole: vi.fn(async () => role),
	} as unknown as WorkspaceProjectRepository;
}

describe("ApplicationAgentRuntimeControlService", () => {
	let agentRuntimes: AgentRuntimeRepository;
	let warmPools: AgentRuntimeWarmPoolClient;

	beforeEach(() => {
		agentRuntimes = agentRuntimeRepository();
		warmPools = warmPoolClient();
	});

	it("lists workspace warm pools without exposing archived agents", async () => {
		const service = new ApplicationAgentRuntimeControlService({
			agentRuntimes,
			workspaceProjects: workspaceProjects(),
			warmPools,
		});

		const result = await service.listRuntimes({
			projectId: "project-1",
			idleTtlSeconds: 600,
		});

		expect(result.runtimes).toHaveLength(1);
		expect(result.runtimes[0]).toMatchObject({
			name: "agent-runtime-browser",
			slug: "browser",
			phase: "Active",
			browserSidecarEnabled: true,
			idleTtlSeconds: 600,
		});
		expect(warmPools.getRuntimePod).toHaveBeenCalledWith("browser");
	});

	it("returns a non-existing detail model when an agent has no warm pool", async () => {
		const service = new ApplicationAgentRuntimeControlService({
			agentRuntimes,
			workspaceProjects: workspaceProjects(),
			warmPools,
		});

		const result = await service.getRuntimeDetail({
			slug: "missing-pool",
			projectId: "project-1",
		});

		expect(result).toMatchObject({
			status: "ok",
			body: {
				name: "agent-runtime-missing-pool",
				exists: false,
				phase: "Unknown",
			},
		});
	});

	it("wakes the runtime slug resolved from the agent runtime app id", async () => {
		const service = new ApplicationAgentRuntimeControlService({
			agentRuntimes,
			workspaceProjects: workspaceProjects(),
			warmPools,
		});

		const result = await service.wakeRuntime({
			slug: "shared",
			projectId: "project-1",
			timeoutMs: 5000,
		});

		expect(result).toMatchObject({ phase: "Active", source: "woke:shared-browser" });
		expect(warmPools.wakeRuntime).toHaveBeenCalledWith("shared-browser", 5000);
	});

	it("keeps sleep admin-gated inside the application service", async () => {
		const service = new ApplicationAgentRuntimeControlService({
			agentRuntimes,
			workspaceProjects: workspaceProjects("VIEWER"),
			warmPools,
		});

		const result = await service.sleepRuntime({
			slug: "browser",
			projectId: "project-1",
			userId: "user-1",
		});

		expect(result.status).toBe("forbidden");
		expect(warmPools.sleepRuntime).not.toHaveBeenCalled();
	});

	it("reaps idle pools and skips recently active agents", async () => {
		const service = new ApplicationAgentRuntimeControlService({
			agentRuntimes,
			workspaceProjects: workspaceProjects(),
			warmPools,
		});
		vi.mocked(warmPools.listWarmPools).mockResolvedValueOnce([
			{
				name: "agent-runtime-active",
				namespace: "workflow-builder",
				labels: { "agents.x-k8s.io/slug": "active" },
				annotations: {},
				desiredReplicas: 1,
				replicas: 1,
				readyReplicas: 1,
				sandboxTemplateRefName: "agent-runtime-active",
			},
			{
				name: "agent-runtime-idle",
				namespace: "workflow-builder",
				labels: { "agents.x-k8s.io/slug": "idle" },
				annotations: {},
				desiredReplicas: 1,
				replicas: 1,
				readyReplicas: 1,
				sandboxTemplateRefName: "agent-runtime-idle",
			},
		]);

		const result = await service.reapIdle({
			namespace: "workflow-builder",
			ttlSeconds: 60,
			now: new Date("2026-07-03T12:00:00.000Z"),
		});

		expect(result).toEqual({
			namespace: "workflow-builder",
			ttlSeconds: 60,
			reaped: ["idle"],
			skipped: ["active"],
		});
		expect(agentRuntimes.listRecentlyActiveAgentSlugs).toHaveBeenCalledWith({
			slugs: ["active", "idle"],
			activeStatuses: ["running", "rescheduling", "queued"],
			updatedAfter: new Date("2026-07-03T11:59:00.000Z"),
		});
		expect(warmPools.setWarmPoolReplicas).toHaveBeenCalledWith(
			"agent-runtime-idle",
			0,
			"workflow-builder",
		);
	});
});
