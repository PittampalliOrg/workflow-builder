import type { McpConnectionSourceType } from '$lib/server/db/schema';
import { humanizePieceName, normalizePieceName } from '$lib/server/mcp-connections';

export type ProjectMcpCatalogRow = {
	id: string;
	projectId: string;
	sourceType: McpConnectionSourceType;
	pieceName: string | null;
	serverKey: string | null;
	connectionExternalId: string | null;
	displayName: string;
	serverUrl: string | null;
	metadata: Record<string, unknown> | null;
};

export type ProjectMcpCatalogEntry = {
	name: string;
	displayName: string;
	url: string;
	sourceType: McpConnectionSourceType;
	pieceName?: string | null;
	serverKey?: string | null;
	connectionExternalId?: string | null;
	headers?: Record<string, string>;
};

type BuildProjectMcpCatalogEntryOptions = {
	hostedProjectId?: string;
	hostedToken?: string | null;
	hostedGatewayBaseUrl?: string;
};

function normalizeServerName(value: string | null | undefined): string {
	return (value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

function trimTrailingSlash(value: string | null | undefined): string {
	return (value || '').replace(/\/+$/, '');
}

export function buildHostedMcpGatewayInternalUrl(
	projectId: string,
	baseUrl = 'http://mcp-gateway.workflow-builder.svc.cluster.local:8080'
): string {
	return `${trimTrailingSlash(baseUrl)}/api/v1/projects/${encodeURIComponent(projectId)}/mcp-server/http`;
}

export function buildProjectMcpCatalogEntry(
	row: ProjectMcpCatalogRow,
	options: BuildProjectMcpCatalogEntryOptions = {}
): ProjectMcpCatalogEntry | null {
	const sourceType = row.sourceType;
	const displayName =
		row.displayName?.trim() ||
		(sourceType === 'nimble_piece' && row.pieceName ? humanizePieceName(row.pieceName) : '') ||
		'MCP Server';

	if (sourceType === 'hosted_workflow') {
		const projectId = options.hostedProjectId?.trim() || row.projectId?.trim();
		const token = options.hostedToken?.trim();
		if (!projectId || !token) return null;

		return {
			name: 'workflow-builder-hosted',
			displayName,
			url: buildHostedMcpGatewayInternalUrl(projectId, options.hostedGatewayBaseUrl),
			sourceType,
			serverKey: row.serverKey,
			headers: {
				Authorization: `Bearer ${token}`
			}
		};
	}

	const url = row.serverUrl?.trim();
	if (!url || !/^https?:\/\//.test(url)) return null;

	if (sourceType === 'nimble_piece') {
		const piece = normalizePieceName(row.pieceName);
		if (!piece) return null;
		return {
			name: `ap-${piece}`,
			displayName,
			url,
			sourceType,
			pieceName: row.pieceName,
			connectionExternalId: row.connectionExternalId
		};
	}

	const baseName =
		normalizeServerName(row.serverKey) ||
		normalizeServerName(row.displayName) ||
		normalizeServerName(row.id);
	if (!baseName) return null;

	const prefix =
		sourceType === 'nimble_shared'
			? 'shared'
			: sourceType === 'custom_url'
				? 'custom'
				: 'mcp';

	return {
		name: `${prefix}-${baseName}`,
		displayName,
		url,
		sourceType,
		serverKey: row.serverKey,
		connectionExternalId: row.connectionExternalId
	};
}
