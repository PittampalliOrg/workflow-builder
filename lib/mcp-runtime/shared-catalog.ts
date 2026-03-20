import "server-only";

import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { k8sRequest, NAMESPACE } from "@/lib/k8s/client";

const SHARED_CATALOG_CONFIGMAP =
	process.env.NIMBLE_SHARED_MCP_CATALOG_CONFIGMAP ??
	"nimble-shared-mcp-catalog";
const SHARED_CATALOG_KEY =
	process.env.NIMBLE_SHARED_MCP_CATALOG_KEY ?? "servers.json";
const SHARED_CATALOG_NAMESPACE =
	process.env.NIMBLE_SHARED_MCP_CATALOG_NAMESPACE ?? NAMESPACE;

type ConfigMapResponse = {
	data?: Record<string, string>;
};

export type NimbleSharedCatalogEntry = {
	serverKey: string;
	displayName: string;
	description: string | null;
	logoUrl: string;
	serviceName: string;
	namespace: string;
};

function normalizeServerKey(rawKey: string): string {
	return normalizePieceName(rawKey);
}

function coerceEntry(value: unknown): NimbleSharedCatalogEntry | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const raw = value as Record<string, unknown>;
	const serverKeyRaw =
		(typeof raw.serverKey === "string" && raw.serverKey) ||
		(typeof raw.key === "string" && raw.key) ||
		(typeof raw.name === "string" && raw.name) ||
		"";
	const serverKey = normalizeServerKey(serverKeyRaw);
	if (!serverKey) {
		return null;
	}

	const displayName =
		(typeof raw.displayName === "string" && raw.displayName.trim()) ||
		serverKeyRaw.trim() ||
		serverKey;

	const description =
		typeof raw.description === "string" && raw.description.trim()
			? raw.description.trim()
			: null;
	const logoUrl =
		typeof raw.logoUrl === "string" && raw.logoUrl.trim()
			? raw.logoUrl.trim()
			: "";
	const serviceNameRaw =
		(typeof raw.serviceName === "string" && raw.serviceName.trim()) ||
		`${serverKey}-service`;
	const namespace =
		(typeof raw.namespace === "string" && raw.namespace.trim()) ||
		SHARED_CATALOG_NAMESPACE;
	const serviceName = serviceNameRaw.endsWith("-service")
		? serviceNameRaw
		: `${serviceNameRaw}-service`;

	return {
		serverKey,
		displayName,
		description,
		logoUrl,
		serviceName,
		namespace,
	};
}

function parseCatalogPayload(payload: string): NimbleSharedCatalogEntry[] {
	try {
		const parsed = JSON.parse(payload) as unknown;
		const entries = Array.isArray(parsed)
			? parsed
			: ((parsed as Record<string, unknown>)?.servers ??
				(parsed as Record<string, unknown>)?.items ??
				(parsed as Record<string, unknown>)?.sharedServers ??
				[]);
		if (!Array.isArray(entries)) {
			return [];
		}
		return entries
			.map((entry) => coerceEntry(entry))
			.filter((entry): entry is NimbleSharedCatalogEntry => Boolean(entry))
			.sort((a, b) => a.displayName.localeCompare(b.displayName));
	} catch {
		return [];
	}
}

export async function listSharedNimbleCatalogServers(): Promise<
	NimbleSharedCatalogEntry[]
> {
	let res;
	try {
		res = await k8sRequest<ConfigMapResponse>(
			"GET",
			`/api/v1/namespaces/${SHARED_CATALOG_NAMESPACE}/configmaps/${SHARED_CATALOG_CONFIGMAP}`,
		);
	} catch {
		return [];
	}

	if (!res.ok) {
		return [];
	}

	const data = res.data.data ?? {};
	const payload =
		data[SHARED_CATALOG_KEY] ??
		data.catalog ??
		data.servers ??
		data.sharedServers ??
		"";

	if (typeof payload !== "string" || !payload.trim()) {
		return [];
	}

	return parseCatalogPayload(payload);
}

export async function getSharedNimbleCatalogServer(
	serverKey: string,
): Promise<NimbleSharedCatalogEntry | null> {
	const normalized = normalizeServerKey(serverKey);
	if (!normalized) {
		return null;
	}
	const servers = await listSharedNimbleCatalogServers();
	return servers.find((server) => server.serverKey === normalized) ?? null;
}
