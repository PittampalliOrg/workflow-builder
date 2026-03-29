import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { allowAnonymousDaprDebug } from "@/lib/dapr/debug-access";
import type { DaprRuntimeIntrospection } from "@/lib/types/dapr-debug";
import type {
	DiscoveredAgent,
	DiscoveredAgentsResponse,
	AgentType,
} from "@/lib/types/discovered-agent";

const DURABLE_AGENT_API_BASE_URL =
	process.env.DURABLE_AGENT_API_BASE_URL ||
	"http://durable-agent.workflow-builder.svc.cluster.local:8001";

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

function registryEntryToDiscoveredAgent(
	name: string,
	metadata: Record<string, unknown>,
	sourceApp: string,
	toolNames: string[],
): DiscoveredAgent {
	const agentMeta = (metadata.agent ?? {}) as Record<string, unknown>;
	const appId = String(agentMeta.appid ?? sourceApp);

	return {
		id: `${appId}:${name}`,
		name,
		appId,
		role: agentMeta.role ? String(agentMeta.role) : null,
		type: mapAgentType(agentMeta.type as string | undefined),
		registered: metadata.registered_at
			? String(metadata.registered_at)
			: metadata.registeredAt
				? String(metadata.registeredAt)
				: null,
		updated: metadata.updated_at
			? String(metadata.updated_at)
			: metadata.updatedAt
				? String(metadata.updatedAt)
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
		sourceApp,
		registryMetadata: metadata,
	};
}

export async function GET(request: Request) {
	const session = await getSession(request);
	const canBrowseAnonymously = allowAnonymousDaprDebug();
	if (!session?.user && !canBrowseAnonymously) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const url = new URL(request.url);
	const search = url.searchParams.get("search")?.toLowerCase() ?? "";
	const filterAppId = url.searchParams.get("appId") ?? "";
	const filterType = url.searchParams.get("type") ?? "";

	const sources: Record<string, { ok: boolean; error?: string }> = {};
	const seen = new Set<string>();
	const allAgents: DiscoveredAgent[] = [];
	const appIdSet = new Set<string>();

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

			// Also try to get tool names from introspection additional.toolNames
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
		if (result.status === "rejected") {
			continue;
		}

		const { svc, introspection, toolNames } = result.value;
		sources[svc.appId] = { ok: true };

		const registeredAgents = introspection.registry?.registeredAgents ?? [];
		for (const entry of registeredAgents) {
			const key = `${svc.appId}:${entry.name}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const agent = registryEntryToDiscoveredAgent(
				entry.name,
				entry.metadata,
				svc.appId,
				toolNames,
			);
			appIdSet.add(agent.appId);
			allAgents.push(agent);
		}
	}

	// Mark failed services
	for (const svc of SERVICES) {
		if (!sources[svc.appId]) {
			const result = results.find(
				(r) => r.status === "fulfilled" && r.value.svc.appId === svc.appId,
			);
			if (!result) {
				sources[svc.appId] = {
					ok: false,
					error: `Service ${svc.appId} unreachable`,
				};
			}
		}
	}

	// Apply filters
	let filtered = allAgents;

	if (search) {
		filtered = filtered.filter(
			(a) =>
				a.name.toLowerCase().includes(search) ||
				(a.role?.toLowerCase().includes(search) ?? false) ||
				a.appId.toLowerCase().includes(search),
		);
	}

	if (filterAppId) {
		filtered = filtered.filter((a) => a.appId === filterAppId);
	}

	if (filterType) {
		filtered = filtered.filter((a) => a.type === filterType);
	}

	const response: DiscoveredAgentsResponse = {
		agents: filtered,
		sources,
		appIds: Array.from(appIdSet).sort(),
		totalRows: filtered.length,
	};

	return NextResponse.json(response, {
		headers: { "Cache-Control": "no-store" },
	});
}
