import "server-only";

import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import * as legacyRuntime from "./legacy-client";
import * as nimbleRuntime from "./nimble-client";
import type { RuntimeEnsureResult, RuntimePieceServer } from "./types";

export type RuntimeMode = "nimble-first";

const MODE: RuntimeMode = "nimble-first";

export async function ensurePieceServer(params: {
	pieceName: string;
	connectionExternalId?: string;
}): Promise<RuntimeEnsureResult> {
	const pieceName = normalizePieceName(params.pieceName);

	if (MODE === "nimble-first") {
		const nimble = await nimbleRuntime.ensurePieceServer(pieceName);
		if (nimble.server?.healthy) {
			return nimble;
		}

		const legacy = await legacyRuntime.ensurePieceServer(
			pieceName,
			params.connectionExternalId,
		);
		if (legacy.server) {
			return legacy;
		}

		return {
			server: null,
			created: nimble.created || legacy.created,
			error: nimble.error ?? legacy.error ?? "Unable to provision MCP server",
		};
	}

	return legacyRuntime.ensurePieceServer(
		pieceName,
		params.connectionExternalId,
	);
}

export async function discoverPieceServer(
	pieceName: string,
): Promise<RuntimePieceServer | null> {
	const normalized = normalizePieceName(pieceName);
	const nimble = await nimbleRuntime.discoverPieceServer(normalized);
	if (nimble) {
		return nimble;
	}
	return legacyRuntime.discoverPieceServer(normalized);
}

export async function listPieceServers(): Promise<RuntimePieceServer[]> {
	const [nimble, legacy] = await Promise.all([
		nimbleRuntime.listPieceServers(),
		legacyRuntime.listPieceServers(),
	]);
	const merged = new Map<string, RuntimePieceServer>();
	for (const item of [...legacy, ...nimble]) {
		merged.set(item.pieceName, item);
	}
	return Array.from(merged.values()).sort((a, b) =>
		a.pieceName.localeCompare(b.pieceName),
	);
}

export async function deletePieceServer(pieceName: string): Promise<void> {
	// Nimble teardown endpoint is optional and runtime-specific.
	// We keep legacy cleanup for now to avoid leaving old workloads behind.
	await legacyRuntime.deletePieceServer(pieceName);
}
