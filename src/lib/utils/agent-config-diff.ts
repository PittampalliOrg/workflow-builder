import type {
	AgentConfig,
	AgentHooksConfig,
	BundleRef,
	PromptPresetRef,
} from "$lib/types/agents";
import type {
	AgentSkillConfig,
} from "$lib/agent-skill-presets";
import type { McpServerProfileConfig } from "$lib/server/agent-profiles";

export type ConfigDiffKind = "added" | "removed" | "changed";

export interface ConfigDiffEntry {
	/** Human-readable dotted path, e.g. `modelSpec`, `skills[code-review]`,
	 *  `mcpServers[playwright]`, `hooks[PreToolUse]`. */
	path: string;
	/** Short label rendered in summaries — e.g. `model`, `skill code-review`. */
	label: string;
	/** Top-level group for grouped rendering — e.g. `model`, `skills`,
	 *  `mcpServers`, `prompt`, `tools`, `hooks`, `runtime`. */
	group: ConfigDiffGroup;
	kind: ConfigDiffKind;
	before?: unknown;
	after?: unknown;
}

export type ConfigDiffGroup =
	| "model"
	| "prompt"
	| "tools"
	| "skills"
	| "mcpServers"
	| "vaults"
	| "hooks"
	| "callableAgents"
	| "bundles"
	| "runtime"
	| "memory"
	| "browserArtifacts"
	| "sandboxPolicy"
	| "other";

const PRIMITIVE_KEYS: Array<{ key: keyof AgentConfig; group: ConfigDiffGroup; label: string }> = [
	{ key: "modelSpec", group: "model", label: "model" },
	{ key: "temperature", group: "model", label: "temperature" },
	{ key: "toolChoice", group: "tools", label: "toolChoice" },
	{ key: "cacheTtl", group: "model", label: "cacheTtl" },
	{ key: "maxTurns", group: "runtime", label: "maxTurns" },
	{ key: "timeoutMinutes", group: "runtime", label: "timeoutMinutes" },
	{ key: "cwd", group: "runtime", label: "cwd" },
	{ key: "systemPrompt", group: "prompt", label: "systemPrompt" },
	{ key: "runtime", group: "runtime", label: "runtime" },
	{ key: "runtimeClass", group: "runtime", label: "runtimeClass" },
	{ key: "runtimeIsolation", group: "runtime", label: "runtimeIsolation" },
	{ key: "mcpConnectionMode", group: "mcpServers", label: "mcpConnectionMode" },
];

function eq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === undefined || a === null || b === undefined || b === null) return a === b;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	if (typeof a === "object" && typeof b === "object") {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return false;
}

function diffPrimitive(
	before: AgentConfig,
	after: AgentConfig,
	out: ConfigDiffEntry[],
): void {
	for (const { key, group, label } of PRIMITIVE_KEYS) {
		const b = before[key];
		const a = after[key];
		if (!eq(b, a)) {
			const isAdded = (b === undefined || b === null || b === "") && a !== undefined && a !== null && a !== "";
			const isRemoved = (a === undefined || a === null || a === "") && b !== undefined && b !== null && b !== "";
			out.push({
				path: String(key),
				label,
				group,
				kind: isAdded ? "added" : isRemoved ? "removed" : "changed",
				before: b,
				after: a,
			});
		}
	}
}

function diffStringArray(
	groupKey: keyof AgentConfig,
	group: ConfigDiffGroup,
	before: AgentConfig,
	after: AgentConfig,
	out: ConfigDiffEntry[],
): void {
	const b = (before[groupKey] as string[] | undefined) ?? [];
	const a = (after[groupKey] as string[] | undefined) ?? [];
	const beforeSet = new Set(b);
	const afterSet = new Set(a);
	for (const v of a) {
		if (!beforeSet.has(v)) {
			out.push({
				path: `${String(groupKey)}[${v}]`,
				label: v,
				group,
				kind: "added",
				after: v,
			});
		}
	}
	for (const v of b) {
		if (!afterSet.has(v)) {
			out.push({
				path: `${String(groupKey)}[${v}]`,
				label: v,
				group,
				kind: "removed",
				before: v,
			});
		}
	}
}

function skillKey(s: AgentSkillConfig): string {
	return s.slug ?? s.name ?? "";
}

function diffSkills(before: AgentConfig, after: AgentConfig, out: ConfigDiffEntry[]): void {
	const beforeMap = new Map<string, AgentSkillConfig>();
	const afterMap = new Map<string, AgentSkillConfig>();
	for (const s of before.skills ?? []) beforeMap.set(skillKey(s), s);
	for (const s of after.skills ?? []) afterMap.set(skillKey(s), s);
	for (const [k, a] of afterMap) {
		const b = beforeMap.get(k);
		if (!b) {
			out.push({
				path: `skills[${k}]`,
				label: `skill ${k}`,
				group: "skills",
				kind: "added",
				after: a,
			});
		} else if (!eq(b, a)) {
			out.push({
				path: `skills[${k}]`,
				label: `skill ${k}`,
				group: "skills",
				kind: "changed",
				before: b,
				after: a,
			});
		}
	}
	for (const [k, b] of beforeMap) {
		if (!afterMap.has(k)) {
			out.push({
				path: `skills[${k}]`,
				label: `skill ${k}`,
				group: "skills",
				kind: "removed",
				before: b,
			});
		}
	}
}

function mcpKey(m: McpServerProfileConfig): string {
	return m.server_name ?? m.displayName ?? "";
}

function diffMcpServers(before: AgentConfig, after: AgentConfig, out: ConfigDiffEntry[]): void {
	const beforeMap = new Map<string, McpServerProfileConfig>();
	const afterMap = new Map<string, McpServerProfileConfig>();
	for (const m of before.mcpServers ?? []) beforeMap.set(mcpKey(m), m);
	for (const m of after.mcpServers ?? []) afterMap.set(mcpKey(m), m);
	for (const [k, a] of afterMap) {
		const b = beforeMap.get(k);
		if (!b) {
			out.push({
				path: `mcpServers[${k}]`,
				label: `MCP ${k}`,
				group: "mcpServers",
				kind: "added",
				after: a,
			});
		} else if (!eq(b, a)) {
			out.push({
				path: `mcpServers[${k}]`,
				label: `MCP ${k}`,
				group: "mcpServers",
				kind: "changed",
				before: b,
				after: a,
			});
		}
	}
	for (const [k, b] of beforeMap) {
		if (!afterMap.has(k)) {
			out.push({
				path: `mcpServers[${k}]`,
				label: `MCP ${k}`,
				group: "mcpServers",
				kind: "removed",
				before: b,
			});
		}
	}
}

function presetKey(p: PromptPresetRef): string {
	return `${p.id}@v${p.version}`;
}

function diffPromptPresetRefs(
	groupKey: "staticPromptPresetRefs" | "dynamicPromptPresetRefs",
	before: AgentConfig,
	after: AgentConfig,
	out: ConfigDiffEntry[],
): void {
	const b = (before[groupKey] as PromptPresetRef[] | undefined) ?? [];
	const a = (after[groupKey] as PromptPresetRef[] | undefined) ?? [];
	const beforeSet = new Set(b.map(presetKey));
	const afterSet = new Set(a.map(presetKey));
	for (const ref of a) {
		const k = presetKey(ref);
		if (!beforeSet.has(k)) {
			out.push({
				path: `${groupKey}[${k}]`,
				label: `${groupKey === "staticPromptPresetRefs" ? "static preset" : "dynamic preset"} ${ref.id}`,
				group: "prompt",
				kind: "added",
				after: ref,
			});
		}
	}
	for (const ref of b) {
		const k = presetKey(ref);
		if (!afterSet.has(k)) {
			out.push({
				path: `${groupKey}[${k}]`,
				label: `${groupKey === "staticPromptPresetRefs" ? "static preset" : "dynamic preset"} ${ref.id}`,
				group: "prompt",
				kind: "removed",
				before: ref,
			});
		}
	}
}

function diffHooks(before: AgentConfig, after: AgentConfig, out: ConfigDiffEntry[]): void {
	const b: AgentHooksConfig = before.hooks ?? {};
	const a: AgentHooksConfig = after.hooks ?? {};
	const events = new Set([...Object.keys(b), ...Object.keys(a)]);
	for (const evt of events) {
		const beforeMatchers = b[evt] ?? [];
		const afterMatchers = a[evt] ?? [];
		if (!eq(beforeMatchers, afterMatchers)) {
			const isAdded = beforeMatchers.length === 0 && afterMatchers.length > 0;
			const isRemoved = beforeMatchers.length > 0 && afterMatchers.length === 0;
			out.push({
				path: `hooks[${evt}]`,
				label: `hook ${evt}`,
				group: "hooks",
				kind: isAdded ? "added" : isRemoved ? "removed" : "changed",
				before: beforeMatchers,
				after: afterMatchers,
			});
		}
	}
}

function diffMemoryAndArtifacts(
	before: AgentConfig,
	after: AgentConfig,
	out: ConfigDiffEntry[],
): void {
	if (!eq(before.memory, after.memory)) {
		out.push({
			path: "memory",
			label: "memory",
			group: "memory",
			kind: "changed",
			before: before.memory,
			after: after.memory,
		});
	}
	if (!eq(before.browserArtifacts, after.browserArtifacts)) {
		out.push({
			path: "browserArtifacts",
			label: "browserArtifacts",
			group: "browserArtifacts",
			kind: "changed",
			before: before.browserArtifacts,
			after: after.browserArtifacts,
		});
	}
	if (!eq(before.sandboxPolicy, after.sandboxPolicy)) {
		out.push({
			path: "sandboxPolicy",
			label: "sandboxPolicy",
			group: "sandboxPolicy",
			kind: "changed",
			before: before.sandboxPolicy,
			after: after.sandboxPolicy,
		});
	}
	if (!eq(before.runtimePool, after.runtimePool)) {
		out.push({
			path: "runtimePool",
			label: "runtimePool",
			group: "runtime",
			kind: "changed",
			before: before.runtimePool,
			after: after.runtimePool,
		});
	}
}

function diffBundleRefs(
	before: AgentConfig,
	after: AgentConfig,
	out: ConfigDiffEntry[],
): void {
	const b = Array.isArray(before.bundleRefs) ? before.bundleRefs : [];
	const a = Array.isArray(after.bundleRefs) ? after.bundleRefs : [];
	const beforeById = new Map<string, BundleRef>(b.map((r) => [r.id, r]));
	const afterById = new Map<string, BundleRef>(a.map((r) => [r.id, r]));
	for (const r of a) {
		const prev = beforeById.get(r.id);
		if (!prev) {
			out.push({ path: `bundleRefs[${r.id}]`, label: r.id, group: "bundles", kind: "added", after: r });
		} else if (prev.version !== r.version) {
			out.push({
				path: `bundleRefs[${r.id}]`,
				label: r.id,
				group: "bundles",
				kind: "changed",
				before: prev,
				after: r,
			});
		}
	}
	for (const r of b) {
		if (!afterById.has(r.id)) {
			out.push({ path: `bundleRefs[${r.id}]`, label: r.id, group: "bundles", kind: "removed", before: r });
		}
	}
}

/**
 * Compute a per-field diff between two AgentConfig snapshots.
 * Order: model → prompt → tools/builtinTools → skills → mcpServers →
 * callableAgents → hooks → runtime/memory/sandbox.
 *
 * Stable in-order so the UI renders a consistent list. Empty result means
 * the configs are equivalent (use `isAgentConfigEquivalent`).
 */
export function diffAgentConfig(
	before: AgentConfig | null | undefined,
	after: AgentConfig | null | undefined,
): ConfigDiffEntry[] {
	const out: ConfigDiffEntry[] = [];
	if (!before || !after) return out;
	diffPrimitive(before, after, out);
	diffPromptPresetRefs("staticPromptPresetRefs", before, after, out);
	diffPromptPresetRefs("dynamicPromptPresetRefs", before, after, out);
	diffStringArray("builtinTools", "tools", before, after, out);
	diffStringArray("tools", "tools", before, after, out);
	diffStringArray("plugins", "tools", before, after, out);
	diffSkills(before, after, out);
	diffMcpServers(before, after, out);
	diffStringArray("callableAgents", "callableAgents", before, after, out);
	diffBundleRefs(before, after, out);
	diffHooks(before, after, out);
	diffMemoryAndArtifacts(before, after, out);
	return out;
}

export function isAgentConfigEquivalent(
	a: AgentConfig | null | undefined,
	b: AgentConfig | null | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return diffAgentConfig(a, b).length === 0;
}

/**
 * Short human summary like "model · +2 skills · -1 MCP · prompt".
 * Returns empty string when there are no diffs.
 */
export function summarizeDiff(diff: readonly ConfigDiffEntry[]): string {
	if (diff.length === 0) return "";
	const counts = new Map<ConfigDiffGroup, { added: number; removed: number; changed: number }>();
	for (const entry of diff) {
		const c = counts.get(entry.group) ?? { added: 0, removed: 0, changed: 0 };
		c[entry.kind] += 1;
		counts.set(entry.group, c);
	}
	const parts: string[] = [];
	const ordered: ConfigDiffGroup[] = [
		"model",
		"prompt",
		"tools",
		"skills",
		"mcpServers",
		"callableAgents",
		"bundles",
		"hooks",
		"runtime",
		"memory",
		"browserArtifacts",
		"sandboxPolicy",
		"vaults",
		"other",
	];
	for (const g of ordered) {
		const c = counts.get(g);
		if (!c) continue;
		const bits: string[] = [];
		if (c.added) bits.push(`+${c.added}`);
		if (c.removed) bits.push(`-${c.removed}`);
		if (c.changed && !c.added && !c.removed) bits.push("~");
		parts.push(`${bits.join("/")} ${g}`);
	}
	return parts.join(" · ");
}

/**
 * Group diff entries by their group for grouped UI rendering.
 */
export function groupDiff(
	diff: readonly ConfigDiffEntry[],
): Map<ConfigDiffGroup, ConfigDiffEntry[]> {
	const grouped = new Map<ConfigDiffGroup, ConfigDiffEntry[]>();
	for (const entry of diff) {
		const list = grouped.get(entry.group) ?? [];
		list.push(entry);
		grouped.set(entry.group, list);
	}
	return grouped;
}
