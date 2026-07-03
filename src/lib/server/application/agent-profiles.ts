import {
	listBuiltInAgentProfiles,
	type AgentProfileSummary,
} from "$lib/server/agent-profiles";

export type AgentProfileReadPort = {
	listDatabaseAgentProfiles(): Promise<AgentProfileSummary[]>;
};

export class ApplicationAgentProfileService {
	constructor(private readonly profiles: AgentProfileReadPort) {}

	async listProfiles(): Promise<AgentProfileSummary[]> {
		const builtInProfiles = listBuiltInAgentProfiles();
		try {
			return mergeAgentProfiles(
				builtInProfiles,
				await this.profiles.listDatabaseAgentProfiles(),
			);
		} catch (err) {
			console.warn("[agent-profiles] Failed loading DB profiles, using built-ins:", err);
			return builtInProfiles;
		}
	}
}

export function mergeAgentProfiles(
	builtInProfiles: AgentProfileSummary[],
	databaseProfiles: AgentProfileSummary[],
): AgentProfileSummary[] {
	const merged = new Map<string, AgentProfileSummary>();
	for (const profile of builtInProfiles) {
		merged.set(profile.slug, profile);
	}
	for (const profile of databaseProfiles) {
		merged.set(profile.slug, profile);
	}
	return [...merged.values()];
}
