import type {
	SessionMcpAgentConfigReader,
	SessionMcpCredentialStatusReader,
	WorkflowDataService,
} from "$lib/server/application/ports";

export type McpServerHealth = {
	name: string;
	url: string | null;
	authenticated: boolean;
	credentialDisplayName: string | null;
	lastUsedAt: string | null;
};

export type SessionMcpStatusInput = {
	sessionId: string;
	userId: string;
	projectId?: string | null;
};

export type SessionMcpStatusResult =
	| {
			status: "ok";
			body: {
				servers: McpServerHealth[];
				vaultCount: number;
			};
	  }
	| { status: "not_found"; message: string };

export class ApplicationSessionMcpStatusService {
	constructor(
		private readonly deps: {
			workflowData: Pick<WorkflowDataService, "getSessionEventStreamSnapshot">;
			agentConfigs: SessionMcpAgentConfigReader;
			credentials: SessionMcpCredentialStatusReader;
		},
	) {}

	async getStatus(input: SessionMcpStatusInput): Promise<SessionMcpStatusResult> {
		const session = await this.deps.workflowData.getSessionEventStreamSnapshot({
			sessionId: input.sessionId,
			projectId: input.projectId ?? null,
			userId: input.userId,
		});
		if (!session) return { status: "not_found", message: "Session not found" };

		const agentConfig = await this.deps.agentConfigs.getAgentMcpConfig({
			agentId: session.agentId,
			agentVersion: session.agentVersion ?? null,
		});
		if (!agentConfig) return { status: "not_found", message: "Agent not found" };

		const servers = Array.isArray(agentConfig.mcpServers)
			? agentConfig.mcpServers
			: [];
		const out: McpServerHealth[] = [];
		for (const server of servers) {
			const name =
				server.server_name ??
				server.serverName ??
				server.name ??
				server.displayName ??
				"(unnamed)";
			const url = server.url ?? server.serverUrl ?? null;
			if (!url) {
				out.push({
					name,
					url: null,
					authenticated: false,
					credentialDisplayName: null,
					lastUsedAt: null,
				});
				continue;
			}
			out.push({
				name,
				url,
				authenticated: await this.deps.credentials.hasCredentialForMcpServer({
					vaultIds: session.vaultIds,
					mcpServerUrl: url,
				}),
				credentialDisplayName: null,
				lastUsedAt: null,
			});
		}

		return {
			status: "ok",
			body: { servers: out, vaultCount: session.vaultIds.length },
		};
	}
}
