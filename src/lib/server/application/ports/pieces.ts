import type {
	PieceConnectionUsageRecord,
} from "./connections";
import type {
	McpCatalogPieceRecord,
} from "./mcp";
import type {
	CatalogFunctionSummary,
} from "./shared";

export type PieceMetadataDetailRecord = {
	name: string;
	displayName: string;
	description: string | null;
	logoUrl: string | null;
	categories: string[];
	version: string;
	auth: unknown;
	actions: unknown;
	availableOnly: boolean;
	catalogSourceImage: string | null;
	catalogSyncedAt: Date | null;
	updatedAt: Date | null;
};

export type PieceCatalogDetail = {
	piece: PieceMetadataDetailRecord | null;
	usageByConnection: Record<
		string,
		{
			refCount: number;
			workflowCount: number;
		}
	>;
};

export type ConnectablePieceRecord = {
	name: string;
	displayName: string | null;
	logoUrl: string | null;
	authType: string | null;
};

export type ConnectablePieceReadModel = {
	name: string;
	displayName: string | null;
	logoUrl: string | null;
	authType: string | null;
};

export type PieceExecutionStatus = "running" | "paused" | "completed" | "failed";

export type PieceExecutionReadModel = {
	idempotencyKey: string;
	status: PieceExecutionStatus;
	result: unknown;
	error: string | null;
	pieceName: string;
	actionName: string;
	completedAt: Date | null;
};

export interface PieceExecutionRepository {
	getByIdempotencyKey(idempotencyKey: string): Promise<PieceExecutionReadModel | null>;
}

export type AdminPieceMetadataRecord = {
	name: string | null;
	displayName: string | null;
	logoUrl: string | null;
};

export type AdminPieceImageStatusRecord = {
	pieceName: string;
	status: "building" | "ready" | "failed" | string;
	image: string | null;
	errorMessage: string | null;
	enabled: boolean;
};

export type AdminPieceRuntimeImageStatus = "building" | "ready" | "failed";

export type AdminPieceRuntimeImageEnableResult = {
	pieceName: string;
	version: string;
	status: AdminPieceRuntimeImageStatus;
	image?: string;
	digest?: string;
	madeRunnable: boolean;
	build?: { triggered: boolean; status?: number; reason?: string };
};

export type AdminPieceRuntimeImageRegistrationResult = {
	pieceName: string;
	version: string;
	status: AdminPieceRuntimeImageStatus;
	madeRunnable: boolean;
};

export type AdminPieceRuntimeImageReconcileResult = {
	checked: number;
	readied: number;
	failed: number;
};

export type AdminPieceRuntimeImageRecordResult = {
	enabledAt: Date | null;
};

export type AdminPieceRuntimeImageBuildingRecord = {
	pieceName: string;
	version: string;
	updatedAt: Date;
	enabledAt: Date | null;
};

export interface AdminPieceRuntimeImageRegistryPort {
	imageExists(input: {
		pieceName: string;
		version: string;
	}): Promise<{ exists: boolean; digest?: string }>;
	imageRef(input: { pieceName: string; version: string }): string;
}

export interface AdminPieceRuntimeImageBuildPort {
	triggerBuild(input: {
		pieceName: string;
		pieceVersion: string;
		callbackUrl: string;
	}): Promise<{ triggered: boolean; status?: number; reason?: string }>;
}

export type AdminProvisionedPieceRow = {
	name: string;
	displayName: string;
	logoUrl: string;
	enabled: boolean;
	inUse: boolean;
	pinned: boolean;
	perPiece: boolean;
};

export type AdminAvailablePieceRow = {
	name: string;
	displayName: string;
	logoUrl: string;
	buildStatus: "building" | "ready" | "failed" | null;
	errorMessage: string | null;
};

export type AdminPiecesReadModel = {
	pieces: AdminProvisionedPieceRow[];
	available: AdminAvailablePieceRow[];
	total: number;
	enabledCount: number;
	availableCount: number;
};

export interface AdminPieceRepository {
	listCatalogPieces(input: {
		availableOnly: boolean;
	}): Promise<AdminPieceMetadataRecord[]>;
	listDisabledPieceNames(): Promise<string[]>;
	listWorkflowReferencedPieceNames(): Promise<string[]>;
	listEnabledMcpPieceNames(): Promise<string[]>;
	listLatestImageStatuses(
		pieceNames: string[],
	): Promise<AdminPieceImageStatusRecord[]>;
	getLatestCatalogPieceVersion(pieceName: string): Promise<string | null>;
	setPieceEnabled(input: {
		pieceName: string;
		enabled: boolean;
		disabledBy?: string | null;
		platformId?: string;
	}): Promise<void>;
	markPieceImageBuilding(input: {
		pieceName: string;
		version: string;
	}): Promise<void>;
	markPieceImageReadyEnabled(input: {
		pieceName: string;
		version: string;
		image: string;
		digest?: string | null;
	}): Promise<void>;
	recordPieceImageResult(input: {
		pieceName: string;
		version: string;
		status: AdminPieceRuntimeImageStatus;
		image?: string | null;
		digest?: string | null;
		errorMessage?: string | null;
	}): Promise<AdminPieceRuntimeImageRecordResult | null>;
	listBuildingPieceImages(): Promise<AdminPieceRuntimeImageBuildingRecord[]>;
	markPieceRunnable(pieceName: string): Promise<void>;
}

export interface PieceCatalogRepository {
	getLatestPieceMetadata(
		pieceNameCandidates: string[],
	): Promise<PieceMetadataDetailRecord | null>;
	listConnectablePieces(input: {
		authOnly: boolean;
	}): Promise<ConnectablePieceRecord[]>;
	listPieceCatalogFunctions(): Promise<CatalogFunctionSummary[]>;
	listMcpCatalogPieces(): Promise<McpCatalogPieceRecord[]>;
	listConnectionUsageByPieceNames(input: {
		pieceNameCandidates: string[];
		projectId: string;
	}): Promise<PieceConnectionUsageRecord[]>;
}
