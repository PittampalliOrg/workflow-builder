import "server-only";

import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import * as nimbleRuntime from "./nimble-client";
import type { RuntimeEnsureResult, RuntimePieceServer } from "./types";

export async function ensurePieceServer(params: {
	pieceName: string;
}): Promise<RuntimeEnsureResult> {
	const pieceName = normalizePieceName(params.pieceName);
	return nimbleRuntime.ensurePieceServer(pieceName);
}

export async function discoverPieceServer(
	pieceName: string,
): Promise<RuntimePieceServer | null> {
	const normalized = normalizePieceName(pieceName);
	return nimbleRuntime.discoverPieceServer(normalized);
}

export async function listPieceServers(): Promise<RuntimePieceServer[]> {
	return nimbleRuntime.listPieceServers();
}

export async function deletePieceServer(pieceName: string): Promise<void> {
	// MCPServices are managed by Nimble reconciliation; deleting a DB row should
	// not directly delete runtime services.
	void pieceName;
}
