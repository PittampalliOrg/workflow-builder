import { env } from "$env/dynamic/private";
import {
	daprFetch,
	getDaprSidecarUrl,
	getWorkflowCapableServices,
} from "$lib/server/dapr-client";
import type {
	DaprInspectionRuntimePort,
	SidecarMetadata,
} from "$lib/server/application/dapr-inspection";

const DEFAULT_AGENT_REGISTRY_STORE = "agent-registry";
const DEFAULT_AGENT_REGISTRY_TEAM = "default";

export class DaprClientInspectionRuntimeAdapter
	implements DaprInspectionRuntimePort
{
	async getSidecarMetadata() {
		const sidecarUrl = getDaprSidecarUrl();
		let metadata: SidecarMetadata | null = null;
		let healthy = false;

		try {
			const [metaRes, healthRes] = await Promise.allSettled([
				daprFetch(`${sidecarUrl}/v1.0/metadata`, { maxRetries: 1 }),
				daprFetch(`${sidecarUrl}/v1.0/healthz`, { maxRetries: 1 }),
			]);

			if (metaRes.status === "fulfilled" && metaRes.value.ok) {
				metadata = (await metaRes.value.json()) as SidecarMetadata;
			}
			healthy = healthRes.status === "fulfilled" && healthRes.value.ok;
		} catch {
			// sidecar unavailable
		}

		return { metadata, healthy };
	}

	getWorkflowCapableServices() {
		return getWorkflowCapableServices().map((service) => ({
			id: service.id,
			introspectPath: service.introspectPath,
		}));
	}

	async invokeApp(appId: string, path: string): Promise<Response> {
		const sidecarUrl = getDaprSidecarUrl();
		const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
		return daprFetch(
			`${sidecarUrl}/v1.0/invoke/${encodeURIComponent(appId)}/method/${normalizedPath}`,
			{ maxRetries: 1 },
		);
	}

	async readState(
		storeName: string,
		key: string,
		metadata: Record<string, string> = {},
	) {
		const sidecarUrl = getDaprSidecarUrl();
		try {
			const url = new URL(
				`${sidecarUrl}/v1.0/state/${encodeURIComponent(storeName)}/${encodeURIComponent(key)}`,
			);
			url.searchParams.set("consistency", "strong");
			for (const [metaKey, metaValue] of Object.entries(metadata)) {
				url.searchParams.set(`metadata.${metaKey}`, metaValue);
			}

			const res = await daprFetch(url.toString(), { maxRetries: 1 });
			if (res.status === 204 || res.status === 404) {
				return { found: false, value: null, etag: null };
			}
			if (!res.ok) {
				return {
					found: false,
					value: null,
					etag: null,
					error: `HTTP ${res.status} — store "${storeName}" may not be in scope for this app's sidecar.`,
				};
			}
			const rawText = await res.text();
			const etag =
				res.headers.get("etag")?.replace(/^W\//, "").replace(/^"|"$/g, "") ??
				null;
			let value: unknown;
			try {
				value = JSON.parse(rawText);
			} catch {
				value = rawText;
			}
			return { found: true, value, etag };
		} catch (err) {
			return {
				found: false,
				value: null,
				etag: null,
				error: err instanceof Error ? err.message : "Sidecar unreachable",
			};
		}
	}

	agentRegistryStore(): string {
		return env.DAPR_AGENT_REGISTRY_STORE?.trim() || DEFAULT_AGENT_REGISTRY_STORE;
	}

	agentRegistryTeams(): string[] {
		const configured =
			env.DAPR_AGENT_REGISTRY_TEAMS ||
			env.AGENT_REGISTRY_TEAM ||
			DEFAULT_AGENT_REGISTRY_TEAM;
		const teams = configured
			.split(",")
			.map((team) => team.trim())
			.filter(Boolean);
		return teams.length
			? Array.from(new Set(teams))
			: [DEFAULT_AGENT_REGISTRY_TEAM];
	}
}
