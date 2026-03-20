export type RuntimeProvider = "nimble" | "legacy";

export type RuntimeNimbleSourceType = "nimble_piece" | "nimble_shared";

export type RuntimeNimbleServer = {
	sourceType: RuntimeNimbleSourceType;
	pieceName: string | null;
	serverKey: string | null;
	displayName: string | null;
	serviceName: string;
	url: string;
	healthy: boolean;
	provider: RuntimeProvider;
	registryRef?: string | null;
	logoUrl?: string | null;
	description?: string | null;
};

export type RuntimePieceServer = RuntimeNimbleServer & {
	sourceType: "nimble_piece";
	pieceName: string;
	serverKey: null;
};

export type RuntimeSharedServer = RuntimeNimbleServer & {
	sourceType: "nimble_shared";
	pieceName: null;
	serverKey: string;
};

export type RuntimeEnsureResult = {
	server: RuntimeNimbleServer | null;
	created: boolean;
	error?: string;
};
