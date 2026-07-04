import type {
	McpCatalogPieceAction,
} from "./mcp";
import type {
	PieceCatalogDetail,
} from "./pieces";
import type {
	ResolveSecretOptions,
} from "./shared";

export type PieceConnectionUsageRecord = {
	connectionExternalId: string;
	refCount: number;
	workflowCount: number;
};

export type PieceConnectionDetailPageReadModel = {
	piece: {
		pieceName: string;
		canonicalPieceName: string;
		displayName: string;
		description: string | null;
		logoUrl: string | null;
		categories: string[];
		version: string;
		authType: string;
		authDisplayName: string | null;
		requiresAuth: boolean;
		isOAuth2: boolean;
		availableOnly: boolean;
		catalogSourceImage: string | null;
		catalogSyncedAt: string | null;
		metadataUpdatedAt: string | null;
	};
	actions: McpCatalogPieceAction[];
	usageByConnection: PieceCatalogDetail["usageByConnection"];
};

export interface WorkflowConnectionRefSyncPort {
	syncWorkflowConnectionRefs(input: {
		workflowId: string;
		nodes: unknown;
		spec?: unknown;
	}): Promise<void>;
}

export type SettingsPlatformOAuthAppRecord = {
	id: string;
	pieceName: string;
	clientId: string;
	createdAt: Date;
	updatedAt: Date;
};

export type SettingsOAuthPieceRecord = {
	name: string;
	displayName: string;
	logoUrl: string | null;
};

export type SettingsOAuthAppListItem = {
	id: string | null;
	pieceName: string;
	clientId: string;
	displayName: string;
	logoUrl: string | null;
	configured: boolean;
	createdAt: Date | null;
	updatedAt: Date | null;
};

export type SavePlatformOAuthAppInput = {
	id?: string | null;
	sessionPlatformId?: string | null;
	pieceName: string;
	clientId: string;
	clientSecret?: string | null;
};

export type PlatformOAuthAppMutationRecord = {
	id: string;
	platformId: string;
	pieceName: string;
	clientId: string;
	createdAt: Date;
	updatedAt: Date;
};

export type AppConnectionRecord = {
	id: string;
	externalId: string;
	pieceName: string;
	displayName: string;
	type: string;
	status: string;
	scope: string;
	ownerId: string | null;
	platformId: string | null;
	projectIds: string[];
	createdAt: Date;
	updatedAt: Date;
};

export type AppConnectionPieceInfoRecord = {
	name: string;
	displayName: string;
	logoUrl: string | null;
	categories: string[];
};

export type AppConnectionListItem = Omit<AppConnectionRecord, "projectIds"> & {
	providerId: string;
	providerLabel: string;
	providerIconUrl: string | null;
	category: string | null;
};

export type AppConnectionCreatedRecord = Pick<
	AppConnectionRecord,
	| "id"
	| "externalId"
	| "pieceName"
	| "displayName"
	| "type"
	| "status"
	| "scope"
	| "createdAt"
	| "updatedAt"
>;

export type AppConnectionUpdatedRecord = Pick<
	AppConnectionRecord,
	"id" | "externalId" | "pieceName" | "displayName" | "type" | "status" | "createdAt"
>;

export type AppConnectionSummaryRecord = Pick<
	AppConnectionRecord,
	"id" | "externalId" | "pieceName" | "displayName" | "type" | "status" | "createdAt"
>;

export type AppConnectionSecretRecord = AppConnectionRecord & {
	value: unknown;
	pieceVersion: string | null;
};

export type AppConnectionOAuthPieceMetadataRecord = {
	name: string;
	version: string;
	auth: unknown;
};

export type AppConnectionPlatformOAuthAppRecord = {
	pieceName: string;
	platformId: string | null;
	clientId: string;
	clientSecret: unknown;
};

export type AppConnectionOAuthCompletedRecord = Pick<
	AppConnectionRecord,
	| "id"
	| "externalId"
	| "pieceName"
	| "displayName"
	| "type"
	| "status"
	| "createdAt"
	| "updatedAt"
>;

export type AppConnectionSummary = AppConnectionSummaryRecord & {
	pieceDisplayName: string | null;
	pieceLogoUrl: string | null;
};

export type DecryptedAppConnection = Pick<
	AppConnectionRecord,
	"id" | "externalId" | "pieceName" | "displayName" | "type" | "status"
> & {
	value: Record<string, unknown>;
};

export type AppConnectionCreateInput = {
	projectId: string;
	userId?: string | null;
	platformId?: string | null;
	pieceName?: unknown;
	displayName?: unknown;
	type?: unknown;
	value?: unknown;
	scope?: unknown;
};

export type AppConnectionCreateResult =
	| {
			ok: true;
			connection: AppConnectionCreatedRecord;
	  }
	| {
			ok: false;
			status: 400 | 503;
			message: string;
	  };

export type AppConnectionUpdateResult =
	| {
			ok: true;
			connection: AppConnectionUpdatedRecord;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type AppConnectionDeleteResult =
	| { ok: true }
	| {
			ok: false;
			status: 404;
			message: string;
	  };

export type AppConnectionOAuth2StartResult =
	| {
			ok: true;
			authorizationUrl: string;
			clientId: string;
			state: string;
			codeVerifier: string;
			codeChallenge: string;
			redirectUrl: string;
			scope: string;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type AppConnectionOAuth2CompleteResult =
	| {
			ok: true;
			connection: AppConnectionOAuthCompletedRecord | null;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type DecryptedAppConnectionResult =
	| {
			ok: true;
			connection: DecryptedAppConnection;
	  }
	| {
			ok: false;
			status: 404;
			message: string;
	  };

export interface AppConnectionRepository {
	listProjectConnections(projectId: string): Promise<AppConnectionRecord[]>;
	listConnectionSummaries(input: {
		pieceNameCandidates?: string[];
	}): Promise<AppConnectionSummaryRecord[]>;
	listPieceInfo(): Promise<AppConnectionPieceInfoRecord[]>;
	findConnectionById(id: string): Promise<AppConnectionSecretRecord | null>;
	findConnectionByExternalId(externalId: string): Promise<AppConnectionSecretRecord | null>;
	findOAuthPieceMetadata(input: {
		pieceNameCandidates: string[];
		pieceVersion?: string | null;
	}): Promise<AppConnectionOAuthPieceMetadataRecord | null>;
	findPlatformOAuthApp(input: {
		pieceNameCandidates: string[];
		platformId?: string | null;
	}): Promise<AppConnectionPlatformOAuthAppRecord | null>;
	createConnection(input: {
		id: string;
		externalId: string;
		pieceName: string;
		displayName: string;
		type: string;
		status: string;
		scope: string;
		value: { iv: string; data: string };
		pieceVersion: string;
		projectIds: string[];
		ownerId: string | null;
		platformId: string | null;
	}): Promise<AppConnectionCreatedRecord>;
	updateDisplayName(input: {
		id: string;
		projectId: string;
		displayName: string;
	}): Promise<AppConnectionUpdatedRecord | null>;
	updateOAuthConnection(input: {
		id: string;
		value: { iv: string; data: string };
		pieceName: string;
		pieceVersion: string;
		projectIds: string[];
	}): Promise<AppConnectionOAuthCompletedRecord | null>;
	updateEncryptedValue(input: {
		id: string;
		value: { iv: string; data: string };
	}): Promise<void>;
	deleteProjectConnection(input: { id: string; projectId: string }): Promise<boolean>;
}

export interface CredentialStore {
	resolveSecret(
		name: string,
		options?: ResolveSecretOptions,
	): Promise<Record<string, unknown>>;
}

export type SessionRuntimeCliAuthCredentialKind =
	| "env_token"
	| "file"
	| "file_bundle"
	| "device_login";
