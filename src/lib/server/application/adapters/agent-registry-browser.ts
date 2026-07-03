import { env } from "$env/dynamic/private";
import {
	daprFetch,
	getDaprSidecarUrl,
} from "$lib/server/dapr-client";
import type {
	DaprAgentRegistryStateReader,
	DaprAgentRegistryStateReadResult,
} from "$lib/server/application/ports";

const DEFAULT_REGISTRY_STORE = "agent-registry";
const DEFAULT_REGISTRY_TEAM = "default";

export class DaprAgentRegistryStateReaderAdapter
	implements DaprAgentRegistryStateReader
{
	getRegistryStoreName(): string {
		return env.DAPR_AGENT_REGISTRY_STORE?.trim() || DEFAULT_REGISTRY_STORE;
	}

	getRegistryTeams(): string[] {
		const configured =
			env.DAPR_AGENT_REGISTRY_TEAMS ||
			env.AGENT_REGISTRY_TEAM ||
			DEFAULT_REGISTRY_TEAM;
		const teams = configured
			.split(",")
			.map((team) => team.trim())
			.filter(Boolean);

		return teams.length > 0
			? Array.from(new Set(teams))
			: [DEFAULT_REGISTRY_TEAM];
	}

	async readState(input: {
		store: string;
		key: string;
		team: string;
		partitionKey: string;
	}): Promise<DaprAgentRegistryStateReadResult> {
		const response = await daprFetch(buildStateUrl(input), { maxRetries: 1 });

		if (response.status === 204) {
			return { found: false, status: response.status };
		}

		if (!response.ok) {
			return {
				found: false,
				status: response.status,
				error: await response.text(),
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
}

function buildStateUrl(input: {
	store: string;
	key: string;
	partitionKey: string;
}): string {
	const url = new URL(
		`${getDaprSidecarUrl()}/v1.0/state/${encodeURIComponent(input.store)}/${encodeURIComponent(input.key)}`,
	);
	url.searchParams.set("consistency", "strong");
	url.searchParams.set("metadata.partitionKey", input.partitionKey);
	return url.toString();
}
