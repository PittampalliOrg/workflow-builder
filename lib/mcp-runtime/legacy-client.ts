import "server-only";

import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import {
	deletePieceMcpServer,
	ensurePieceMcpServer,
	listManagedServers,
	serviceNameForPiece,
} from "@/lib/k8s/piece-mcp-provisioner";
import type { RuntimeEnsureResult, RuntimePieceServer } from "./types";

async function isHealthy(serviceName: string): Promise<boolean> {
	try {
		const res = await fetch(`http://${serviceName}:3100/health`, {
			signal: AbortSignal.timeout(2500),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function toServer(pieceName: string): RuntimePieceServer {
	const serviceName = serviceNameForPiece(pieceName);
	return {
		pieceName: normalizePieceName(pieceName),
		serviceName,
		url: `http://${serviceName}:3100/mcp`,
		healthy: false,
		provider: "legacy",
		registryRef: serviceName,
	};
}

export async function discoverPieceServer(
	rawPieceName: string,
): Promise<RuntimePieceServer | null> {
	const normalized = normalizePieceName(rawPieceName);
	let managed;
	try {
		managed = await listManagedServers();
	} catch {
		return null;
	}
	const found = managed.find((s) => s.pieceName === normalized);
	if (!found) {
		return null;
	}

	const base = toServer(rawPieceName);
	return {
		...base,
		pieceName: normalized,
		healthy: found.ready && (await isHealthy(found.name)),
	};
}

export async function ensurePieceServer(
	rawPieceName: string,
	connectionExternalId?: string,
): Promise<RuntimeEnsureResult> {
	const result = await ensurePieceMcpServer(rawPieceName, connectionExternalId);
	const server = await discoverPieceServer(rawPieceName);
	return {
		server,
		created: result.created,
		error: server ? undefined : "Legacy piece-mcp-server was not discoverable",
	};
}

export async function deletePieceServer(rawPieceName: string): Promise<void> {
	await deletePieceMcpServer(rawPieceName);
}

export async function listPieceServers(): Promise<RuntimePieceServer[]> {
	let managed;
	try {
		managed = await listManagedServers();
	} catch {
		return [];
	}
	const rows = await Promise.all(
		managed.map(async (m): Promise<RuntimePieceServer> => {
			const pieceName = normalizePieceName(m.pieceName);
			const base = toServer(pieceName);
			return {
				...base,
				pieceName,
				serviceName: m.name,
				url: `http://${m.name}:3100/mcp`,
				healthy: m.ready && (await isHealthy(m.name)),
			};
		}),
	);
	return rows.sort((a, b) => a.pieceName.localeCompare(b.pieceName));
}
