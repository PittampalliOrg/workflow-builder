import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { assertSessionInScope } from "$lib/server/sessions/scope";
import { getSession } from "$lib/server/sessions/registry";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { findCredentialForMcpServer } from "$lib/server/vaults/credentials";
import type { AgentConfig } from "$lib/types/agents";

type McpServerHealth = {
	name: string;
	url: string | null;
	authenticated: boolean;
	credentialDisplayName: string | null;
	lastUsedAt: string | null;
};

/**
 * Per-MCP-server credential health for the session. Iterates the agent's
 * declared mcp_servers, looks up a matching credential across the session's
 * attached vault_ids, and reports whether each server has valid auth.
 *
 * No Dapr event — pure internal query.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	await assertSessionInScope(params.id, locals.session);
	const session = await getSession(params.id);
	if (!session) return error(404, "Session not found");
	const agent = await resolveAgentRef({
		id: session.agentId,
		version: session.agentVersion ?? undefined,
	});
	if (!agent) return error(404, "Agent not found");

	const config = agent.config as AgentConfig;
	const servers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
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
		const cred = await findCredentialForMcpServer(session.vaultIds, url);
		out.push({
			name,
			url,
			authenticated: Boolean(cred),
			credentialDisplayName: null, // resolve returns raw; metadata hidden at this layer
			lastUsedAt: null,
		});
	}
	return json({ servers: out, vaultCount: session.vaultIds.length });
};
