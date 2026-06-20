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
 *
 * CARVE-OUT — interactive-cli family: those pods ship Chromium in the
 * image (openshell-sandbox base at /opt/pw-browsers) and run
 * `@playwright/mcp` over **stdio in-pod**, so the localhost:3100 sidecar
 * (which only exists for dapr-agent-py pods that have no Chromium) must
 * NOT be substituted in. Callers pass the resolved runtime so the
 * rewrite is skipped when the descriptor declares `interactiveTerminal`.
 */
import { getRuntimeDescriptor } from "./runtime-registry";

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

/**
 * True when the runtime hosts Chromium in-pod and runs Playwright MCP over
 * stdio (interactive-cli family). Such runtimes must keep the stdio preset
 * rather than have it rewritten to the dapr-agent-py-only :3100 sidecar.
 */
export function runtimeHasInPodBrowser(
	runtime: string | null | undefined,
): boolean {
	if (!runtime) return false;
	return getRuntimeDescriptor(runtime)?.capabilities.interactiveTerminal === true;
}

export function rewriteMcpForBrowserSidecar<T extends McpServer>(
	mcpServers: T[] | null | undefined,
	opts?: { runtime?: string | null },
): { mcpServers: T[]; useBrowserSidecar: boolean } {
	const list = Array.isArray(mcpServers) ? mcpServers : [];
	// interactive-cli pods have Chromium in-image + run @playwright/mcp via
	// stdio; never substitute the localhost:3100 sidecar (it doesn't exist
	// there). Leave the stdio preset untouched.
	if (runtimeHasInPodBrowser(opts?.runtime)) {
		return { mcpServers: list, useBrowserSidecar: false };
	}
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
