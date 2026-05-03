import type {
	AgentConfig,
	AgentRuntimeIsolation,
	AgentRuntimePoolBinding,
} from "$lib/types/agents";
import { isPlaywrightMcpEntry } from "./mcp-sidecar";

type RuntimePoolConfigValue =
	| string
	| (AgentRuntimePoolBinding & { appId: string; slug?: string });

export type AgentRuntimePool = {
	runtimeClass: string;
	appId: string;
	slug: string;
	minReplicas?: number;
	maxReplicas?: number;
	slotsPerReplica?: number;
	maxActiveSessions?: number;
};

export type AgentRuntimeRoute = {
	appId: string;
	slug: string;
	runtimeClass: string;
	isolation: "shared" | "dedicated";
	reason: string;
	pool?: AgentRuntimePool;
};

const DEFAULT_RUNTIME_CLASS = "coding";
const DEFAULT_POOL_PREFIX = "agent-runtime-pool-";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function cleanRuntimeClass(value: unknown): string | null {
	const raw = cleanString(value);
	if (!raw) return null;
	const normalized = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return normalized || null;
}

function cleanPositiveInt(value: unknown): number | undefined {
	const n =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function boolEnv(name: string): boolean {
	const raw = (process.env[name] ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function runtimePoolAutoEnabled(): boolean {
	return boolEnv("AGENT_RUNTIME_SHARED_POOLS_ENABLED");
}

export function agentRuntimeDedicatedAppId(agentSlug: string): string {
	return `agent-runtime-${agentSlug}`;
}

export function agentRuntimeSlugFromAppId(appId: string | null | undefined): string | null {
	const cleaned = cleanString(appId);
	if (!cleaned) return null;
	if (cleaned.startsWith("agent-runtime-")) {
		return cleaned.slice("agent-runtime-".length) || null;
	}
	return null;
}

export function agentRuntimeInvokeTarget(
	appId: string,
	{
		bffNamespace = process.env.POD_NAMESPACE || "workflow-builder",
		targetNamespace = process.env.AGENT_RUNTIME_NAMESPACE || "workflow-builder",
	}: { bffNamespace?: string; targetNamespace?: string } = {},
): string {
	const runtimeSlug = agentRuntimeSlugFromAppId(appId);
	return runtimeSlug && targetNamespace.trim() && targetNamespace.trim() !== bffNamespace.trim()
		? `${appId}.${targetNamespace.trim()}`
		: appId;
}

export function resolveAgentRuntimeClass(config: AgentConfig | null | undefined): string {
	const explicit = cleanRuntimeClass((config as { runtimeClass?: unknown } | null | undefined)?.runtimeClass);
	if (explicit) return explicit;
	if (config?.runtime === "browser-use-agent") return "browser";
	if (config?.runtime === "dapr-agent-py-testing") return "testing";
	return DEFAULT_RUNTIME_CLASS;
}

function runtimeIsolation(config: AgentConfig | null | undefined): AgentRuntimeIsolation {
	const raw = cleanString((config as { runtimeIsolation?: unknown } | null | undefined)?.runtimeIsolation);
	return raw === "shared" || raw === "dedicated" || raw === "auto" ? raw : "auto";
}

function parsePoolConfigJson(): Record<string, RuntimePoolConfigValue> {
	const raw = cleanString(process.env.AGENT_RUNTIME_POOL_APP_IDS_JSON);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed)) return {};
		const out: Record<string, RuntimePoolConfigValue> = {};
		for (const [key, value] of Object.entries(parsed)) {
			const runtimeClass = cleanRuntimeClass(key);
			if (!runtimeClass) continue;
			if (typeof value === "string") {
				out[runtimeClass] = value;
			} else if (isRecord(value) && typeof value.appId === "string") {
				out[runtimeClass] = value as RuntimePoolConfigValue;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function explicitPoolFromConfig(
	config: AgentConfig | null | undefined,
	runtimeClass: string,
): AgentRuntimePool | null {
	const raw = (config as { runtimePool?: unknown } | null | undefined)?.runtimePool;
	if (!isRecord(raw)) return null;
	const appId = cleanString(raw.appId);
	if (!appId) return null;
	const slug = cleanString(raw.slug) ?? agentRuntimeSlugFromAppId(appId);
	if (!slug) return null;
	return {
		runtimeClass: cleanRuntimeClass(raw.runtimeClass) ?? runtimeClass,
		appId,
		slug,
		minReplicas: cleanPositiveInt(raw.minReplicas),
		maxReplicas: cleanPositiveInt(raw.maxReplicas),
		slotsPerReplica: cleanPositiveInt(raw.slotsPerReplica),
		maxActiveSessions: cleanPositiveInt(raw.maxActiveSessions),
	};
}

export function resolveAgentRuntimePool(
	runtimeClass: string,
	config?: AgentConfig | null,
): AgentRuntimePool | null {
	const explicit = explicitPoolFromConfig(config, runtimeClass);
	if (explicit) return explicit;
	if (!runtimePoolAutoEnabled()) return null;

	const map = parsePoolConfigJson();
	const configured = map[runtimeClass];
	const defaultMaxReplicas = cleanPositiveInt(process.env.AGENT_RUNTIME_POOL_MAX_REPLICAS) ?? 2;
	const defaultMinReplicas = cleanPositiveInt(process.env.AGENT_RUNTIME_POOL_MIN_REPLICAS);
	if (typeof configured === "string") {
		const slug = agentRuntimeSlugFromAppId(configured);
		if (!slug) return null;
		return {
			runtimeClass,
			appId: configured,
			slug,
			minReplicas: defaultMinReplicas,
			maxReplicas: defaultMaxReplicas,
		};
	}
	if (isRecord(configured)) {
		const appId = cleanString(configured.appId);
		const slug = cleanString(configured.slug) ?? agentRuntimeSlugFromAppId(appId);
		if (!appId || !slug) return null;
		return {
			runtimeClass,
			appId,
			slug,
			minReplicas: cleanPositiveInt(configured.minReplicas) ?? defaultMinReplicas,
			maxReplicas: cleanPositiveInt(configured.maxReplicas) ?? defaultMaxReplicas,
			slotsPerReplica: cleanPositiveInt(configured.slotsPerReplica),
			maxActiveSessions: cleanPositiveInt(configured.maxActiveSessions),
		};
	}

	const appId = `${DEFAULT_POOL_PREFIX}${runtimeClass}`;
	return {
		runtimeClass,
		appId,
		slug: agentRuntimeSlugFromAppId(appId) ?? `pool-${runtimeClass}`,
		minReplicas: defaultMinReplicas,
		maxReplicas: defaultMaxReplicas,
	};
}

function dedicatedRuntimeReason(
	config: AgentConfig | null | undefined,
	useBrowserSidecar?: boolean,
): string | null {
	const isolation = runtimeIsolation(config);
	if (isolation === "dedicated") return "agent requested dedicated runtime isolation";
	if (config?.runtime === "browser-use-agent") return "browser-use-agent runtime owns browser state";
	if (config?.runtime === "dapr-agent-py-testing" && isolation !== "shared") {
		return "testing runtime stays on its dedicated app id by default";
	}
	if (useBrowserSidecar === true) return "Playwright MCP browser sidecar requires pod-local placement";
	const servers = Array.isArray(config?.mcpServers) ? config.mcpServers : [];
	if (servers.some((server) => isPlaywrightMcpEntry(server))) {
		return "Playwright MCP browser sidecar requires pod-local placement";
	}
	return null;
}

export function resolveAgentRuntimeRoute(params: {
	agentSlug: string;
	runtimeAppId?: string | null;
	config?: AgentConfig | null;
	useBrowserSidecar?: boolean;
}): AgentRuntimeRoute {
	const runtimeClass = resolveAgentRuntimeClass(params.config);
	const isolation = runtimeIsolation(params.config);
	const defaultDedicatedAppId = agentRuntimeDedicatedAppId(params.agentSlug);
	const explicitRuntimeAppId = cleanString(params.runtimeAppId);
	const dedicatedAppId =
		explicitRuntimeAppId && explicitRuntimeAppId !== defaultDedicatedAppId
			? explicitRuntimeAppId
			: defaultDedicatedAppId;
	const dedicatedSlug = agentRuntimeSlugFromAppId(dedicatedAppId) ?? params.agentSlug;
	const dedicatedReason = dedicatedRuntimeReason(params.config, params.useBrowserSidecar);
	if (dedicatedReason) {
		return {
			appId: dedicatedAppId,
			slug: dedicatedSlug,
			runtimeClass,
			isolation: "dedicated",
			reason: dedicatedReason,
		};
	}

	const pool = resolveAgentRuntimePool(runtimeClass, params.config);
	if (pool && (isolation === "shared" || runtimePoolAutoEnabled())) {
		return {
			appId: pool.appId,
			slug: pool.slug,
			runtimeClass: pool.runtimeClass,
			isolation: "shared",
			reason: isolation === "shared" ? "agent requested shared runtime pool" : "shared runtime pools enabled",
			pool,
		};
	}

	return {
		appId: dedicatedAppId,
		slug: dedicatedSlug,
		runtimeClass,
		isolation: "dedicated",
		reason: "shared runtime pool disabled or unavailable",
	};
}
