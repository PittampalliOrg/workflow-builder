import "server-only";

import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import * as nimbleRuntime from "./nimble-client";
import type {
	RuntimeEnsureResult,
	RuntimeNimbleServer,
	RuntimePieceServer,
	RuntimeSharedServer,
} from "./types";

export async function ensurePieceServer(params: {
	pieceName: string;
}): Promise<RuntimeEnsureResult> {
	const pieceName = normalizePieceName(params.pieceName);
	return nimbleRuntime.ensurePieceServer(pieceName);
}

export async function ensureSharedServer(params: {
	serverKey: string;
}): Promise<RuntimeEnsureResult> {
	const serverKey = normalizePieceName(params.serverKey);
	return nimbleRuntime.ensureSharedServer(serverKey);
}

export async function discoverPieceServer(
	pieceName: string,
): Promise<RuntimePieceServer | null> {
	const normalized = normalizePieceName(pieceName);
	return nimbleRuntime.discoverPieceServer(normalized);
}

export async function discoverSharedServer(
	serverKey: string,
): Promise<RuntimeSharedServer | null> {
	const normalized = normalizePieceName(serverKey);
	return nimbleRuntime.discoverSharedServer(normalized);
}

export async function listPieceServers(): Promise<RuntimePieceServer[]> {
	return nimbleRuntime.listPieceServers();
}

export async function listSharedServers(): Promise<RuntimeSharedServer[]> {
	return nimbleRuntime.listSharedServers();
}

export async function listNimbleServers(): Promise<RuntimeNimbleServer[]> {
	return nimbleRuntime.listNimbleServers();
}

export async function deletePieceServer(pieceName: string): Promise<void> {
	// MCPServices are managed by Nimble reconciliation; deleting a DB row should
	// not directly delete runtime services.
	void pieceName;
}
