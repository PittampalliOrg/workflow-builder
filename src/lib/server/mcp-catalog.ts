import type { McpConnectionSourceType } from '$lib/server/db/schema';
import {
	humanizePieceName,
	normalizePieceName,
	normalizePieceMcpServerUrl,
	pieceMcpRegistryRef,
	pieceMcpServerUrl
} from '$lib/server/mcp-connections';

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

export type AppConnectionCatalogSummary = {
	id: string;
	externalId: string;
	displayName: string;
	type: string;
	status: string;
};

export type ConfiguredMcpConnectionSummary = {
	id: string;
	displayName: string;
	sourceType: McpConnectionSourceType;
	pieceName: string | null;
	serverKey: string | null;
	connectionExternalId: string | null;
	serverUrl: string | null;
	status: string;
	metadata: Record<string, unknown> | null;
};

export type AvailableMcpCatalogEntry = {
	pieceName: string;
	canonicalPieceName: string;
	displayName: string;
	description: string | null;
	logoUrl: string | null;
	categories: string[];
	authType: string;
	authDisplayName: string | null;
	requiresAuth: boolean;
	isOAuth2: boolean;
	oauthAppConfigured: boolean;
	actionCount: number;
	registryRef: string;
	serverUrl: string;
	appConnections: AppConnectionCatalogSummary[];
	mcpConnection: ConfiguredMcpConnectionSummary | null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstAuthRecord(auth: unknown): Record<string, unknown> | null {
	if (Array.isArray(auth)) {
		return auth.find(isRecord) ?? null;
	}
	return isRecord(auth) ? auth : null;
}

export function pieceAuthType(auth: unknown): string {
	const record = firstAuthRecord(auth);
	const type = typeof record?.type === 'string' ? record.type.trim() : '';
	return type || 'NONE';
}

export function pieceAuthDisplayName(auth: unknown): string | null {
	const record = firstAuthRecord(auth);
	const displayName = typeof record?.displayName === 'string' ? record.displayName.trim() : '';
	return displayName || null;
}

export function isOAuth2AuthType(authType: string | null | undefined): boolean {
	return String(authType || '').toUpperCase().includes('OAUTH2');
}

export function pieceRequiresAuth(authType: string | null | undefined): boolean {
	const normalized = String(authType || '').toUpperCase();
	return Boolean(normalized && normalized !== 'NONE' && normalized !== 'NO_AUTH');
}

export function actionCount(actions: unknown): number {
	if (!isRecord(actions)) return 0;
	return Object.keys(actions).length;
}

function connectionHeaders(
	connectionExternalId: string | null | undefined
): Record<string, string> | undefined {
	const externalId = connectionExternalId?.trim();
	return externalId ? { 'X-Connection-External-Id': externalId } : undefined;
}

export function buildHostedMcpGatewayInternalUrl(
	projectId: string,
	baseUrl = 'http://mcp-gateway.workflow-builder.svc.cluster.local:8080'
): string {
	return `${trimTrailingSlash(baseUrl)}/api/v1/projects/${encodeURIComponent(projectId)}/mcp-server/http`;
}

export function buildAvailablePieceMcpCatalogEntry(input: {
	pieceName: string;
	displayName: string;
	description?: string | null;
	logoUrl?: string | null;
	categories?: string[] | null;
	auth?: unknown;
	actions?: unknown;
	oauthAppConfigured?: boolean;
	appConnections?: AppConnectionCatalogSummary[];
	mcpConnection?: ConfiguredMcpConnectionSummary | null;
}): AvailableMcpCatalogEntry | null {
	const pieceName = normalizePieceName(input.pieceName);
	if (!pieceName) return null;
	const actionTotal = actionCount(input.actions);
	if (actionTotal <= 0) return null;

	const authType = pieceAuthType(input.auth);
	return {
		pieceName,
		canonicalPieceName: `@activepieces/piece-${pieceName}`,
		displayName: input.displayName?.trim() || humanizePieceName(pieceName),
		description: input.description ?? null,
		logoUrl: input.logoUrl || null,
		categories: Array.isArray(input.categories) ? input.categories : [],
		authType,
		authDisplayName: pieceAuthDisplayName(input.auth),
		requiresAuth: pieceRequiresAuth(authType),
		isOAuth2: isOAuth2AuthType(authType),
		oauthAppConfigured: Boolean(input.oauthAppConfigured),
		actionCount: actionTotal,
		registryRef: pieceMcpRegistryRef(pieceName),
		serverUrl: pieceMcpServerUrl(pieceName),
		appConnections: input.appConnections ?? [],
		mcpConnection: input.mcpConnection ?? null
	};
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

	const rawUrl = row.serverUrl?.trim();
	const url =
		sourceType === 'nimble_piece' && rawUrl ? normalizePieceMcpServerUrl(rawUrl) : rawUrl;
	if (!url || !/^https?:\/\//.test(url)) return null;

	if (sourceType === 'nimble_piece') {
		const piece = normalizePieceName(row.pieceName);
		if (!piece) return null;
		const headers = connectionHeaders(row.connectionExternalId);
		return {
			name: `ap-${piece}`,
			displayName,
			url,
			sourceType,
			pieceName: row.pieceName,
			connectionExternalId: row.connectionExternalId,
			...(headers ? { headers } : {})
		};
	}

	const baseName =
		normalizeServerName(row.serverKey) ||
		normalizeServerName(row.displayName) ||
		normalizeServerName(row.id);
	if (!baseName) return null;

	const prefix =
		sourceType === 'nimble_shared' ? 'shared' : sourceType === 'custom_url' ? 'custom' : 'mcp';
	const headers = connectionHeaders(row.connectionExternalId);

	return {
		name: `${prefix}-${baseName}`,
		displayName,
		url,
		sourceType,
		serverKey: row.serverKey,
		connectionExternalId: row.connectionExternalId,
		...(headers ? { headers } : {})
	};
}
