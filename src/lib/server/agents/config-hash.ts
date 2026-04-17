import { createHash } from "node:crypto";
import type { AgentConfig } from "$lib/types/agents";

/**
 * Canonical JSON stringification: object keys sorted, arrays preserved in
 * insertion order, undefined stripped. Used to produce a stable sha256 of an
 * AgentConfig for dedupe during backfill and for the config_hash column.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function hashAgentConfig(config: AgentConfig): string {
	return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

function canonicalize(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		const out: Record<string, unknown> = {};
		for (const [k, v] of entries) out[k] = canonicalize(v);
		return out;
	}
	return value;
}
