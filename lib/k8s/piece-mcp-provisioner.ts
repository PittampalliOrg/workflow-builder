import "server-only";

import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { k8sRequest, NAMESPACE } from "./client";

const PIECE_MCP_IMAGE =
	process.env.PIECE_MCP_IMAGE ??
	"gitea.cnoe.localtest.me:8443/giteaadmin/piece-mcp-server:latest";
const PIECE_MCP_PORT = 3100;
const INTERNAL_API_URL =
	process.env.PIECE_MCP_INTERNAL_API_URL ?? "http://workflow-builder:3000";
const MANAGED_BY = "workflow-builder";
const SECRETS_NAME = "workflow-builder-secrets";

export function serviceNameForPiece(rawPieceName: string): string {
	return `piece-mcp-${normalizePieceName(rawPieceName)}`;
}

function labelsForPiece(normalizedName: string) {
	return {
		"app.kubernetes.io/managed-by": MANAGED_BY,
		"app.kubernetes.io/component": "piece-mcp-server",
		"piece-mcp/piece-name": normalizedName,
		app: `piece-mcp-${normalizedName}`,
	};
}

function buildDeployment(
	name: string,
	normalizedPieceName: string,
	rawPieceName: string,
	connectionExternalId?: string,
) {
	const labels = labelsForPiece(normalizedPieceName);

	const env: Array<{ name: string; value: string }> = [
		{ name: "PIECE_NAME", value: rawPieceName },
		{ name: "PORT", value: String(PIECE_MCP_PORT) },
		{ name: "INTERNAL_API_URL", value: INTERNAL_API_URL },
	];

	if (connectionExternalId) {
		env.push({
			name: "CONNECTION_EXTERNAL_ID",
			value: connectionExternalId,
		});
	}

	return {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: {
			name,
			namespace: NAMESPACE,
			labels,
		},
		spec: {
			replicas: 1,
			selector: { matchLabels: { app: labels.app } },
			template: {
				metadata: { labels },
				spec: {
					containers: [
						{
							name: "piece-mcp-server",
							image: PIECE_MCP_IMAGE,
							ports: [{ containerPort: PIECE_MCP_PORT }],
							env,
							envFrom: [{ secretRef: { name: SECRETS_NAME } }],
							resources: {
								requests: { cpu: "50m", memory: "128Mi" },
								limits: { cpu: "200m", memory: "256Mi" },
							},
							livenessProbe: {
								httpGet: {
									path: "/health",
									port: PIECE_MCP_PORT,
								},
								initialDelaySeconds: 10,
								periodSeconds: 30,
							},
							readinessProbe: {
								httpGet: {
									path: "/health",
									port: PIECE_MCP_PORT,
								},
								initialDelaySeconds: 5,
								periodSeconds: 10,
							},
						},
					],
				},
			},
		},
	};
}

function buildService(name: string, normalizedPieceName: string) {
	return {
		apiVersion: "v1",
		kind: "Service",
		metadata: {
			name,
			namespace: NAMESPACE,
			labels: labelsForPiece(normalizedPieceName),
		},
		spec: {
			selector: { app: `piece-mcp-${normalizedPieceName}` },
			ports: [
				{
					port: PIECE_MCP_PORT,
					targetPort: PIECE_MCP_PORT,
					protocol: "TCP",
				},
			],
			type: "ClusterIP",
		},
	};
}

export async function ensurePieceMcpServer(
	rawPieceName: string,
	connectionExternalId?: string,
): Promise<{ created: boolean; name: string }> {
	const normalized = normalizePieceName(rawPieceName);
	const name = serviceNameForPiece(rawPieceName);

	// Check if deployment already exists
	const existing = await k8sRequest(
		"GET",
		`/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${name}`,
	);

	if (existing.ok) {
		return { created: false, name };
	}

	if (existing.status !== 404) {
		throw new Error(
			`Failed to check deployment ${name}: ${existing.status}`,
		);
	}

	// Create deployment
	const deployRes = await k8sRequest(
		"POST",
		`/apis/apps/v1/namespaces/${NAMESPACE}/deployments`,
		buildDeployment(name, normalized, rawPieceName, connectionExternalId),
	);

	if (!deployRes.ok && deployRes.status !== 409) {
		throw new Error(
			`Failed to create deployment ${name}: ${deployRes.status}`,
		);
	}

	if (deployRes.status === 409) {
		// AlreadyExists (race condition)
		return { created: false, name };
	}

	// Create service
	const svcRes = await k8sRequest(
		"POST",
		`/api/v1/namespaces/${NAMESPACE}/services`,
		buildService(name, normalized),
	);

	if (!svcRes.ok && svcRes.status !== 409) {
		throw new Error(
			`Failed to create service ${name}: ${svcRes.status}`,
		);
	}

	return { created: true, name };
}

export async function deletePieceMcpServer(
	rawPieceName: string,
): Promise<boolean> {
	const name = serviceNameForPiece(rawPieceName);
	let deleted = false;

	const deployRes = await k8sRequest(
		"DELETE",
		`/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${name}`,
	);

	if (deployRes.ok) {
		deleted = true;
	} else if (deployRes.status !== 404) {
		throw new Error(
			`Failed to delete deployment ${name}: ${deployRes.status}`,
		);
	}

	const svcRes = await k8sRequest(
		"DELETE",
		`/api/v1/namespaces/${NAMESPACE}/services/${name}`,
	);

	if (!svcRes.ok && svcRes.status !== 404) {
		throw new Error(
			`Failed to delete service ${name}: ${svcRes.status}`,
		);
	}

	return deleted;
}

type K8sDeploymentList = {
	items: Array<{
		metadata?: {
			name?: string;
			labels?: Record<string, string>;
		};
		status?: {
			replicas?: number;
			availableReplicas?: number;
		};
	}>;
};

export type ManagedServer = {
	name: string;
	pieceName: string;
	ready: boolean;
	replicas: number;
	availableReplicas: number;
};

export async function listManagedServers(): Promise<ManagedServer[]> {
	const labelSelector = encodeURIComponent(
		`app.kubernetes.io/managed-by=${MANAGED_BY},app.kubernetes.io/component=piece-mcp-server`,
	);

	const res = await k8sRequest<K8sDeploymentList>(
		"GET",
		`/apis/apps/v1/namespaces/${NAMESPACE}/deployments?labelSelector=${labelSelector}`,
	);

	if (!res.ok) {
		throw new Error(`Failed to list deployments: ${res.status}`);
	}

	return (res.data.items ?? []).map((deploy) => {
		const pieceName =
			deploy.metadata?.labels?.["piece-mcp/piece-name"] ?? "unknown";
		const replicas = deploy.status?.replicas ?? 0;
		const available = deploy.status?.availableReplicas ?? 0;

		return {
			name: deploy.metadata?.name ?? "unknown",
			pieceName,
			ready: available > 0,
			replicas,
			availableReplicas: available,
		};
	});
}
