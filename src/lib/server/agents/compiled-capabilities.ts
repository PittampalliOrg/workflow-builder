/**
 * Compiled-capabilities debug view.
 *
 * Recomputes the SAME effective `AgentConfig` the runtime receives at spawn —
 * `flattenBundles` (Pillar 2) → `resolveAgentConfigMcpForProject` (project MCP
 * connection resolution) → runtime descriptor + swap-safety verdict — but
 * READ-ONLY: no `runtime.swap_degraded` event is emitted and no name mutation
 * happens. All secret-bearing header/env values are redacted before the result
 * leaves the server, so it is safe to surface in a UI.
 *
 * This shows the RESOLVED config the runtime is HANDED (`agentConfigForDispatch`
 * minus the session-only browser-sidecar / goal-MCP injections), NOT each
 * runtime's internal compile (dapr-agent-py per-activity tool wiring,
 * claude-agent-py SDK materialization, CLI `config.toml`) which lives in the pod
 * and is not reproducible in TS.
 *
 * Mirrors `src/lib/server/sessions/spawn.ts` (lines ~138-176) — keep in sync.
 */
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { agents } from "$lib/server/db/schema";
import { getAgent } from "./registry";
import {
	flattenBundles,
	resolveBundleProvenance,
	type BundleProvenanceEntry,
} from "$lib/server/capabilities/flatten";
import { resolveAgentConfigMcpForProject } from "./mcp-resolution";
import { getRuntimeDescriptor, type RuntimeDescriptor } from "./runtime-registry";
import { evaluateSwap, type SwapVerdict } from "./swap-safety";
import { redactSecrets } from "$lib/server/observability/content";
import type { AgentConfig, BundleRef } from "$lib/types/agents";

export type CompiledCapabilities = {
	agent: { id: string; slug: string; name: string; rowRuntime: string };
	/** Runtime resolved from the effective config (what spawn dispatches to). */
	resolvedRuntime: string | null;
	/** True when config.runtime diverges from the agent-row runtime (a bug). */
	runtimeMismatch: boolean;
	runtimeDescriptor: {
		id: string;
		family: RuntimeDescriptor["family"];
		capabilities: RuntimeDescriptor["capabilities"];
	} | null;
	/** Resolved MCP servers (secrets redacted; X-Connection-External-Id kept). */
	mcpServers: unknown[];
	mcpServerCount: number;
	skills: unknown[];
	tools: string[];
	builtinTools: string[];
	bundleRefs: BundleRef[];
	bundleProvenance: BundleProvenanceEntry[];
	/** Swap-safety verdict (drops always listed; decision gated by env). */
	swapVerdict: SwapVerdict | null;
	/** MCP-connection resolution warnings (unresolved servers, etc.). */
	warnings: string[];
};

async function getAgentProjectId(id: string): Promise<string | null> {
	if (!db) return null;
	const [row] = await db
		.select({ projectId: agents.projectId })
		.from(agents)
		.where(eq(agents.id, id))
		.limit(1);
	return row?.projectId ?? null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/**
 * Compile the effective capability surface for an agent. Returns `null` if the
 * agent does not exist.
 */
export async function compileAgentCapabilities(
	agentId: string,
): Promise<CompiledCapabilities | null> {
	const agent = await getAgent(agentId);
	if (!agent) return null;
	const projectId = await getAgentProjectId(agentId);
	const baseConfig = (agent.config ?? {}) as AgentConfig;

	// Mirror the spawn resolve pipeline (read-only). Bundles flatten BEFORE MCP
	// resolution so bundle-contributed servers resolve like inline ones.
	const flattened = await flattenBundles(baseConfig, projectId);
	const resolutionTarget = getRuntimeDescriptor(
		(flattened as { runtime?: string }).runtime ?? agent.runtime,
	);
	const resolved = (await resolveAgentConfigMcpForProject(
		flattened,
		projectId,
		{
			autoIncludesProjectConnections:
				resolutionTarget?.cliAdapter !== "antigravity",
		},
	)) as AgentConfig & {
		mcpServers?: unknown[];
		mcpConnectionWarnings?: unknown[];
	};

	const rowRuntime = agent.runtime;
	const resolvedRuntime =
		(resolved as { runtime?: string }).runtime ?? rowRuntime ?? null;

	// Swap-safety: target = the runtime spawn would dispatch to (resolved
	// config.runtime); source family = the agent row's declared runtime. This is
	// exactly spawn.ts's gate, so a config.runtime/row divergence surfaces here as
	// an interactionModel/provider/mcp drop.
	const target = getRuntimeDescriptor(resolvedRuntime ?? undefined);
	const swapVerdict: SwapVerdict | null = target
		? evaluateSwap(resolved as Record<string, unknown>, target, {
				sourceFamily: getRuntimeDescriptor(rowRuntime)?.family ?? null,
			})
		: null;

	const provenance = await resolveBundleProvenance(
		baseConfig.bundleRefs,
		projectId,
	);

	const rawMcp = Array.isArray(resolved.mcpServers) ? resolved.mcpServers : [];
	const warnings = asStringArray(resolved.mcpConnectionWarnings);

	return {
		agent: {
			id: agent.id,
			slug: agent.slug,
			name: agent.name,
			rowRuntime,
		},
		resolvedRuntime,
		runtimeMismatch:
			!!resolvedRuntime && !!rowRuntime && resolvedRuntime !== rowRuntime,
		runtimeDescriptor: target
			? {
					id: target.id,
					family: target.family,
					capabilities: target.capabilities,
				}
			: null,
		// Redact at the LAST step so a future resolver that injects a secret can't
		// leak through this debug surface.
		mcpServers: redactSecrets(rawMcp),
		mcpServerCount: rawMcp.length,
		skills: Array.isArray((resolved as { skills?: unknown[] }).skills)
			? ((resolved as { skills: unknown[] }).skills as unknown[])
			: [],
		tools: asStringArray((resolved as { tools?: unknown[] }).tools),
		builtinTools: asStringArray(
			(resolved as { builtinTools?: unknown[] }).builtinTools,
		),
		bundleRefs: Array.isArray(baseConfig.bundleRefs)
			? baseConfig.bundleRefs
			: [],
		bundleProvenance: provenance,
		swapVerdict,
		warnings,
	};
}
