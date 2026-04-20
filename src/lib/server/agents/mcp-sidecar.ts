/**
 * Shared helpers for per-agent browser sidecar MCP rewriting.
 *
 * When an agent's MCP config references Playwright (via stdio preset,
 * hosted URL, or name match), we:
 *   1. Flip `browserSidecar.enabled=true` on the AgentRuntime CR so the
 *      controller mounts chromium + playwright-mcp sidecars in the pod.
 *   2. Rewrite the Playwright entry to a streamable-http URL pointing at
 *      the in-pod sidecar (`http://localhost:3100/mcp`). This replaces
 *      the stdio presets (which would try to launch Chrome inside the
 *      dapr-agent-py container — it has no Chromium binary) with a
 *      transport the sidecar actually serves.
 *
 * Both the CR-spec path (registry-sync.ts) and the per-turn dispatch
 * path (sessions/spawn.ts) need this rewrite. The per-turn send wins
 * at runtime (see dapr-agent-py:_ensure_mcp_client_async), so skipping
 * it in spawn.ts leaves the sidecar unused even if the bootstrap env
 * is correct.
 */
type McpServer = {
	name?: string;
	serverName?: string;
	transport?: string;
	url?: string;
	command?: string;
	args?: string[];
	headers?: Record<string, string>;
	env?: Record<string, string>;
	[key: string]: unknown;
};

const SIDECAR_MCP_URL = "http://localhost:3100/mcp";

export function isPlaywrightMcpEntry(s: McpServer | null | undefined): boolean {
	if (!s) return false;
	const n = String(s.name ?? s.serverName ?? "").toLowerCase();
	if (n === "playwright") return true;
	if (String(s.url ?? "").includes("playwright-mcp")) return true;
	const argsStr = (s.args ?? []).join(" ").toLowerCase();
	if (argsStr.includes("@playwright/mcp")) return true;
	return false;
}

export function rewriteMcpForBrowserSidecar<T extends McpServer>(
	mcpServers: T[] | null | undefined,
): { mcpServers: T[]; useBrowserSidecar: boolean } {
	const list = Array.isArray(mcpServers) ? mcpServers : [];
	const playwrightIdx = list.findIndex(isPlaywrightMcpEntry);
	if (playwrightIdx < 0) {
		return { mcpServers: list, useBrowserSidecar: false };
	}
	const rewritten = list.map((s, i) => {
		if (i !== playwrightIdx) return s;
		return {
			...s,
			name: "playwright",
			serverName: "playwright",
			transport: "streamable_http",
			url: SIDECAR_MCP_URL,
			command: undefined,
			args: undefined,
			env: undefined,
		} as T;
	});
	return { mcpServers: rewritten, useBrowserSidecar: true };
}
