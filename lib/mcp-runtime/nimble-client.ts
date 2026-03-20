import "server-only";

import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { NAMESPACE, k8sRequest } from "@/lib/k8s/client";
import {
	getSharedNimbleCatalogServer,
	listSharedNimbleCatalogServers,
} from "./shared-catalog";
import type {
	RuntimeEnsureResult,
	RuntimeNimbleServer,
	RuntimePieceServer,
	RuntimeSharedServer,
} from "./types";

const NIMBLE_CONTROL_PLANE_URL = process.env.NIMBLETOOLS_CONTROL_PLANE_URL;
const NIMBLE_CONTROL_PLANE_TOKEN = process.env.NIMBLETOOLS_CONTROL_PLANE_TOKEN;
const NIMBLE_SERVICE_PORT = Number(
	process.env.NIMBLETOOLS_SERVICE_PORT ?? "3100",
);

type K8sServiceList = {
	items?: Array<{
		metadata?: {
			name?: string;
		};
	}>;
};

type NimbleServerSourceType = "nimble_piece" | "nimble_shared";

function normalizeNimbleKey(rawKey: string): string {
	return normalizePieceName(rawKey);
}

function serviceNameForPiece(rawPieceName: string): string {
	return `ap-${normalizeNimbleKey(rawPieceName)}-service`;
}

function serviceHost(serviceName: string, namespace = NAMESPACE): string {
	return `${serviceName}.${namespace}.svc.cluster.local`;
}

function mcpUrlForServiceName(
	serviceName: string,
	namespace = NAMESPACE,
): string {
	return `http://${serviceHost(serviceName, namespace)}:${NIMBLE_SERVICE_PORT}/mcp`;
}

function buildServerBase(
	params: {
		sourceType: NimbleServerSourceType;
		key: string;
		serviceName: string;
		namespace?: string;
		displayName?: string | null;
		description?: string | null;
		logoUrl?: string | null;
	},
	healthy: boolean,
): RuntimeNimbleServer {
	const normalizedKey = normalizeNimbleKey(params.key);
	return {
		sourceType: params.sourceType,
		pieceName: params.sourceType === "nimble_piece" ? normalizedKey : null,
		serverKey: params.sourceType === "nimble_shared" ? normalizedKey : null,
		displayName: params.displayName ?? normalizedKey,
		description: params.description ?? null,
		logoUrl: params.logoUrl ?? null,
		serviceName: params.serviceName,
		url: mcpUrlForServiceName(params.serviceName, params.namespace),
		healthy,
		provider: "nimble",
		registryRef: params.serviceName,
	};
}

async function isHealthy(
	serviceName: string,
	namespace = NAMESPACE,
): Promise<boolean> {
	const url = `http://${serviceHost(serviceName, namespace)}:${NIMBLE_SERVICE_PORT}/health`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
		return res.ok;
	} catch {
		return false;
	}
}

async function provisionPieceViaControlPlane(
	rawPieceName: string,
): Promise<boolean> {
	if (!NIMBLE_CONTROL_PLANE_URL) {
		return false;
	}

	try {
		const res = await fetch(
			`${NIMBLE_CONTROL_PLANE_URL.replace(/\/$/, "")}/api/v1/mcp-services/provision`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(NIMBLE_CONTROL_PLANE_TOKEN
						? { Authorization: `Bearer ${NIMBLE_CONTROL_PLANE_TOKEN}` }
						: {}),
				},
				body: JSON.stringify({ pieceName: normalizeNimbleKey(rawPieceName) }),
			},
		);
		return res.ok;
	} catch {
		return false;
	}
}

async function discoverPieceServerInternal(
	rawPieceName: string,
): Promise<RuntimePieceServer | null> {
	const pieceName = normalizeNimbleKey(rawPieceName);
	const serviceName = serviceNameForPiece(pieceName);
	let exists;
	try {
		exists = await k8sRequest(
			"GET",
			`/api/v1/namespaces/${NAMESPACE}/services/${serviceName}`,
		);
	} catch {
		return null;
	}
	if (!exists.ok) {
		return null;
	}

	return buildServerBase(
		{
			sourceType: "nimble_piece",
			key: pieceName,
			serviceName,
			displayName: pieceName,
		},
		await isHealthy(serviceName),
	) as RuntimePieceServer;
}

async function discoverSharedServerInternal(
	rawServerKey: string,
): Promise<RuntimeSharedServer | null> {
	const catalogEntry = await getSharedNimbleCatalogServer(rawServerKey);
	if (!catalogEntry) {
		return null;
	}

	let exists;
	try {
		exists = await k8sRequest(
			"GET",
			`/api/v1/namespaces/${catalogEntry.namespace}/services/${catalogEntry.serviceName}`,
		);
	} catch {
		return null;
	}
	if (!exists.ok) {
		return null;
	}

	return buildServerBase(
		{
			sourceType: "nimble_shared",
			key: catalogEntry.serverKey,
			serviceName: catalogEntry.serviceName,
			namespace: catalogEntry.namespace,
			displayName: catalogEntry.displayName,
			description: catalogEntry.description,
			logoUrl: catalogEntry.logoUrl,
		},
		await isHealthy(catalogEntry.serviceName, catalogEntry.namespace),
	) as RuntimeSharedServer;
}

export async function discoverPieceServer(
	rawPieceName: string,
): Promise<RuntimePieceServer | null> {
	return discoverPieceServerInternal(rawPieceName);
}

export async function discoverSharedServer(
	rawServerKey: string,
): Promise<RuntimeSharedServer | null> {
	return discoverSharedServerInternal(rawServerKey);
}

export async function ensurePieceServer(
	rawPieceName: string,
): Promise<RuntimeEnsureResult> {
	const existing = await discoverPieceServerInternal(rawPieceName);
	if (existing?.healthy) {
		return { server: existing, created: false };
	}

	const provisioned = await provisionPieceViaControlPlane(rawPieceName);
	if (!provisioned) {
		return {
			server: existing,
			created: false,
			error: "Nimble control plane provisioning is unavailable",
		};
	}

	const retry = await discoverPieceServerInternal(rawPieceName);
	if (retry) {
		return { server: retry, created: true };
	}

	return {
		server: null,
		created: true,
		error:
			"Provisioned via Nimble control plane but service is not discoverable yet",
	};
}

export async function ensureSharedServer(
	rawServerKey: string,
): Promise<RuntimeEnsureResult> {
	const existing = await discoverSharedServerInternal(rawServerKey);
	if (existing) {
		return { server: existing, created: false };
	}

	return {
		server: null,
		created: false,
		error: "Shared Nimble server is not discoverable",
	};
}

export async function listPieceServers(): Promise<RuntimePieceServer[]> {
	let res;
	try {
		res = await k8sRequest<K8sServiceList>(
			"GET",
			`/api/v1/namespaces/${NAMESPACE}/services`,
		);
	} catch {
		return [];
	}
	if (!res.ok) {
		return [];
	}

	const services = res.data.items ?? [];
	const matches = services
		.map((s) => s.metadata?.name ?? "")
		.filter((name) => /^ap-[a-z0-9-]+-service$/.test(name));

	const rows = await Promise.all(
		matches.map(async (serviceName): Promise<RuntimePieceServer> => {
			const pieceName = serviceName
				.replace(/^ap-/, "")
				.replace(/-service$/, "");
			return buildServerBase(
				{
					sourceType: "nimble_piece",
					key: pieceName,
					serviceName,
					displayName: pieceName,
				},
				await isHealthy(serviceName),
			) as RuntimePieceServer;
		}),
	);
	return rows.sort((a, b) => a.pieceName.localeCompare(b.pieceName));
}

export async function listSharedServers(): Promise<RuntimeSharedServer[]> {
	const catalog = await listSharedNimbleCatalogServers();
	const rows = await Promise.all(
		catalog.map(async (entry): Promise<RuntimeSharedServer | null> => {
			let exists;
			try {
				exists = await k8sRequest(
					"GET",
					`/api/v1/namespaces/${entry.namespace}/services/${entry.serviceName}`,
				);
			} catch {
				return null;
			}
			if (!exists.ok) {
				return null;
			}
			return buildServerBase(
				{
					sourceType: "nimble_shared",
					key: entry.serverKey,
					serviceName: entry.serviceName,
					namespace: entry.namespace,
					displayName: entry.displayName,
					description: entry.description,
					logoUrl: entry.logoUrl,
				},
				await isHealthy(entry.serviceName, entry.namespace),
			) as RuntimeSharedServer;
		}),
	);
	return rows.filter((row): row is RuntimeSharedServer => Boolean(row));
}

export async function listNimbleServers(): Promise<RuntimeNimbleServer[]> {
	const [pieces, shared] = await Promise.all([
		listPieceServers(),
		listSharedServers(),
	]);
	return [...pieces, ...shared];
}
