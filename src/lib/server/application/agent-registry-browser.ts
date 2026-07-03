import type { DaprAgentRegistryStateReader } from "$lib/server/application/ports";

type JsonRecord = Record<string, unknown>;

export type DaprRegistryAgent = {
	id: string;
	name: string;
	team: string;
	registryStore: string;
	registryKey: string;
	schemaVersion: string | null;
	registeredAt: string | null;
	appId: string | null;
	type: string | null;
	framework: string | null;
	role: string | null;
	goal: string | null;
	instructions: string[];
	systemPrompt: string | null;
	maxIterations: number | null;
	toolChoice: string | null;
	orchestrator: boolean;
	pubsub: JsonRecord | null;
	memory: JsonRecord | null;
	llm: JsonRecord | null;
	tools: JsonRecord[];
	metadata: JsonRecord | null;
	raw: JsonRecord;
};

export type DaprAgentRegistryBrowserReadModel = {
	source: "dapr-agent-registry";
	storeName: string;
	teams: string[];
	agents: DaprRegistryAgent[];
	diagnostics: string[];
};

export class ApplicationAgentRegistryBrowserService {
	constructor(private readonly deps: { registryState: DaprAgentRegistryStateReader }) {}

	async listRegistryAgents(): Promise<DaprAgentRegistryBrowserReadModel> {
		const store = this.deps.registryState.getRegistryStoreName();
		const teams = this.deps.registryState.getRegistryTeams();
		const diagnostics: string[] = [];
		const agents: DaprRegistryAgent[] = [];

		for (const team of teams) {
			try {
				const result = await this.loadTeamAgents(store, team);
				agents.push(...result.agents);
				diagnostics.push(...result.diagnostics);
			} catch (error) {
				diagnostics.push(
					`Failed reading Dapr agent registry team ${team}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		return {
			source: "dapr-agent-registry",
			storeName: store,
			teams,
			agents,
			diagnostics,
		};
	}

	private async loadTeamAgents(store: string, team: string) {
		const diagnostics: string[] = [];
		const indexKey = registryIndexKey(team);
		const index = await this.readState(store, indexKey, team);

		if (!index.found) {
			const suffix = index.error ? `: ${index.error}` : "";
			diagnostics.push(
				`No Dapr agent registry index found at ${store}/${indexKey}${suffix}`,
			);
			return { agents: [] as DaprRegistryAgent[], diagnostics };
		}

		const indexRecord = asRecord(index.value);
		const agentNames = asStringArray(indexRecord?.agents);

		if (agentNames.length === 0) {
			diagnostics.push(
				`Dapr agent registry index ${store}/${indexKey} has no agent entries`,
			);
			return { agents: [] as DaprRegistryAgent[], diagnostics };
		}

		const agents: DaprRegistryAgent[] = [];
		const uniqueAgentNames = Array.from(new Set(agentNames)).sort((a, b) =>
			a.localeCompare(b),
		);

		for (const agentName of uniqueAgentNames) {
			const key = agentRegistryKey(team, agentName);
			const state = await this.readState(store, key, team);

			if (!state.found) {
				const suffix = state.error ? `: ${state.error}` : "";
				diagnostics.push(
					`Registry index references missing agent key ${store}/${key}${suffix}`,
				);
				continue;
			}

			const record = asRecord(state.value);
			if (!record) {
				diagnostics.push(`Agent key ${store}/${key} is not a JSON object`);
				continue;
			}

			agents.push(normalizeAgent(record, agentName, team, store));
		}

		return { agents, diagnostics };
	}

	private readState(store: string, key: string, team: string) {
		return this.deps.registryState.readState({
			store,
			key,
			team,
			partitionKey: teamRegistryKey(team),
		});
	}
}

function teamRegistryKey(team: string): string {
	return `agents:${team}`;
}

function registryIndexKey(team: string): string {
	return `${teamRegistryKey(team)}:_index`;
}

function agentRegistryKey(team: string, agentName: string): string {
	return `${teamRegistryKey(team)}:${agentName}`;
}

function asRecord(value: unknown): JsonRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as JsonRecord;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is string => typeof item === "string" && item.trim().length > 0,
	);
}

function asRecordArray(value: unknown): JsonRecord[] {
	if (!Array.isArray(value)) return [];
	return value.map(asRecord).filter((item): item is JsonRecord => item !== null);
}

function normalizeAgent(
	record: JsonRecord,
	name: string,
	team: string,
	store: string,
): DaprRegistryAgent {
	const agent = asRecord(record.agent) ?? {};
	const metadata = asRecord(agent.metadata);

	return {
		id: `${team}:${name}`,
		name: asString(record.name) ?? name,
		team,
		registryStore: store,
		registryKey: agentRegistryKey(team, name),
		schemaVersion: asString(record.version),
		registeredAt: asString(record.registered_at),
		appId: asString(agent.appid),
		type: asString(agent.type),
		framework: asString(agent.framework),
		role: asString(agent.role),
		goal: asString(agent.goal),
		instructions: asStringArray(agent.instructions),
		systemPrompt: asString(agent.system_prompt),
		maxIterations: asNumber(agent.max_iterations),
		toolChoice: asString(agent.tool_choice),
		orchestrator: agent.orchestrator === true,
		pubsub: asRecord(record.pubsub),
		memory: asRecord(record.memory),
		llm: asRecord(record.llm),
		tools: asRecordArray(record.tools),
		metadata,
		raw: record,
	};
}
