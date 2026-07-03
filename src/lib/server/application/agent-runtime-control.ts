import {
	agentRuntimeDedicatedAppId,
	agentRuntimeSlugFromAppId,
} from "$lib/server/agents/runtime-routing";
import type {
	AgentRuntimeAgentRecord,
	AgentRuntimePodRecord,
	AgentRuntimeRepository,
	AgentRuntimeWakeResult,
	AgentRuntimeWarmPoolClient,
	AgentRuntimeWarmPoolRecord,
	WorkspaceProjectRepository,
} from "$lib/server/application/ports";

const ACTIVE_SESSION_STATUSES = ["running", "rescheduling", "queued"];

export type AgentRuntimeListItem = {
	name: string;
	namespace: string;
	slug: string | null;
	appId: string;
	phase: string;
	desiredReplicas: number;
	replicas: number;
	readyReplicas: number;
	sandboxTemplateRef: string;
	lastActiveAt: null;
	imageTag: null;
	mcpServers: [];
	idleTtlSeconds: number;
	browserSidecarEnabled: boolean;
	pod: { name: string; containers: AgentRuntimePodRecord["containers"] } | null;
};

export type AgentRuntimeDetailReadModel =
	| { status: "not_found"; message: string }
	| {
			status: "ok";
			body: {
				name: string;
				namespace?: string;
				exists: boolean;
				phase: string;
				desiredReplicas?: number;
				replicas: number;
				readyReplicas: number;
				sandboxTemplateRef?: string;
				annotations?: Record<string, string>;
				browserSidecarEnabled: boolean;
				browserMcpAvailable: boolean;
				pod: { name: string; containers: AgentRuntimePodRecord["containers"] } | null;
			};
	  };

export type AgentRuntimeSleepResult =
	| { status: "ok" }
	| { status: "no_workspace" }
	| { status: "not_found"; message: string }
	| { status: "forbidden"; message: string };

export type AgentRuntimeReapIdleResult = {
	namespace: string;
	ttlSeconds: number;
	reaped: string[];
	skipped: string[];
};

export class ApplicationAgentRuntimeControlService {
	constructor(
		private readonly deps: {
			agentRuntimes: AgentRuntimeRepository;
			workspaceProjects: WorkspaceProjectRepository;
			warmPools: AgentRuntimeWarmPoolClient;
		},
	) {}

	async listRuntimes(input: {
		projectId?: string | null;
		idleTtlSeconds?: number;
	}): Promise<{ runtimes: AgentRuntimeListItem[] }> {
		const projectId = input.projectId ?? null;
		const agentRows = projectId
			? await this.deps.agentRuntimes.listProjectAgents(projectId)
			: [];
		const agentsBySlug = new Map(agentRows.map((agent) => [agent.slug, agent]));
		const visibleSlugs = new Set(
			agentRows.filter((agent) => !agent.isArchived).map((agent) => agent.slug),
		);

		const pools = await this.deps.warmPools.listWarmPools();
		const runtimes = await Promise.all(
			pools
				.filter((pool) => {
					if (!projectId) return true;
					const slug = pool.labels["agents.x-k8s.io/slug"];
					return slug ? visibleSlugs.has(slug) : false;
				})
				.map(async (pool) => {
					const slug = pool.labels["agents.x-k8s.io/slug"] ?? null;
					const phase = phaseForWarmPool(pool);
					const pod =
						phase === "Active" && slug
							? await this.deps.warmPools.getRuntimePod(slug).catch(() => null)
							: null;
					const agent = slug ? agentsBySlug.get(slug) : null;

					return {
						name: pool.name,
						namespace: pool.namespace,
						slug,
						appId: agent?.runtimeAppId ?? (slug ? `agent-runtime-${slug}` : pool.name),
						phase,
						desiredReplicas: pool.desiredReplicas,
						replicas: pool.replicas,
						readyReplicas: pool.readyReplicas,
						sandboxTemplateRef: pool.sandboxTemplateRefName,
						lastActiveAt: null,
						imageTag: null,
						mcpServers: [],
						idleTtlSeconds: input.idleTtlSeconds ?? 1800,
						browserSidecarEnabled: pod
							? pod.containers.some((c) => c.name === "playwright-mcp")
							: false,
						pod: pod ? { name: pod.name, containers: pod.containers } : null,
					} satisfies AgentRuntimeListItem;
				}),
		);

		return { runtimes };
	}

	async getRuntimeDetail(input: {
		slug: string;
		projectId?: string | null;
	}): Promise<AgentRuntimeDetailReadModel> {
		const agent = await this.resolveAgent(input.slug, input.projectId);
		if (!agent) {
			return {
				status: "not_found",
				message: `Agent ${input.slug} not found in workspace`,
			};
		}

		const runtimeSlug = runtimeSlugForAgent(agent);
		const poolName = agentRuntimeDedicatedAppId(runtimeSlug);
		const pool = await this.deps.warmPools.getWarmPool(poolName);
		if (!pool) {
			return {
				status: "ok",
				body: {
					name: poolName,
					exists: false,
					phase: "Unknown",
					replicas: 0,
					readyReplicas: 0,
					browserSidecarEnabled: false,
					browserMcpAvailable: false,
					pod: null,
				},
			};
		}

		const phase = phaseForWarmPool(pool);
		const pod = phase === "Active"
			? await this.deps.warmPools.getRuntimePod(runtimeSlug)
			: null;
		const browser = browserAvailability(pod);
		return {
			status: "ok",
			body: {
				name: pool.name,
				namespace: pool.namespace,
				exists: true,
				phase,
				desiredReplicas: pool.desiredReplicas,
				replicas: pool.replicas,
				readyReplicas: pool.readyReplicas,
				sandboxTemplateRef: pool.sandboxTemplateRefName,
				annotations: pool.annotations,
				browserSidecarEnabled: browser.sidecarEnabled,
				browserMcpAvailable: browser.mcpAvailable,
				pod: pod ? { name: pod.name, containers: pod.containers } : null,
			},
		};
	}

	async wakeRuntime(input: {
		slug: string;
		projectId?: string | null;
		timeoutMs: number;
	}): Promise<AgentRuntimeWakeResult | { status: "not_found"; message: string }> {
		const agent = await this.resolveAgent(input.slug, input.projectId);
		if (!agent) {
			return {
				status: "not_found",
				message: `Agent ${input.slug} not found in workspace`,
			};
		}
		return this.deps.warmPools.wakeRuntime(runtimeSlugForAgent(agent), input.timeoutMs);
	}

	async sleepRuntime(input: {
		slug: string;
		projectId?: string | null;
		userId: string;
	}): Promise<AgentRuntimeSleepResult> {
		if (!input.projectId) return { status: "no_workspace" };
		const agent = await this.resolveAgent(input.slug, input.projectId);
		if (!agent) {
			return {
				status: "not_found",
				message: `Agent ${input.slug} not found in workspace`,
			};
		}
		const role = await this.deps.workspaceProjects.getProjectMemberRole({
			projectId: input.projectId,
			userId: input.userId,
		});
		if (role !== "ADMIN") {
			return {
				status: "forbidden",
				message: "Admin role required to sleep an agent runtime",
			};
		}
		await this.deps.warmPools.sleepRuntime(runtimeSlugForAgent(agent));
		return { status: "ok" };
	}

	async reapIdle(input: {
		namespace: string;
		ttlSeconds: number;
		now?: Date;
	}): Promise<AgentRuntimeReapIdleResult> {
		const pools = await this.deps.warmPools.listWarmPools(input.namespace);
		const candidates = pools.filter(
			(pool) =>
				pool.desiredReplicas > 0 && pool.labels["agents.x-k8s.io/slug"],
		);
		if (candidates.length === 0) {
			return {
				namespace: input.namespace,
				ttlSeconds: input.ttlSeconds,
				reaped: [],
				skipped: [],
			};
		}

		const slugs = candidates
			.map((pool) => pool.labels["agents.x-k8s.io/slug"])
			.filter((slug): slug is string => Boolean(slug));
		const now = input.now ?? new Date();
		const updatedAfter = new Date(now.getTime() - input.ttlSeconds * 1000);
		const activeSlugs = new Set(
			await this.deps.agentRuntimes.listRecentlyActiveAgentSlugs({
				slugs,
				activeStatuses: ACTIVE_SESSION_STATUSES,
				updatedAfter,
			}),
		);

		const reaped: string[] = [];
		const skipped: string[] = [];
		for (const pool of candidates) {
			const slug = pool.labels["agents.x-k8s.io/slug"];
			if (!slug) continue;
			if (activeSlugs.has(slug)) {
				skipped.push(slug);
				continue;
			}
			try {
				await this.deps.warmPools.setWarmPoolReplicas(pool.name, 0, input.namespace);
				reaped.push(slug);
			} catch (err) {
				console.warn(
					`[reap-idle] scale ${pool.name} to 0 failed:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		return { namespace: input.namespace, ttlSeconds: input.ttlSeconds, reaped, skipped };
	}

	private resolveAgent(slug: string, projectId?: string | null) {
		return this.deps.agentRuntimes.getAgentBySlug({
			slug,
			projectId: projectId ?? null,
		});
	}
}

function runtimeSlugForAgent(agent: AgentRuntimeAgentRecord): string {
	const runtimeAppId = agent.runtimeAppId ?? agentRuntimeDedicatedAppId(agent.slug);
	return agentRuntimeSlugFromAppId(runtimeAppId) ?? agent.slug;
}

function phaseForWarmPool(pool: AgentRuntimeWarmPoolRecord): string {
	if (pool.desiredReplicas === 0 && pool.replicas === 0) return "Sleeping";
	if (pool.desiredReplicas > 0 && pool.readyReplicas >= pool.desiredReplicas) {
		return "Active";
	}
	if (pool.desiredReplicas > 0) return "Starting";
	return "Unknown";
}

function browserAvailability(pod: AgentRuntimePodRecord | null): {
	sidecarEnabled: boolean;
	mcpAvailable: boolean;
} {
	const containers = pod?.containers ?? [];
	const chromiumReady = containers.some(
		(container) => container.name === "chromium" && container.ready,
	);
	const mcpReady = containers.some(
		(container) => container.name === "playwright-mcp" && container.ready,
	);
	const sidecarEnabled = containers.some(
		(container) => container.name === "playwright-mcp",
	);
	return {
		sidecarEnabled,
		mcpAvailable: sidecarEnabled && chromiumReady && mcpReady,
	};
}
