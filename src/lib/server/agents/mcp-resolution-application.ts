import { getApplicationAdapters } from "$lib/server/application";
import type { McpServerProfileConfig } from "$lib/server/agent-profiles";
import type { AgentConfig } from "$lib/types/agents";
import {
	shouldIncludeProjectConnectionsForMcpResolution,
	type AgentMcpResolutionOptions,
	type AgentMcpResolutionResult,
} from "$lib/server/agents/mcp-resolution";

function hasDirectEndpoint(server: Record<string, unknown>): boolean {
	return Boolean(
		String(server.url || server.serverUrl || "").trim() ||
			String(server.command || "").trim(),
	);
}

export async function resolveAgentMcpServersForProject(input: {
	projectId?: string | null;
	requestedServers?: McpServerProfileConfig[];
	includeProjectConnections?: boolean;
}): Promise<AgentMcpResolutionResult> {
	return getApplicationAdapters().workflowData.resolveMcpConfig({
		projectId: input.projectId,
		requestedServers: input.requestedServers,
		includeProjectConnections: input.includeProjectConnections,
	});
}

export async function resolveAgentConfigMcpForProject(
	config: AgentConfig,
	projectId?: string | null,
	options: AgentMcpResolutionOptions = {},
): Promise<AgentConfig> {
	const requestedServers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
	const includeProjectConnections =
		shouldIncludeProjectConnectionsForMcpResolution(config, options);
	const hasUnresolvedServers = requestedServers.some((server) => !hasDirectEndpoint(server));
	if (!includeProjectConnections && requestedServers.length === 0 && !hasUnresolvedServers) {
		return config;
	}

	const resolved = await resolveAgentMcpServersForProject({
		projectId,
		requestedServers,
		includeProjectConnections,
	});
	return {
		...config,
		mcpServers: resolved.mcpServers,
		...(resolved.warnings.length > 0
			? ({ mcpConnectionWarnings: resolved.warnings } as Partial<AgentConfig>)
			: {}),
	};
}
