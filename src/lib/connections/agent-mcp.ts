/**
 * Browser-side helpers for the agent "Tools & Integrations" surface.
 *
 * Framework-free (no Svelte imports) so the helpers can be unit-tested and
 * reused across the agent detail page + the session config drawer. These
 * helpers only ever touch `config.mcpServers[i].allowedTools` — they never
 * mutate the project-wide `mcp_connection.metadata.toolSelection` ceiling.
 */

import type { McpServerProfileConfig } from '$lib/server/agent-profiles';

/**
 * Availability entry shape returned by `GET /api/mcp-connections/availability`
 * (a subset of `McpServerAvailabilityEntry`). Declared locally so this module
 * stays framework/server-free; the fields used here are stable.
 */
export type McpAvailabilityEntryLite = {
	pieceName: string;
	canonicalPieceName: string;
	displayName: string;
	description: string | null;
	logoUrl: string | null;
	categories: string[];
	actionCount: number;
	registered: boolean;
	enabled: boolean;
	ready: boolean;
	authStatus: string;
	authStatusLabel: string;
	mcpConnectionExternalId: string | null;
	mcpConnection: {
		id: string;
		displayName: string;
		sourceType: string;
		pieceName: string | null;
		serverKey: string | null;
		connectionExternalId: string | null;
		serverUrl: string | null;
		status: string;
		metadata: Record<string, unknown> | null;
	} | null;
};

/** ~tokens a single tool definition adds to the per-turn system prompt. */
export const TOOL_TOKEN_ESTIMATE = 180;

/** Tool-surface warning thresholds (client-side heuristics, labeled `~`). */
export const TOOL_SURFACE_WARN_COUNT = 40;
export const TOOL_SURFACE_WARN_TOKENS = 8000;

/**
 * Browser MCP presets (stdio/sidecar). Consolidated here so the attach sheet
 * and the agent profile defaults share one definition (previously duplicated
 * across `agent-mcp-picker.svelte` and `agent-profiles.ts`).
 */
export const BROWSER_MCP_PRESETS: McpServerProfileConfig[] = [
	{
		server_name: 'playwright',
		displayName: 'Playwright',
		sourceType: 'preset',
		transport: 'stdio',
		command: 'npx',
		args: ['@playwright/mcp@latest']
	},
	{
		server_name: 'chrome_devtools',
		displayName: 'Chrome DevTools',
		sourceType: 'preset',
		transport: 'stdio',
		command: 'npx',
		args: ['chrome-devtools-mcp@latest']
	},
	{
		server_name: 'claude_in_chrome',
		displayName: 'Claude in Chrome',
		sourceType: 'preset',
		transport: 'stdio',
		command: 'claude',
		args: ['--claude-in-chrome-mcp']
	}
];

/** Normalize an arbitrary label into a safe MCP `server_name` segment. */
function normalizeName(value: unknown): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, '')
		.replace(/[^a-z0-9_-]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');
}

/** Normalize a piece name to its canonical hyphenated slug. */
export function normalizePiece(value: string | null | undefined): string {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, '')
		.replace(/[_\s]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/** Deterministic key for a server config (used for dedupe + remove). */
export function serverKey(server: McpServerProfileConfig): string {
	return (
		server.mcpConnectionExternalId ??
		server.server_name ??
		server.serverName ??
		server.name ??
		server.displayName ??
		''
	);
}

/**
 * Build the `McpServerProfileConfig` for attaching a piece-backed MCP server
 * to an agent from its availability entry. The `mcpConnectionExternalId`
 * carries the project `mcp_connection.id` so resolution binds to the enabled
 * project server (and its credential). `allowedTools` is intentionally absent
 * — "all enabled" (inherit the project ceiling), never `[]`.
 */
export function attachPieceServerConfig(
	entry: McpAvailabilityEntryLite
): McpServerProfileConfig {
	const base = entry.pieceName || entry.displayName;
	return {
		server_name: normalizeName(`piece_${base}`),
		displayName: entry.displayName,
		sourceType: 'nimble_piece',
		pieceName: entry.pieceName,
		mcpConnectionExternalId: entry.mcpConnection?.id ?? entry.mcpConnectionExternalId ?? null,
		transport: 'streamable_http'
	};
}

/** True when an attached server already represents this availability entry. */
export function serverMatchesEntry(
	server: McpServerProfileConfig,
	entry: McpAvailabilityEntryLite
): boolean {
	if (
		entry.mcpConnection?.id &&
		server.mcpConnectionExternalId === entry.mcpConnection.id
	) {
		return true;
	}
	if (server.sourceType === 'nimble_piece' && server.pieceName) {
		return normalizePiece(server.pieceName) === normalizePiece(entry.pieceName);
	}
	return false;
}

/**
 * Compute the EFFECTIVE per-agent tool set for one attached server.
 *
 * Two-level model:
 *  - `ceiling` = the project tool selection (workspace-disabled tools excluded);
 *    `null` = unbounded (no project narrowing → all live tools allowed).
 *  - `server.allowedTools` ABSENT = inherit the ceiling (or all live tools when
 *    ceiling is null); PRESENT = exactly that set, intersected with the ceiling.
 *
 * INVARIANT: `allowedTools: []` means "all DISABLED" (returns an empty set) —
 * it is never treated as "all". Callers must delete the key (not write `[]`) to
 * reset back to the workspace default.
 */
export function effectiveAgentTools(
	server: McpServerProfileConfig,
	ceiling: string[] | null,
	liveToolNames: string[]
): { enabled: Set<string>; count: number } {
	const ceilingSet = ceiling === null ? null : new Set(ceiling);
	// The universe of tools this agent could possibly enable.
	const universe = liveToolNames.filter((name) => (ceilingSet ? ceilingSet.has(name) : true));

	if (!Array.isArray(server.allowedTools)) {
		// Absent → inherit the whole ceiling (∩ live tools).
		const enabled = new Set(universe);
		return { enabled, count: enabled.size };
	}

	// Present → exactly the agent narrowing, intersected with the ceiling.
	const agent = new Set(
		server.allowedTools.map((tool) => String(tool || '').trim()).filter(Boolean)
	);
	const enabled = new Set(
		[...agent].filter((name) => (ceilingSet ? ceilingSet.has(name) : true))
	);
	return { enabled, count: enabled.size };
}

/**
 * Materialize an explicit `allowedTools` list from the current effective set —
 * used the first time a user narrows a server that was inheriting the ceiling.
 * Accepts any iterable of tool names; returns a stable, de-duped, sorted array.
 */
export function materializeAllowedTools(currentEffective: Iterable<string>): string[] {
	return [...new Set(currentEffective)].sort();
}

/** Rough per-turn token cost of registering `n` tool definitions (heuristic). */
export function estimateToolTokens(n: number): number {
	return Math.max(0, Math.round(n)) * TOOL_TOKEN_ESTIMATE;
}
