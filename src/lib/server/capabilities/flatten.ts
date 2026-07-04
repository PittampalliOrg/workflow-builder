/**
 * Capability-bundle flattening (Pillar 2).
 *
 * The merge helpers in this module are DB-free. Application services resolve
 * `AgentConfig.bundleRefs[]` through a repository, then call these helpers to
 * build the effective config before MCP resolution.
 */
import type {
	AgentConfig,
	CapabilityBundleConfig,
} from "$lib/types/agents";

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Identity key for de-duping an MCP server across config + bundles. */
function mcpKey(server: unknown): string {
	const r = asRecord(server);
	return String(
		r.serverName ?? r.server_name ?? r.name ?? r.pieceName ?? r.displayName ?? r.serverUrl ?? r.url ?? r.command ?? JSON.stringify(server),
	);
}

/** Identity key for de-duping a skill across config + bundles. */
function skillKey(skill: unknown): string {
	const r = asRecord(skill);
	return String(r.registryId ?? r.registry_id ?? r.slug ?? r.name ?? JSON.stringify(skill));
}

/** Identity key for de-duping a prompt-preset ref. */
function presetKey(ref: unknown): string {
	const r = asRecord(ref);
	return String(r.promptId ?? r.id ?? JSON.stringify(ref));
}

/**
 * Merge two arrays: `base` entries first (bundle layer), then `top` entries
 * (config layer) overwriting on key collision so the config wins. Stable
 * bundle-first ordering — matters for prompt presets (render order).
 */
function mergeArray<T>(
	base: T[] | undefined,
	top: T[] | undefined,
	keyOf: (x: T) => string,
): T[] {
	const map = new Map<string, T>();
	for (const x of Array.isArray(base) ? base : []) map.set(keyOf(x), x);
	for (const x of Array.isArray(top) ? top : []) map.set(keyOf(x), x);
	return [...map.values()];
}

/** Per-event concat of hook matchers: bundle hooks then config hooks both apply. */
function mergeHooks(
	base: AgentConfig["hooks"] | undefined,
	top: AgentConfig["hooks"] | undefined,
): AgentConfig["hooks"] {
	const out: Record<string, unknown[]> = {};
	for (const [evt, arr] of Object.entries(base ?? {})) {
		out[evt] = [...(Array.isArray(arr) ? arr : [])];
	}
	for (const [evt, arr] of Object.entries(top ?? {})) {
		out[evt] = [...(out[evt] ?? []), ...(Array.isArray(arr) ? arr : [])];
	}
	return out as AgentConfig["hooks"];
}

/**
 * Merge one bundle's capability config into an agent config (pure, DB-free).
 * Config wins on key collision; arrays are unioned (bundle-base, config-top).
 */
export function mergeBundleConfig(
	config: AgentConfig,
	bundle: CapabilityBundleConfig,
): AgentConfig {
	const next: AgentConfig = { ...config };
	next.mcpServers = mergeArray(bundle.mcpServers, config.mcpServers, mcpKey);
	next.skills = mergeArray(bundle.skills, config.skills, skillKey);
	next.builtinTools = mergeArray(bundle.builtinTools, config.builtinTools, String);
	if (bundle.tools !== undefined || config.tools !== undefined) {
		next.tools = mergeArray(bundle.tools, config.tools, String);
	}
	if (bundle.plugins !== undefined || config.plugins !== undefined) {
		next.plugins = mergeArray(bundle.plugins, config.plugins, String);
	}
	if (bundle.staticPromptPresetRefs !== undefined || config.staticPromptPresetRefs !== undefined) {
		next.staticPromptPresetRefs = mergeArray(
			bundle.staticPromptPresetRefs,
			config.staticPromptPresetRefs,
			presetKey,
		);
	}
	if (bundle.dynamicPromptPresetRefs !== undefined || config.dynamicPromptPresetRefs !== undefined) {
		next.dynamicPromptPresetRefs = mergeArray(
			bundle.dynamicPromptPresetRefs,
			config.dynamicPromptPresetRefs,
			presetKey,
		);
	}
	if (bundle.hooks !== undefined || config.hooks !== undefined) {
		next.hooks = mergeHooks(bundle.hooks, config.hooks);
	}
	return next;
}

export type BundleProvenanceEntry = {
	id: string;
	name: string;
	version: number;
	mcpServers: string[];
	skills: string[];
	tools: string[];
	builtinTools: string[];
};

export type ResolvedCapabilityBundleVersion = {
	id: string;
	name: string;
	version: number;
	config: CapabilityBundleConfig;
};

export function resolveBundleProvenanceFromVersions(
	rows: ResolvedCapabilityBundleVersion[],
): BundleProvenanceEntry[] {
	return rows.map((row) => {
		const cfg = row.config ?? {};
		return {
			id: row.id,
			name: row.name,
			version: row.version,
			mcpServers: (cfg.mcpServers ?? []).map((s) => mcpKey(s)),
			skills: (cfg.skills ?? []).map((s) => skillKey(s)),
			tools: (cfg.tools ?? []).map((t) => String(t)),
			builtinTools: (cfg.builtinTools ?? []).map((t) => String(t)),
		};
	});
}

/**
 * Merge already-resolved bundle configs into the effective `AgentConfig`.
 * No-op (returns the same reference) when there are no resolvable bundle refs.
 */
export function flattenBundleConfigs(
	config: AgentConfig,
	bundles: CapabilityBundleConfig[],
): AgentConfig {
	if (bundles.length === 0) return config;
	let merged: AgentConfig = { ...config };
	for (const bundle of bundles) merged = mergeBundleConfig(merged, bundle);
	return merged;
}
