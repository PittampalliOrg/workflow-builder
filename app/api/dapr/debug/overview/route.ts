import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import { daprDashboardClient } from "@/lib/dapr/dashboard-client";
import { genericOrchestratorClient } from "@/lib/dapr-client";
import { db } from "@/lib/db";
import { agents } from "@/lib/db/schema";
import { getWorkflowOrchestratorUrl } from "@/lib/config-service";
import type {
	DaprDebugOverviewResponse,
	DaprDebugRecentRun,
	DaprDashboardInstance,
	DaprRuntimeIntrospection,
} from "@/lib/types/dapr-debug";

const DAPR_AGENT_RUNTIME_API_BASE_URL =
	process.env.DAPR_AGENT_RUNTIME_API_BASE_URL ||
	"http://dapr-agent-runtime.workflow-builder.svc.cluster.local:8082";
const MS_AGENT_WORKFLOW_API_BASE_URL =
	process.env.MS_AGENT_WORKFLOW_API_BASE_URL ||
	"http://ms-agent-workflow.workflow-builder.svc.cluster.local:8081";

function buildErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function fetchServiceIntrospection(
	url: string,
): Promise<DaprRuntimeIntrospection> {
	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(5000),
		cache: "no-store",
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
		);
	}

	return (await response.json()) as DaprRuntimeIntrospection;
}

function toRecentRun(
	item: Awaited<
		ReturnType<typeof genericOrchestratorClient.listWorkflows>
	>["workflows"][number],
): DaprDebugRecentRun {
	return {
		instanceId: item.instanceId,
		workflowId: item.workflowId,
		workflowName: item.workflowName || undefined,
		workflowVersion: item.workflowVersion ?? null,
		workflowNameVersioned: item.workflowNameVersioned ?? null,
		runtimeStatus: item.runtimeStatus,
		phase: item.phase,
		progress: item.progress ?? 0,
		message: item.message || undefined,
		currentNodeName: item.currentNodeName || null,
		startedAt: item.startedAt,
		completedAt: item.completedAt || null,
	};
}

function uniqueRuntimeRegistryAgents(
	introspections: Array<{
		appId: string;
		data: DaprRuntimeIntrospection | null;
	}>,
): DaprDebugOverviewResponse["agents"]["runtimeRegistry"] {
	const seen = new Set<string>();
	const entries = introspections.flatMap(({ appId, data }) =>
		(data?.registry?.registeredAgents ?? []).map((entry) => ({
			name: entry.name,
			metadata: entry.metadata,
			sourceApp: appId,
		})),
	);
	return entries.filter((entry) => {
		const key = `${entry.sourceApp}:${entry.name}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function uniquePublishedCapabilities(
	introspections: Array<{
		appId: string;
		data: DaprRuntimeIntrospection | null;
	}>,
): NonNullable<DaprDebugOverviewResponse["agents"]["publishedCapabilities"]> {
	const seen = new Set<string>();
	const entries: NonNullable<
		DaprDebugOverviewResponse["agents"]["publishedCapabilities"]
	> = [];
	for (const { appId, data } of introspections) {
		if (Array.isArray(data?.profiles)) {
			for (const profile of data.profiles) {
				entries.push({
					name: profile,
					metadata: {
						profile,
						toolGroup: data.profileToolGroups?.[profile] ?? null,
						service: data.service,
						runtime: data.runtime,
						source: "profiles",
						runtimeConfigEnabled: data.runtimeConfig?.enabled ?? false,
					},
					sourceApp: appId,
				});
			}
			continue;
		}
		if (Array.isArray(data?.templates)) {
			for (const template of data.templates) {
				entries.push({
					name: template.label || template.id,
					metadata: {
						templateId: template.id,
						description: template.description || null,
						defaultToolGroup: template.defaultToolGroup ?? null,
						supportsTools: template.supportsTools ?? false,
						service: data.service,
						runtime: data.runtime,
						source: "templates",
					},
					sourceApp: appId,
				});
			}
		}
	}
	return entries.filter((entry) => {
		const key = `${entry.sourceApp}:${entry.name}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

export async function GET(request: Request) {
	const session = await getSession(request);
	const canBrowseAnonymously = allowAnonymousDaprDebug();
	if (!session?.user && !canBrowseAnonymously) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const response: DaprDebugOverviewResponse = {
		sources: {
			dashboard: { ok: false, error: "Dashboard not queried" },
			workflowOrchestrator: {
				ok: false,
				error: "Workflow orchestrator not queried",
			},
			daprAgentRuntime: {
				ok: false,
				error: "Dapr agent runtime not queried",
			},
			msAgentWorkflow: { ok: false, error: "MS agent workflow not queried" },
			applicationAgents: { ok: false, error: "Application agents not queried" },
		},
		dashboard: {
			platform: "unknown",
			scopes: [],
			controlPlane: [],
		},
		instances: [],
		components: [],
		configurations: [],
		workflowRuntime: {
			orchestrator: null,
			daprAgentRuntime: null,
			msAgentWorkflow: null,
			recentRuns: [],
		},
		agents: {
			application: [],
			runtimeRegistry: [],
			publishedCapabilities: [],
		},
	};

	let instances: DaprDashboardInstance[] = [];

	try {
		const dashboardBaseUrl = await daprDashboardClient.resolveBaseUrl();
		response.dashboard.baseUrl = dashboardBaseUrl;
		const [platform, scopes, controlPlane, dashboardInstances, components] =
			await Promise.all([
				daprDashboardClient.getPlatform(dashboardBaseUrl),
				daprDashboardClient.getScopes(dashboardBaseUrl),
				daprDashboardClient.getControlPlane(dashboardBaseUrl),
				daprDashboardClient.getInstances("workflow-builder", dashboardBaseUrl),
				daprDashboardClient.getComponents("workflow-builder", dashboardBaseUrl),
			]);

		instances = dashboardInstances;
		response.sources.dashboard = { ok: true };
		response.dashboard.platform = platform;
		response.dashboard.scopes = scopes;
		response.dashboard.controlPlane = controlPlane;
		response.instances = dashboardInstances;
		response.components = components;

		try {
			response.configurations = await daprDashboardClient.getConfigurations(
				"workflow-builder",
				dashboardBaseUrl,
			);
		} catch {
			response.configurations = [];
		}
	} catch (error) {
		response.sources.dashboard = {
			ok: false,
			error: buildErrorMessage(error),
		};
	}

	try {
		const agentQuery = db
			.select({
				id: agents.id,
				name: agents.name,
				agentType: agents.agentType,
				model: agents.model,
				isEnabled: agents.isEnabled,
				updatedAt: agents.updatedAt,
			})
			.from(agents)
			.orderBy(desc(agents.updatedAt));
		const rows = session?.user
			? await agentQuery.where(eq(agents.userId, session.user.id))
			: await agentQuery.limit(50);

		response.agents.application = rows.map((row) => ({
			id: row.id,
			name: row.name,
			agentType: row.agentType,
			model:
				row.model && typeof row.model === "object"
					? {
							provider: String(
								(row.model as Record<string, unknown>).provider || "unknown",
							),
							name: String(
								(row.model as Record<string, unknown>).name || "unknown",
							),
						}
					: {
							provider: "unknown",
							name: "unknown",
						},
			isEnabled: row.isEnabled,
			updatedAt: row.updatedAt.toISOString(),
		}));
		response.sources.applicationAgents = { ok: true };
	} catch (error) {
		response.sources.applicationAgents = {
			ok: false,
			error: buildErrorMessage(error),
		};
	}

	const runtimeRegistryInputs: Array<{
		appId: string;
		data: DaprRuntimeIntrospection | null;
	}> = [];

	try {
		const orchestratorUrl = await getWorkflowOrchestratorUrl();
		const [introspection, runs] = await Promise.all([
			fetchServiceIntrospection(
				`${orchestratorUrl.replace(/\/+$/, "")}/api/v2/runtime/introspect`,
			),
			genericOrchestratorClient.listWorkflows(orchestratorUrl, {
				limit: 25,
				offset: 0,
			}),
		]);
		response.workflowRuntime.orchestrator = introspection;
		response.workflowRuntime.recentRuns = runs.workflows.map(toRecentRun);
		response.sources.workflowOrchestrator = { ok: true };
		runtimeRegistryInputs.push({
			appId: "workflow-orchestrator",
			data: introspection,
		});
	} catch (error) {
		response.sources.workflowOrchestrator = {
			ok: false,
			error: buildErrorMessage(error),
		};
	}

	try {
		const introspection = await fetchServiceIntrospection(
			`${DAPR_AGENT_RUNTIME_API_BASE_URL.replace(/\/+$/, "")}/api/runtime/introspect`,
		);
		response.workflowRuntime.daprAgentRuntime = introspection;
		response.sources.daprAgentRuntime = { ok: true };
		runtimeRegistryInputs.push({
			appId: "dapr-agent-runtime",
			data: introspection,
		});
	} catch (error) {
		response.sources.daprAgentRuntime = {
			ok: false,
			error: buildErrorMessage(error),
		};
	}

	try {
		const introspection = await fetchServiceIntrospection(
			`${MS_AGENT_WORKFLOW_API_BASE_URL.replace(/\/+$/, "")}/api/runtime/introspect`,
		);
		response.workflowRuntime.msAgentWorkflow = introspection;
		response.sources.msAgentWorkflow = { ok: true };
		runtimeRegistryInputs.push({
			appId: "ms-agent-workflow",
			data: introspection,
		});
	} catch (error) {
		response.sources.msAgentWorkflow = {
			ok: false,
			error: buildErrorMessage(error),
		};
	}

	response.agents.runtimeRegistry = uniqueRuntimeRegistryAgents(
		runtimeRegistryInputs,
	);
	response.agents.publishedCapabilities = uniquePublishedCapabilities(
		runtimeRegistryInputs,
	);

	if (instances.length > 0) {
		const allowed = new Set([
			"workflow-builder",
			"workflow-orchestrator",
			"dapr-agent-runtime",
			"ms-agent-workflow",
		]);
		response.instances = instances.filter((instance) =>
			allowed.has(instance.appId),
		);
	}

	return NextResponse.json(response, {
		headers: {
			"Cache-Control": "no-store",
		},
	});
}
