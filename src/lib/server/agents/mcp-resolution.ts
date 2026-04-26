import { and, asc, eq } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import { getPopulatedMcpServerByProjectId } from "$lib/server/db/mcp";
import { mcpConnections, type McpConnectionSourceType } from "$lib/server/db/schema";
import type { McpServerProfileConfig } from "$lib/server/agent-profiles";
import type { AgentConfig } from "$lib/types/agents";

type AgentMcpConnectionRow = {
	id: string;
	projectId: string;
	sourceType: McpConnectionSourceType;
	pieceName: string | null;
	serverKey: string | null;
	connectionExternalId: string | null;
	displayName: string;
	registryRef: string | null;
	serverUrl: string | null;
	metadata: Record<string, unknown> | null;
};

export type AgentMcpResolutionResult = {
	mcpServers: McpServerProfileConfig[];
	warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMcpName(value: unknown): string {
	let text = String(value || "")
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, "")
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!text) text = "mcp_server";
	if (!/^[a-z_]/.test(text)) text = `mcp_${text}`;
	return text.slice(0, 48);
}

function transportFromMetadata(metadata: Record<string, unknown>): McpServerProfileConfig["transport"] {
	const raw = String(metadata.transport ?? metadata.transportType ?? "")
		.trim()
		.toLowerCase()
		.replace("-", "_");
	if (raw === "streamable_http" || raw === "sse" || raw === "stdio" || raw === "websocket") {
		return raw;
	}
	return "streamable_http";
}

function allowedToolsFrom(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function serverIdentityValues(server: Record<string, unknown>): Set<string> {
	const values = new Set<string>();
	for (const key of [
		"server_name",
		"serverName",
		"name",
		"pieceName",
		"serverKey",
		"displayName",
	]) {
		const value = String(server[key] || "").trim();
		if (!value) continue;
		values.add(value.toLowerCase());
		values.add(normalizeMcpName(value));
	}
	const pieceName = String(server.pieceName || "").trim();
	if (pieceName) values.add(normalizeMcpName(`piece_${pieceName}`));
	const serverKey = String(server.serverKey || "").trim();
	if (serverKey) {
		values.add(normalizeMcpName(`custom_${serverKey}`));
		values.add(normalizeMcpName(`shared_${serverKey}`));
	}
	return values;
}

function hasDirectEndpoint(server: Record<string, unknown>): boolean {
	return Boolean(
		String(server.url || server.serverUrl || "").trim() ||
			String(server.command || "").trim(),
	);
}

function isShortK8sHost(hostname: string): boolean {
	if (!hostname || hostname.includes(".")) return false;
	if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;
	return /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(hostname);
}

function shouldQualifyMcpUrl(server: Record<string, unknown>): boolean {
	const sourceType = String(server.sourceType || server.source_type || "");
	if (sourceType === "nimble_piece" || sourceType === "nimble_shared" || sourceType === "hosted_workflow") {
		return true;
	}
	const registryRef = String(server.registryRef || server.registry_ref || "");
	return (
		registryRef.startsWith("ap-") ||
		registryRef.startsWith("nimble-") ||
		registryRef.startsWith("shared-") ||
		registryRef === "mcp-gateway" ||
		registryRef === "shared-workflow-mcp-server"
	);
}

function qualifyMcpServerUrl(server: Record<string, unknown>, rawUrl: string): string {
	const text = rawUrl.trim();
	if (!text || !shouldQualifyMcpUrl(server)) return text;
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return text;
	}
	if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return text;
	if (!isShortK8sHost(parsed.hostname)) return text;

	const namespace = String(
		server.namespace ||
			env.MCP_CONNECTION_NAMESPACE ||
			env.WORKFLOW_BUILDER_NAMESPACE ||
			"workflow-builder",
	).trim();
	parsed.hostname = `${parsed.hostname}.${namespace}.svc.cluster.local`;
	return parsed.toString();
}

function hostedMcpGatewayUrl(
	projectId: string,
	metadata: Record<string, unknown>,
	fallbackUrl: string,
): string {
	const endpointPath = String(
		metadata.endpointPath || "/api/v1/projects/:projectId/mcp-server/http",
	);
	const path = endpointPath.replace(":projectId", encodeURIComponent(projectId));
	const base = (
		env.MCP_GATEWAY_INTERNAL_BASE_URL ||
		"http://mcp-gateway.workflow-builder.svc.cluster.local:8080"
	).replace(/\/+$/, "");
	return `${base}${path.startsWith("/") ? path : `/${path}`}` || fallbackUrl;
}

function sanitizeRequestedServer(server: McpServerProfileConfig): McpServerProfileConfig {
	const sanitized: McpServerProfileConfig = { ...server };
	if (sanitized.serverUrl && !sanitized.url) sanitized.url = sanitized.serverUrl;
	if (sanitized.url) sanitized.url = qualifyMcpServerUrl(sanitized, sanitized.url);
	if (sanitized.serverUrl) sanitized.serverUrl = qualifyMcpServerUrl(sanitized, sanitized.serverUrl);
	const allowedTools = allowedToolsFrom(server.allowedTools ?? (server as Record<string, unknown>).allowed_tools);
	if (allowedTools.length) sanitized.allowedTools = allowedTools;
	return sanitized;
}

function mergeRequestedOverResolved(
	resolved: McpServerProfileConfig,
	requested: McpServerProfileConfig,
): McpServerProfileConfig {
	const merged: McpServerProfileConfig = { ...resolved };
	for (const key of ["displayName", "sourceType", "pieceName", "serverKey"] as const) {
		if (requested[key]) merged[key] = requested[key] as never;
	}
	const allowedTools = allowedToolsFrom(
		requested.allowedTools ?? (requested as Record<string, unknown>).allowed_tools,
	);
	if (allowedTools.length) merged.allowedTools = allowedTools;
	return merged;
}

function buildServerConfig(
	row: AgentMcpConnectionRow,
	hostedToken: string | null,
): { config: McpServerProfileConfig | null; warning: string | null } {
	const metadata = isRecord(row.metadata) ? row.metadata : {};
	const displayName = row.displayName || "MCP Server";

	if (row.sourceType === "hosted_workflow") {
		if (!row.projectId) {
			return {
				config: null,
				warning: `Skipped hosted MCP connection '${displayName}' because it has no project id.`,
			};
		}
		if (!hostedToken) {
			return {
				config: null,
				warning: `Skipped hosted MCP connection '${displayName}' because its bearer token could not be resolved.`,
			};
		}
		const serverName = normalizeMcpName(`hosted_${row.serverKey || displayName || row.id}`);
		return {
			config: {
				server_name: serverName,
				name: serverName,
				displayName,
				sourceType: row.sourceType,
				transport: transportFromMetadata(metadata),
				url: hostedMcpGatewayUrl(row.projectId, metadata, row.serverUrl || ""),
				headers: { Authorization: `Bearer ${hostedToken}` },
			},
			warning: null,
		};
	}

	const serverUrl = row.serverUrl?.trim() || "";
	if (!serverUrl) {
		return {
			config: null,
			warning: `Skipped MCP connection '${displayName}' because it has no server URL.`,
		};
	}
	if (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) {
		return {
			config: null,
			warning: `Skipped MCP connection '${displayName}' because its URL must be HTTP(S).`,
		};
	}

	let serverName = normalizeMcpName(row.pieceName || row.serverKey || displayName || row.id);
	if (row.sourceType === "nimble_piece") serverName = normalizeMcpName(`piece_${serverName}`);
	else if (row.sourceType === "nimble_shared") serverName = normalizeMcpName(`shared_${serverName}`);
	else if (row.sourceType === "custom_url") serverName = normalizeMcpName(`custom_${serverName}`);

	const config: McpServerProfileConfig = {
		server_name: serverName,
		name: serverName,
		displayName,
		sourceType: row.sourceType,
		pieceName: row.pieceName,
		serverKey: row.serverKey,
		connectionExternalId: row.connectionExternalId || null,
		transport: transportFromMetadata(metadata),
		url: qualifyMcpServerUrl(
			{ sourceType: row.sourceType, registryRef: row.registryRef },
			serverUrl,
		),
	};
	if (row.connectionExternalId) {
		config.headers = { "X-Connection-External-Id": row.connectionExternalId };
	}
	const allowedTools = allowedToolsFrom(metadata.allowedTools ?? metadata.allowed_tools);
	if (allowedTools.length) config.allowedTools = allowedTools;
	return { config, warning: null };
}

export function resolveMcpServerConfigsFromRows(params: {
	rows: AgentMcpConnectionRow[];
	requestedServers?: McpServerProfileConfig[];
	includeProjectConnections?: boolean;
	hostedToken?: string | null;
}): AgentMcpResolutionResult {
	const requestedServers = (params.requestedServers ?? []).filter(isRecord) as McpServerProfileConfig[];
	const warnings: string[] = [];
	const servers: McpServerProfileConfig[] = [];
	const seenNames = new Set<string>();

	const connectionConfigs: Array<{ config: McpServerProfileConfig; row: AgentMcpConnectionRow }> = [];
	for (const row of params.rows) {
		const { config, warning } = buildServerConfig(row, params.hostedToken ?? null);
		if (warning) warnings.push(warning);
		if (config) connectionConfigs.push({ config, row });
	}

	for (const requested of requestedServers) {
		let config: McpServerProfileConfig | null = null;
		if (hasDirectEndpoint(requested)) {
			config = sanitizeRequestedServer(requested);
		} else {
			const identities = serverIdentityValues(requested);
			const match = connectionConfigs.find(({ config: candidate, row }) => {
				const candidateValues = new Set([
					...serverIdentityValues(candidate),
					...serverIdentityValues({
						pieceName: row.pieceName,
						serverKey: row.serverKey,
						displayName: row.displayName,
						sourceType: row.sourceType,
					}),
				]);
				return [...identities].some((value) => candidateValues.has(value));
			});
			if (!match) {
				warnings.push(
					`Skipped MCP profile server '${
						requested.displayName ||
						requested.server_name ||
						requested.serverName ||
						requested.pieceName ||
						"unknown"
					}' because no enabled project MCP connection matched it.`,
				);
				continue;
			}
			config = mergeRequestedOverResolved(match.config, requested);
		}

		const baseName = normalizeMcpName(config.server_name ?? config.serverName ?? config.name);
		let serverName = baseName;
		let suffix = 2;
		while (seenNames.has(serverName)) {
			serverName = `${baseName}_${suffix}`;
			suffix += 1;
		}
		config.server_name = serverName;
		config.name = serverName;
		seenNames.add(serverName);
		servers.push(config);
	}

	if (params.includeProjectConnections) {
		for (const { config } of connectionConfigs) {
			const key = normalizeMcpName(config.server_name ?? config.serverName ?? config.name);
			if (seenNames.has(key)) continue;
			config.server_name = key;
			config.name = key;
			seenNames.add(key);
			servers.push(config);
		}
	}

	return { mcpServers: servers, warnings };
}

export async function resolveAgentMcpServersForProject(params: {
	projectId?: string | null;
	requestedServers?: McpServerProfileConfig[];
	includeProjectConnections?: boolean;
}): Promise<AgentMcpResolutionResult> {
	const requestedServers = params.requestedServers ?? [];
	const projectId = params.projectId?.trim();
	if (!projectId || !db) {
		return {
			mcpServers: requestedServers.filter(isRecord).filter(hasDirectEndpoint).map(sanitizeRequestedServer),
			warnings: [],
		};
	}

	const rows = await db
		.select({
			id: mcpConnections.id,
			projectId: mcpConnections.projectId,
			sourceType: mcpConnections.sourceType,
			pieceName: mcpConnections.pieceName,
			serverKey: mcpConnections.serverKey,
			connectionExternalId: mcpConnections.connectionExternalId,
			displayName: mcpConnections.displayName,
			registryRef: mcpConnections.registryRef,
			serverUrl: mcpConnections.serverUrl,
			metadata: mcpConnections.metadata,
		})
		.from(mcpConnections)
		.where(and(eq(mcpConnections.projectId, projectId), eq(mcpConnections.status, "ENABLED")))
		.orderBy(asc(mcpConnections.displayName), asc(mcpConnections.createdAt));

	let hostedToken: string | null = null;
	if (rows.some((row) => row.sourceType === "hosted_workflow")) {
		try {
			hostedToken = (await getPopulatedMcpServerByProjectId(projectId)).token;
		} catch (err) {
			hostedToken = null;
		}
	}

	return resolveMcpServerConfigsFromRows({
		rows,
		requestedServers,
		includeProjectConnections: params.includeProjectConnections,
		hostedToken,
	});
}

export async function resolveAgentConfigMcpForProject(
	config: AgentConfig,
	projectId?: string | null,
): Promise<AgentConfig> {
	const requestedServers = Array.isArray(config.mcpServers) ? config.mcpServers : [];
	const mode = String(config.mcpConnectionMode || "").trim().toLowerCase();
	const includeProjectConnections =
		mode === "project" || mode === "all" || (mode === "auto" && requestedServers.length === 0);
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
			? { mcpConnectionWarnings: resolved.warnings } as Partial<AgentConfig>
			: {}),
	};
}
