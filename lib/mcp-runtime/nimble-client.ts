import "server-only";

import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { NAMESPACE, k8sRequest } from "@/lib/k8s/client";
import type { RuntimeEnsureResult, RuntimePieceServer } from "./types";

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

function serviceNameForPiece(rawPieceName: string): string {
	return `ap-${normalizePieceName(rawPieceName)}-service`;
}

function mcpUrlForServiceName(serviceName: string): string {
	return `http://${serviceName}:${NIMBLE_SERVICE_PORT}/mcp`;
}

async function isHealthy(serviceName: string): Promise<boolean> {
	const url = `http://${serviceName}:${NIMBLE_SERVICE_PORT}/health`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
		return res.ok;
	} catch {
		return false;
	}
}

async function provisionViaControlPlane(
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
				body: JSON.stringify({ pieceName: normalizePieceName(rawPieceName) }),
			},
		);
		return res.ok;
	} catch {
		return false;
	}
}

export async function discoverPieceServer(
	rawPieceName: string,
): Promise<RuntimePieceServer | null> {
	const pieceName = normalizePieceName(rawPieceName);
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

	return {
		pieceName,
		serviceName,
		url: mcpUrlForServiceName(serviceName),
		healthy: await isHealthy(serviceName),
		provider: "nimble",
		registryRef: serviceName,
	};
}

export async function ensurePieceServer(
	rawPieceName: string,
): Promise<RuntimeEnsureResult> {
	const existing = await discoverPieceServer(rawPieceName);
	if (existing?.healthy) {
		return { server: existing, created: false };
	}

	const provisioned = await provisionViaControlPlane(rawPieceName);
	if (!provisioned) {
		return {
			server: existing,
			created: false,
			error: "Nimble control plane provisioning is unavailable",
		};
	}

	const retry = await discoverPieceServer(rawPieceName);
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
			return {
				pieceName,
				serviceName,
				url: mcpUrlForServiceName(serviceName),
				healthy: await isHealthy(serviceName),
				provider: "nimble",
				registryRef: serviceName,
			};
		}),
	);
	return rows.sort((a, b) => a.pieceName.localeCompare(b.pieceName));
}
