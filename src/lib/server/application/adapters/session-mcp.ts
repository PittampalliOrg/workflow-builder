import type {
	SessionMcpAgentConfigReader,
	SessionMcpCredentialStatusReader,
} from "$lib/server/application/ports";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { PostgresVaultCredentialRepository } from "$lib/server/application/adapters/vault-credentials";

export class RegistrySessionMcpAgentConfigReader
	implements SessionMcpAgentConfigReader
{
	async getAgentMcpConfig(input: {
		agentId: string;
		agentVersion?: number | null;
	}) {
		const agent = await resolveAgentRef({
			id: input.agentId,
			version: input.agentVersion ?? undefined,
		});
		return agent ? { mcpServers: agent.config.mcpServers } : null;
	}
}

export class VaultSessionMcpCredentialStatusReader
	implements SessionMcpCredentialStatusReader
{
	constructor(
		private readonly credentials = new PostgresVaultCredentialRepository(),
	) {}

	async hasCredentialForMcpServer(input: {
		vaultIds: string[];
		mcpServerUrl: string;
	}) {
		return Boolean(
			await this.credentials.findCredentialForMcpServer(
				input.vaultIds,
				input.mcpServerUrl,
			),
		);
	}
}
