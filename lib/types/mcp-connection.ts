export const McpConnectionSourceType = {
	NIMBLE_PIECE: "nimble_piece",
	NIMBLE_SHARED: "nimble_shared",
	CUSTOM_URL: "custom_url",
	HOSTED_WORKFLOW: "hosted_workflow",
} as const;

export type McpConnectionSourceType =
	(typeof McpConnectionSourceType)[keyof typeof McpConnectionSourceType];

export const McpConnectionStatus = {
	ENABLED: "ENABLED",
	DISABLED: "DISABLED",
	ERROR: "ERROR",
} as const;

export type McpConnectionStatus =
	(typeof McpConnectionStatus)[keyof typeof McpConnectionStatus];

export type McpConnection = {
	id: string;
	projectId: string;
	sourceType: McpConnectionSourceType;
	pieceName: string | null;
	serverKey: string | null;
	displayName: string;
	registryRef: string | null;
	serverUrl: string | null;
	status: McpConnectionStatus;
	lastSyncAt: string | null;
	lastError: string | null;
	metadata: Record<string, unknown> | null;
	createdBy: string | null;
	updatedBy: string | null;
	createdAt: string;
	updatedAt: string;
};

export type McpConnectionCatalogItem = {
	sourceType:
		| typeof McpConnectionSourceType.NIMBLE_PIECE
		| typeof McpConnectionSourceType.NIMBLE_SHARED;
	catalogKey: string;
	pieceName: string | null;
	serverKey: string | null;
	displayName: string;
	logoUrl: string;
	description: string | null;
	activeConnectionCount: number;
	hasActiveConnections: boolean;
	oauthConfigured: boolean;
	runtimeAvailable: boolean;
	enabled: boolean;
	connectionId: string | null;
};

export type CreateMcpConnectionBody =
	| {
			sourceType: typeof McpConnectionSourceType.NIMBLE_PIECE;
			pieceName: string;
			displayName?: string;
	  }
	| {
			sourceType: typeof McpConnectionSourceType.NIMBLE_SHARED;
			serverKey: string;
			displayName?: string;
	  }
	| {
			sourceType: typeof McpConnectionSourceType.CUSTOM_URL;
			displayName: string;
			serverUrl: string;
	  };
