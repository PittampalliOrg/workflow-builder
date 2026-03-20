export type AgentType = "Agent" | "Durable agent";

export type DiscoveredAgent = {
	id: string; // composite: `${appId}:${name}`
	name: string;
	appId: string;
	role: string | null;
	type: AgentType;
	registered: string | null; // ISO timestamp
	updated: string | null;
	goal: string | null;
	instructions: string[] | null;
	tools: string[];
	modelClient: string | null;
	maxIterations: number | null;
	sourceApp: string; // the Dapr app ID of the service that reported this agent
	registryMetadata: Record<string, unknown> | null;
};

export type DiscoveredAgentsResponse = {
	agents: DiscoveredAgent[];
	sources: Record<string, { ok: boolean; error?: string }>;
	appIds: string[]; // unique app IDs for filter dropdown
	totalRows: number;
};
