import "server-only";

import type {
	DaprControlPlaneEntry,
	DaprDashboardComponent,
	DaprDashboardConfiguration,
	DaprDashboardInstance,
	DaprDashboardMetadata,
	DaprDashboardPlatform,
} from "@/lib/types/dapr-debug";

const DEFAULT_DASHBOARD_URLS = [
	process.env.DAPR_DASHBOARD_URL,
	"http://dapr-dashboard.dapr-system.svc.cluster.local:8080",
	"http://127.0.0.1:18080",
	"http://localhost:18080",
].filter((value): value is string => Boolean(value?.trim()));

const FETCH_TIMEOUT_MS = Number.parseInt(
	process.env.DAPR_DASHBOARD_TIMEOUT_MS || "5000",
	10,
);

type DashboardRequestOptions = {
	accept404?: boolean;
};

function normalizeBaseUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

async function dashboardFetch<T>(
	baseUrl: string,
	path: string,
	options?: DashboardRequestOptions,
): Promise<T | null> {
	const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
		headers: {
			Accept: "application/json, text/plain;q=0.9",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		cache: "no-store",
	});

	if (options?.accept404 && response.status === 404) {
		return null;
	}

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Dashboard request failed (${response.status}) ${path}${body ? `: ${body.slice(0, 200)}` : ""}`,
		);
	}

	const contentType = response.headers.get("content-type") || "";
	if (contentType.includes("application/json")) {
		return (await response.json()) as T;
	}

	return (await response.text()) as T;
}

export async function resolveDaprDashboardBaseUrl(): Promise<string> {
	const errors: string[] = [];

	for (const candidate of DEFAULT_DASHBOARD_URLS) {
		try {
			await dashboardFetch<string>(candidate, "/api/platform");
			return normalizeBaseUrl(candidate);
		} catch (error) {
			errors.push(
				error instanceof Error
					? `${candidate}: ${error.message}`
					: `${candidate}: ${String(error)}`,
			);
		}
	}

	throw new Error(
		`No reachable Dapr dashboard endpoint found. ${errors.join(" | ")}`,
	);
}

function mapInstance(
	scope: string,
	item: Record<string, unknown>,
): DaprDashboardInstance {
	return {
		appId: String(item.appID || ""),
		httpPort: Number(item.httpPort || 0),
		grpcPort: Number(item.grpcPort || 0),
		appPort: Number(item.appPort || 0),
		command: String(item.command || ""),
		age: String(item.age || ""),
		created: String(item.created || ""),
		pid: Number(item.pid || -1),
		replicas: Number(item.replicas || 0),
		address: String(item.address || ""),
		supportsDeletion: Boolean(item.supportsDeletion),
		supportsLogs: Boolean(item.supportsLogs),
		manifest: String(item.manifest || ""),
		status: String(item.status || ""),
		labels: String(item.labels || ""),
		selector: String(item.selector || ""),
		config: String(item.config || ""),
		scope,
	};
}

function mapMetadata(item: Record<string, unknown>): DaprDashboardMetadata {
	return {
		id: String(item.id || ""),
		runtimeVersion: String(item.runtimeVersion || ""),
		enabledFeatures: Array.isArray(item.enabledFeatures)
			? item.enabledFeatures.map((value) => String(value))
			: [],
		actors: Array.isArray(item.actors)
			? item.actors.map((actor) => ({
					type: String((actor as Record<string, unknown>).type || ""),
					count: Number((actor as Record<string, unknown>).count || 0),
				}))
			: [],
		components: Array.isArray(item.components)
			? item.components.map((component) => ({
					name: String((component as Record<string, unknown>).name || ""),
					type: String((component as Record<string, unknown>).type || ""),
					version: String((component as Record<string, unknown>).version || ""),
					capabilities: Array.isArray(
						(component as Record<string, unknown>).capabilities,
					)
						? (
								(component as Record<string, unknown>).capabilities as unknown[]
							).map((value) => String(value))
						: [],
				}))
			: [],
		subscriptions: Array.isArray(item.subscriptions)
			? item.subscriptions.map((subscription) => ({
					pubsubName: String(
						(subscription as Record<string, unknown>).pubsubname ||
							(subscription as Record<string, unknown>).pubsubName ||
							"",
					),
					topic: String((subscription as Record<string, unknown>).topic || ""),
					deadLetterTopic: String(
						(subscription as Record<string, unknown>).deadLetterTopic || "",
					),
					metadata:
						((subscription as Record<string, unknown>).metadata as
							| Record<string, unknown>
							| null
							| undefined) ?? null,
					rules: Array.isArray((subscription as Record<string, unknown>).rules)
						? ((((subscription as Record<string, unknown>)
								.rules as unknown[]) ?? []) as Array<Record<string, unknown>>)
						: [],
				}))
			: [],
		extended:
			(item.extended as Record<string, unknown> | null | undefined) ?? {},
	};
}

export const daprDashboardClient = {
	resolveBaseUrl: resolveDaprDashboardBaseUrl,

	async getPlatform(baseUrl?: string): Promise<DaprDashboardPlatform> {
		const resolvedBaseUrl = baseUrl || (await resolveDaprDashboardBaseUrl());
		const platform = await dashboardFetch<string>(
			resolvedBaseUrl,
			"/api/platform",
		);
		const normalized = String(platform || "").trim();
		if (
			normalized === "kubernetes" ||
			normalized === "standalone" ||
			normalized === "docker-compose"
		) {
			return normalized;
		}
		return "unknown";
	},

	async getScopes(baseUrl?: string): Promise<string[]> {
		const resolvedBaseUrl = baseUrl || (await resolveDaprDashboardBaseUrl());
		const scopes = await dashboardFetch<unknown[]>(
			resolvedBaseUrl,
			"/api/scopes",
		);
		return Array.isArray(scopes) ? scopes.map((scope) => String(scope)) : [];
	},

	async getControlPlane(baseUrl?: string): Promise<DaprControlPlaneEntry[]> {
		const resolvedBaseUrl = baseUrl || (await resolveDaprDashboardBaseUrl());
		const entries = await dashboardFetch<Array<Record<string, unknown>>>(
			resolvedBaseUrl,
			"/api/controlplanestatus",
		);
		return Array.isArray(entries)
			? entries.map((entry) => ({
					service: String(entry.service || ""),
					name: String(entry.name || ""),
					namespace: String(entry.namespace || ""),
					healthy: String(entry.healthy || ""),
					status: String(entry.status || ""),
					version: String(entry.version || ""),
					age: String(entry.age || ""),
					created: String(entry.created || ""),
				}))
			: [];
	},

	async getInstances(
		scope: string,
		baseUrl?: string,
	): Promise<DaprDashboardInstance[]> {
		const resolvedBaseUrl = baseUrl || (await resolveDaprDashboardBaseUrl());
		const entries = await dashboardFetch<Array<Record<string, unknown>>>(
			resolvedBaseUrl,
			`/api/instances/${encodeURIComponent(scope)}`,
		);
		return Array.isArray(entries)
			? entries.map((entry) => mapInstance(scope, entry))
			: [];
	},

	async getMetadata(
		scope: string,
		appId: string,
		baseUrl?: string,
	): Promise<DaprDashboardMetadata | null> {
		const resolvedBaseUrl = baseUrl || (await resolveDaprDashboardBaseUrl());
		const payload = await dashboardFetch<Record<string, unknown>>(
			resolvedBaseUrl,
			`/api/metadata/${encodeURIComponent(scope)}/${encodeURIComponent(appId)}`,
			{ accept404: true },
		);
		return payload ? mapMetadata(payload) : null;
	},

	async getComponents(
		scope: string,
		baseUrl?: string,
	): Promise<DaprDashboardComponent[]> {
		const resolvedBaseUrl = baseUrl || (await resolveDaprDashboardBaseUrl());
		const entries = await dashboardFetch<Array<Record<string, unknown>>>(
			resolvedBaseUrl,
			`/api/components/${encodeURIComponent(scope)}`,
		);
		return Array.isArray(entries)
			? entries.map((entry) => ({
					name: String(entry.name || ""),
					kind: String(entry.kind || ""),
					type: String(entry.type || ""),
					created: String(entry.created || ""),
					age: String(entry.age || ""),
					scopes: Array.isArray(entry.scopes)
						? entry.scopes.map((value) => String(value))
						: [],
					manifest:
						(entry.manifest as Record<string, unknown> | null | undefined) ??
						null,
				}))
			: [];
	},

	async getConfigurations(
		scope: string,
		baseUrl?: string,
	): Promise<DaprDashboardConfiguration[]> {
		const resolvedBaseUrl = baseUrl || (await resolveDaprDashboardBaseUrl());
		const entries = await dashboardFetch<Array<Record<string, unknown>>>(
			resolvedBaseUrl,
			`/api/configurations/${encodeURIComponent(scope)}`,
		);
		return Array.isArray(entries)
			? entries.map((entry) => ({
					name: String(entry.name || ""),
					kind: String(entry.kind || ""),
					created: String(entry.created || ""),
					age: String(entry.age || ""),
					tracingEnabled: Boolean(entry.tracingEnabled),
					samplingRate: String(entry.samplingRate || ""),
					metricsEnabled: Boolean(entry.metricsEnabled),
					mtlsEnabled: Boolean(entry.mtlsEnabled),
					mtlsWorkloadTTL: String(entry.mtlsWorkloadTTL || ""),
					mtlsClockSkew: String(entry.mtlsClockSkew || ""),
					manifest:
						(entry.manifest as
							| Record<string, unknown>
							| string
							| null
							| undefined) ?? null,
				}))
			: [];
	},
};
