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
	/**
	 * Per-server tool allowlist from `mcp_connection.metadata.toolSelection`
	 * (absent = all tools). For piece servers the same list is also carried
	 * in the URL as `?tools=a,b` so piece-mcp-server enforces it at tool
	 * registration regardless of the consuming runtime.
	 */
	toolAllowlist?: string[];
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

export type RegisteredPieceMcpCatalogEntry = {
	pieceName: string;
	canonicalPieceName: string;
	serviceName: string | null;
	namespace: string | null;
	version: string | null;
	categories: string[];
	reason: string | null;
	registryRef: string;
	serverUrl: string;
};

export type McpAvailabilityAuthStatus =
	| 'READY'
	| 'NO_AUTH_REQUIRED'
	| 'CONNECT_REQUIRED'
	| 'OAUTH_APP_MISSING'
	| 'SERVER_NOT_REGISTERED';

export type McpServerAvailabilityEntry = AvailableMcpCatalogEntry & {
	registered: boolean;
	enabled: boolean;
	ready: boolean;
	authStatus: McpAvailabilityAuthStatus;
	authStatusLabel: string;
	selectedAppConnection: AppConnectionCatalogSummary | null;
	mcpConnectionExternalId: string | null;
	serviceName: string | null;
	namespace: string | null;
	registrationReason: string | null;
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

function stringValue(value: unknown): string | null {
	const text = typeof value === 'string' ? value.trim() : '';
	return text || null;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item || '').trim()).filter(Boolean);
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

/**
 * Read the per-connection tool allowlist persisted by the Integrations UI
 * at `mcp_connection.metadata.toolSelection = { tools: string[] }`.
 *
 * Returns `null` when no selection is stored (= all tools enabled). An
 * empty array is a valid "all tools disabled" selection.
 */
export function toolAllowlistFromMetadata(
	metadata: Record<string, unknown> | null | undefined
): string[] | null {
	const selection = isRecord(metadata) ? metadata.toolSelection : null;
	if (!isRecord(selection)) return null;
	const tools = selection.tools;
	if (!Array.isArray(tools)) return null;
	return Array.from(
		new Set(tools.map((tool) => String(tool || '').trim()).filter(Boolean))
	);
}

/**
 * Carry a tool allowlist on a piece MCP server URL as `?tools=a,b`.
 * piece-mcp-server reads the param at MCP session initialize and only
 * registers the listed tools — transport-level enforcement that works for
 * every consumer handed the URL (agents, orchestrator project-mode,
 * external clients). `null` allowlist = no restriction (param omitted).
 */
export function appendToolsQueryParam(url: string, allowlist: string[] | null): string {
	if (allowlist === null) return url;
	try {
		const parsed = new URL(url);
		parsed.searchParams.set('tools', allowlist.join(','));
		return parsed.toString();
	} catch {
		return url;
	}
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

export function parseRegisteredPieceMcpCatalog(
	value: string | null | undefined
): RegisteredPieceMcpCatalogEntry[] {
	const text = value?.trim();
	if (!text) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!isRecord(parsed)) return [];

	const entries: RegisteredPieceMcpCatalogEntry[] = [];
	for (const [key, raw] of Object.entries(parsed)) {
		if (!isRecord(raw)) continue;
		const rawPiece =
			stringValue(raw.piece) ||
			stringValue(raw.pieceName) ||
			stringValue(raw.name) ||
			key;
		const pieceName = normalizePieceName(rawPiece);
		if (!pieceName) continue;

		const serverUrl =
			stringValue(raw.mcpUrl) ||
			stringValue(raw.serverUrl) ||
			pieceMcpServerUrl(pieceName);
		const serviceName = stringValue(raw.serviceName);
		entries.push({
			pieceName,
			canonicalPieceName: `@activepieces/piece-${pieceName}`,
			serviceName,
			namespace: stringValue(raw.namespace),
			version: stringValue(raw.version),
			categories: stringArray(raw.categories),
			reason: stringValue(raw.reason),
			registryRef: serviceName || pieceMcpRegistryRef(pieceName),
			serverUrl: normalizePieceMcpServerUrl(serverUrl)
		});
	}

	return entries.sort((a, b) => a.pieceName.localeCompare(b.pieceName));
}

export function buildMcpServerAvailabilityEntry(input: {
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
	registered?: RegisteredPieceMcpCatalogEntry | null;
}): McpServerAvailabilityEntry | null {
	const base = buildAvailablePieceMcpCatalogEntry(input);
	if (!base) return null;

	const registered = input.registered ?? null;
	const mcpConnection = input.mcpConnection ?? null;
	const enabled = mcpConnection?.status === 'ENABLED';
	const selectedAppConnection =
		mcpConnection?.connectionExternalId
			? base.appConnections.find(
					(conn) => conn.externalId === mcpConnection.connectionExternalId
				) ?? null
			: null;

	let authStatus: McpAvailabilityAuthStatus;
	let authStatusLabel: string;
	if (!registered) {
		authStatus = 'SERVER_NOT_REGISTERED';
		authStatusLabel = 'Server not registered';
	} else if (!base.requiresAuth) {
		authStatus = 'NO_AUTH_REQUIRED';
		authStatusLabel = 'No auth required';
	} else if (selectedAppConnection) {
		authStatus = 'READY';
		authStatusLabel = `Connected: ${selectedAppConnection.displayName}`;
	} else if (base.isOAuth2 && !base.oauthAppConfigured) {
		authStatus = 'OAUTH_APP_MISSING';
		authStatusLabel = 'OAuth app missing';
	} else {
		authStatus = 'CONNECT_REQUIRED';
		authStatusLabel =
			base.appConnections.length > 0 ? 'Choose connection' : 'Connect required';
	}

	const authReady = authStatus === 'READY' || authStatus === 'NO_AUTH_REQUIRED';

	return {
		...base,
		serverUrl: registered?.serverUrl ?? base.serverUrl,
		registryRef: registered?.registryRef ?? base.registryRef,
		categories: base.categories.length > 0 ? base.categories : registered?.categories ?? [],
		mcpConnection,
		registered: Boolean(registered),
		enabled,
		ready: Boolean(registered && enabled && authReady),
		authStatus,
		authStatusLabel,
		selectedAppConnection,
		mcpConnectionExternalId: mcpConnection?.id ?? null,
		serviceName: registered?.serviceName ?? null,
		namespace: registered?.namespace ?? null,
		registrationReason: registered?.reason ?? null
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
		const toolAllowlist = toolAllowlistFromMetadata(row.metadata);
		return {
			name: `ap-${piece}`,
			displayName,
			url: appendToolsQueryParam(url, toolAllowlist),
			sourceType,
			pieceName: row.pieceName,
			connectionExternalId: row.connectionExternalId,
			...(headers ? { headers } : {}),
			...(toolAllowlist !== null ? { toolAllowlist } : {})
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
