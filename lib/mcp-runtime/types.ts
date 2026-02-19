export type RuntimeProvider = "nimble" | "legacy";

export type RuntimePieceServer = {
	pieceName: string;
	serviceName: string;
	url: string;
	healthy: boolean;
	provider: RuntimeProvider;
	registryRef?: string | null;
};

export type RuntimeEnsureResult = {
	server: RuntimePieceServer | null;
	created: boolean;
	error?: string;
};
