/**
 * Capability-bundle flattening (Pillar 2).
 *
 * `flattenBundles()` resolves an `AgentConfig.bundleRefs[]` into the effective
 * config: each referenced bundle's version config (mcpServers / skills / tools /
 * builtinTools / hooks / plugins / prompt presets) is UNIONED into the config.
 * Bundle entries form the base layer; the agent / session / node config wins on
 * key collision. Called BEFORE MCP resolution in both spawn paths
 * (`sessions/spawn.ts`, `agents/resolver.ts`) so bundle-contributed MCP servers
 * participate in project-connection resolution exactly like inline ones.
 *
 * Pure merge helpers ({@link mergeBundleConfig}) are exported + DB-free for unit
 * testing; {@link flattenBundles} is the DB-backed entry point.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	capabilityBundles,
	capabilityBundleVersions,
} from "$lib/server/db/schema";
import type {
	AgentConfig,
	BundleRef,
	CapabilityBundleConfig,
} from "$lib/types/agents";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

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

/** Resolve each ref to its bundle row + version row (pinned version or latest),
 * project-scoped. Shared by {@link flattenBundles} (configs) and
 * {@link resolveBundleProvenance} (identity + per-bundle capability summary) so
 * both observe the exact same version-selection precedence. */
async function loadResolvedBundleVersions(
	refs: BundleRef[],
	projectId: string | null,
): Promise<
	Array<{
		bundle: typeof capabilityBundles.$inferSelect;
		versionRow: typeof capabilityBundleVersions.$inferSelect;
	}>
> {
	const database = requireDb();
	const ids = [...new Set(refs.map((r) => r.id).filter((id): id is string => !!id))];
	if (ids.length === 0) return [];

	const bundleRows = await database
		.select()
		.from(capabilityBundles)
		.where(inArray(capabilityBundles.id, ids));
	const byId = new Map(bundleRows.map((b) => [b.id, b]));

	const out: Array<{
		bundle: typeof capabilityBundles.$inferSelect;
		versionRow: typeof capabilityBundleVersions.$inferSelect;
	}> = [];
	for (const ref of refs) {
		const bundle = byId.get(ref.id);
		if (!bundle || bundle.isArchived) continue;
		// Workspace scope: a bundle bound to a project is only usable in that
		// project (project-less bundles are usable anywhere — curated/global).
		if (projectId && bundle.projectId && bundle.projectId !== projectId) continue;

		let versionRow:
			| typeof capabilityBundleVersions.$inferSelect
			| undefined;
		if (ref.version != null) {
			[versionRow] = await database
				.select()
				.from(capabilityBundleVersions)
				.where(
					and(
						eq(capabilityBundleVersions.bundleId, ref.id),
						eq(capabilityBundleVersions.version, ref.version),
					),
				)
				.limit(1);
		} else if (bundle.currentVersionId) {
			[versionRow] = await database
				.select()
				.from(capabilityBundleVersions)
				.where(eq(capabilityBundleVersions.id, bundle.currentVersionId))
				.limit(1);
		} else {
			[versionRow] = await database
				.select()
				.from(capabilityBundleVersions)
				.where(eq(capabilityBundleVersions.bundleId, ref.id))
				.orderBy(desc(capabilityBundleVersions.version))
				.limit(1);
		}
		if (versionRow) out.push({ bundle, versionRow });
	}
	return out;
}

/** Resolve each ref to its bundle-version config (pinned version or latest), project-scoped. */
async function loadBundleConfigs(
	refs: BundleRef[],
	projectId: string | null,
): Promise<CapabilityBundleConfig[]> {
	const rows = await loadResolvedBundleVersions(refs, projectId);
	return rows.map((r) => r.versionRow.config as CapabilityBundleConfig);
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

/**
 * Per-bundle summary of what each `bundleRefs[]` entry contributes (resolved
 * names of mcpServers / skills / tools / builtinTools) for the
 * compiled-capabilities debug view. Same version precedence as
 * {@link flattenBundles}; returns `[]` when there are no resolvable refs.
 */
export async function resolveBundleProvenance(
	refs: BundleRef[] | null | undefined,
	projectId: string | null | undefined,
): Promise<BundleProvenanceEntry[]> {
	const valid = Array.isArray(refs)
		? refs.filter(
				(r): r is BundleRef => !!r && typeof r.id === "string" && r.id.length > 0,
			)
		: [];
	if (valid.length === 0) return [];
	const rows = await loadResolvedBundleVersions(valid, projectId ?? null);
	return rows.map(({ bundle, versionRow }) => {
		const cfg = (versionRow.config ?? {}) as CapabilityBundleConfig;
		return {
			id: bundle.id,
			name: bundle.name,
			version: versionRow.version,
			mcpServers: (cfg.mcpServers ?? []).map((s) => mcpKey(s)),
			skills: (cfg.skills ?? []).map((s) => skillKey(s)),
			tools: (cfg.tools ?? []).map((t) => String(t)),
			builtinTools: (cfg.builtinTools ?? []).map((t) => String(t)),
		};
	});
}

/**
 * Resolve `config.bundleRefs` into the effective `AgentConfig`. No-op (returns
 * the same reference) when there are no resolvable bundle refs.
 */
export async function flattenBundles(
	config: AgentConfig,
	projectId: string | null | undefined,
): Promise<AgentConfig> {
	const refs = Array.isArray(config.bundleRefs)
		? config.bundleRefs.filter(
				(r): r is BundleRef => !!r && typeof r.id === "string" && r.id.length > 0,
			)
		: [];
	if (refs.length === 0) return config;
	const bundles = await loadBundleConfigs(refs, projectId ?? null);
	if (bundles.length === 0) return config;
	let merged: AgentConfig = { ...config };
	for (const bundle of bundles) merged = mergeBundleConfig(merged, bundle);
	return merged;
}
