import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getDaprSidecarUrl } from '$lib/server/dapr-client';

type JsonRecord = Record<string, unknown>;

type StateReadResult = {
	found: boolean;
	value?: unknown;
	status?: number;
	error?: string;
};

type RegistryAgent = {
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

const DEFAULT_REGISTRY_STORE = 'agent-registry';
const DEFAULT_REGISTRY_TEAM = 'default';

function registryStore(): string {
	return env.DAPR_AGENT_REGISTRY_STORE?.trim() || DEFAULT_REGISTRY_STORE;
}

function registryTeams(): string[] {
	const configured = env.DAPR_AGENT_REGISTRY_TEAMS || env.AGENT_REGISTRY_TEAM || DEFAULT_REGISTRY_TEAM;
	const teams = configured
		.split(',')
		.map((team) => team.trim())
		.filter(Boolean);

	return teams.length > 0 ? Array.from(new Set(teams)) : [DEFAULT_REGISTRY_TEAM];
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
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as JsonRecord;
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function asRecordArray(value: unknown): JsonRecord[] {
	if (!Array.isArray(value)) return [];
	return value.map(asRecord).filter((item): item is JsonRecord => item !== null);
}

function buildStateUrl(store: string, key: string, team: string): string {
	const url = new URL(
		`${getDaprSidecarUrl()}/v1.0/state/${encodeURIComponent(store)}/${encodeURIComponent(key)}`
	);
	url.searchParams.set('consistency', 'strong');
	url.searchParams.set('metadata.partitionKey', teamRegistryKey(team));
	return url.toString();
}

async function readState(store: string, key: string, team: string): Promise<StateReadResult> {
	const response = await daprFetch(buildStateUrl(store, key, team), { maxRetries: 1 });

	if (response.status === 204) {
		return { found: false, status: response.status };
	}

	if (!response.ok) {
		return {
			found: false,
			status: response.status,
			error: await response.text()
		};
	}

	const text = await response.text();
	if (!text.trim()) {
		return { found: false, status: response.status };
	}

	try {
		return { found: true, status: response.status, value: JSON.parse(text) };
	} catch {
		return { found: true, status: response.status, value: text };
	}
}

function normalizeAgent(
	record: JsonRecord,
	name: string,
	team: string,
	store: string
): RegistryAgent {
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
		raw: record
	};
}

async function loadTeamAgents(store: string, team: string) {
	const diagnostics: string[] = [];
	const indexKey = registryIndexKey(team);
	const index = await readState(store, indexKey, team);

	if (!index.found) {
		const suffix = index.error ? `: ${index.error}` : '';
		diagnostics.push(`No Dapr agent registry index found at ${store}/${indexKey}${suffix}`);
		return { agents: [] as RegistryAgent[], diagnostics };
	}

	const indexRecord = asRecord(index.value);
	const agentNames = asStringArray(indexRecord?.agents);

	if (agentNames.length === 0) {
		diagnostics.push(`Dapr agent registry index ${store}/${indexKey} has no agent entries`);
		return { agents: [] as RegistryAgent[], diagnostics };
	}

	const agents: RegistryAgent[] = [];
	const uniqueAgentNames = Array.from(new Set(agentNames)).sort((a, b) => a.localeCompare(b));

	for (const agentName of uniqueAgentNames) {
		const key = agentRegistryKey(team, agentName);
		const state = await readState(store, key, team);

		if (!state.found) {
			const suffix = state.error ? `: ${state.error}` : '';
			diagnostics.push(`Registry index references missing agent key ${store}/${key}${suffix}`);
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

/**
 * GET /api/agents
 *
 * List Dapr Agents from the Dapr Agent Registry state component. This intentionally
 * does not read workflow-builder database tables.
 */
export const GET: RequestHandler = async () => {
	const store = registryStore();
	const teams = registryTeams();
	const diagnostics: string[] = [];
	const agents: RegistryAgent[] = [];

	for (const team of teams) {
		try {
			const result = await loadTeamAgents(store, team);
			agents.push(...result.agents);
			diagnostics.push(...result.diagnostics);
		} catch (error) {
			diagnostics.push(
				`Failed reading Dapr agent registry team ${team}: ${
					error instanceof Error ? error.message : String(error)
				}`
			);
		}
	}

	return json({
		source: 'dapr-agent-registry',
		storeName: store,
		teams,
		agents,
		diagnostics
	});
};
