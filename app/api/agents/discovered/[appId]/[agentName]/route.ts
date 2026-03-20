import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import type { DaprRuntimeIntrospection } from "@/lib/types/dapr-debug";
import type { DiscoveredAgent, AgentType } from "@/lib/types/discovered-agent";

const DURABLE_AGENT_API_BASE_URL =
	process.env.DURABLE_AGENT_API_BASE_URL ||
	"http://durable-agent.workflow-builder.svc.cluster.local:8001";
const DAPR_AGENT_RUNTIME_API_BASE_URL =
	process.env.DAPR_AGENT_RUNTIME_API_BASE_URL ||
	"http://dapr-agent-runtime.workflow-builder.svc.cluster.local:8082";
const MS_AGENT_WORKFLOW_API_BASE_URL =
	process.env.MS_AGENT_WORKFLOW_API_BASE_URL ||
	"http://ms-agent-workflow.workflow-builder.svc.cluster.local:8081";

type ServiceDef = {
	appId: string;
	baseUrl: string;
	introspectPath: string;
	toolsPath?: string;
};

const SERVICES: ServiceDef[] = [
	{
		appId: "durable-agent",
		baseUrl: DURABLE_AGENT_API_BASE_URL,
		introspectPath: "/api/runtime/introspect",
		toolsPath: "/api/tools",
	},
	{
		appId: "dapr-agent-runtime",
		baseUrl: DAPR_AGENT_RUNTIME_API_BASE_URL,
		introspectPath: "/api/runtime/introspect",
	},
	{
		appId: "ms-agent-workflow",
		baseUrl: MS_AGENT_WORKFLOW_API_BASE_URL,
		introspectPath: "/api/runtime/introspect",
	},
];

async function fetchServiceIntrospection(
	url: string,
): Promise<DaprRuntimeIntrospection> {
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
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

async function fetchTools(url: string): Promise<string[]> {
	try {
		const response = await fetch(url, {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(5000),
			cache: "no-store",
		});
		if (!response.ok) return [];
		const data = (await response.json()) as {
			tools?: Array<{ name?: string } | string>;
		};
		if (!Array.isArray(data.tools)) return [];
		return data.tools.map((t) =>
			typeof t === "string" ? t : (t.name ?? String(t)),
		);
	} catch {
		return [];
	}
}

function mapAgentType(raw: string | undefined): AgentType {
	if (!raw) return "Agent";
	const lower = raw.toLowerCase();
	if (lower.includes("durable") || lower === "durableagent")
		return "Durable agent";
	return "Agent";
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ appId: string; agentName: string }> },
) {
	const session = await getSession(request);
	const canBrowseAnonymously = allowAnonymousDaprDebug();
	if (!session?.user && !canBrowseAnonymously) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { appId, agentName: rawAgentName } = await params;
	const agentName = decodeURIComponent(rawAgentName);

	// Query all services to find the agent
	const results = await Promise.allSettled(
		SERVICES.map(async (svc) => {
			const introspection = await fetchServiceIntrospection(
				`${svc.baseUrl.replace(/\/+$/, "")}${svc.introspectPath}`,
			);

			let toolNames: string[] = [];
			if (svc.toolsPath) {
				toolNames = await fetchTools(
					`${svc.baseUrl.replace(/\/+$/, "")}${svc.toolsPath}`,
				);
			}

			if (toolNames.length === 0 && introspection.additional) {
				const additionalTools = (
					introspection.additional as Record<string, unknown>
				).toolNames;
				if (Array.isArray(additionalTools)) {
					toolNames = additionalTools.map(String);
				}
			}

			return { svc, introspection, toolNames };
		}),
	);

	for (const result of results) {
		if (result.status === "rejected") continue;

		const { svc, introspection, toolNames } = result.value;
		const registeredAgents = introspection.registry?.registeredAgents ?? [];

		for (const entry of registeredAgents) {
			const entryAppId =
				((entry.metadata?.agent as Record<string, unknown> | undefined)
					?.appid as string | undefined) ?? svc.appId;

			if (entryAppId === appId && entry.name === agentName) {
				const agentMeta = (entry.metadata.agent ?? {}) as Record<
					string,
					unknown
				>;

				const agent: DiscoveredAgent = {
					id: `${appId}:${agentName}`,
					name: agentName,
					appId,
					role: agentMeta.role ? String(agentMeta.role) : null,
					type: mapAgentType(agentMeta.type as string | undefined),
					registered: entry.metadata.registered_at
						? String(entry.metadata.registered_at)
						: entry.metadata.registeredAt
							? String(entry.metadata.registeredAt)
							: null,
					updated: entry.metadata.updated_at
						? String(entry.metadata.updated_at)
						: entry.metadata.updatedAt
							? String(entry.metadata.updatedAt)
							: null,
					goal: agentMeta.goal ? String(agentMeta.goal) : null,
					instructions: agentMeta.instructions
						? Array.isArray(agentMeta.instructions)
							? (agentMeta.instructions as string[])
							: String(agentMeta.instructions).split("\n").filter(Boolean)
						: null,
					tools: toolNames,
					modelClient: agentMeta.model_client
						? String(agentMeta.model_client)
						: agentMeta.modelClient
							? String(agentMeta.modelClient)
							: null,
					maxIterations: agentMeta.max_iterations
						? Number(agentMeta.max_iterations)
						: agentMeta.maxIterations
							? Number(agentMeta.maxIterations)
							: null,
					sourceApp: svc.appId,
					registryMetadata: entry.metadata,
				};

				return NextResponse.json(agent, {
					headers: { "Cache-Control": "no-store" },
				});
			}
		}
	}

	return NextResponse.json(
		{ error: `Agent "${agentName}" not found in app "${appId}"` },
		{ status: 404 },
	);
}
