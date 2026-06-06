/**
 * Swap-safety gate (Phase 3 of the DurableSessionRuntime standardization).
 *
 * The registry's per-runtime capability descriptors (Phase 1/2) make runtime
 * differences DECLARED. This gate uses them to detect when running an agent on a
 * given runtime would silently drop a capability the agent's config relies on —
 * e.g. an MCP-dependent agent on a runtime with `supportsMcp:false`, or a
 * DeepSeek model on an Anthropic-only runtime.
 *
 * Severity: MCP loss and provider mismatch are `reject`-class (silently dropping
 * tools / coercing the model is unacceptable); hooks/plugins/permission-gating/
 * durability downgrades are `warn`-class (degraded but functional).
 *
 * Rollout discipline: WARN-first. `decision` only becomes `"reject"` when
 * rejection is explicitly enabled (`AGENT_RUNTIME_REJECT_LOSSY_SWAP=true`), so the
 * gate logs every degraded swap before it starts hard-failing them — letting an
 * operator audit existing pins first. The per-activity-vs-per-turn durability
 * difference is preserved as a declared, surfaced property, never erased.
 */
import { env } from "$env/dynamic/private";
import type { RuntimeDescriptor } from "./runtime-registry";

export type SwapSeverity = "reject" | "warn";

export type SwapDrop = {
	capability: "mcp" | "provider" | "hooks" | "plugins" | "permissionGating" | "durability";
	severity: SwapSeverity;
	detail: string;
};

export type SwapVerdict = {
	decision: "allow" | "warn" | "reject";
	drops: SwapDrop[];
};

export type AgentRequirements = {
	mcp: boolean;
	hooks: boolean;
	plugins: boolean;
	permissionGating: boolean;
	provider: string | null;
	durability: "per-activity" | null;
};

/** Extract the provider from a `provider/model` modelSpec (or a bare model name). */
export function resolveModelProvider(modelSpec: string | null | undefined): string | null {
	const raw = (modelSpec ?? "").trim().toLowerCase();
	if (!raw) return null;
	const slash = raw.indexOf("/");
	if (slash > 0) return raw.slice(0, slash);
	if (raw.startsWith("claude-")) return "anthropic";
	if (raw.startsWith("gpt") || raw.startsWith("o1") || raw.startsWith("o3")) return "openai";
	if (raw.startsWith("gemini")) return "gemini";
	return null;
}

/** Derive the capabilities an agent's config depends on. */
export function deriveAgentRequirements(
	config: Record<string, unknown> | null | undefined
): AgentRequirements {
	const c = (config ?? {}) as Record<string, unknown>;
	const mcpServers = c.mcpServers;
	const hooks = c.hooks;
	const plugins = c.plugins;
	const permissionMode = typeof c.permissionMode === "string" ? c.permissionMode : null;
	return {
		mcp: Array.isArray(mcpServers) && mcpServers.length > 0,
		hooks: !!hooks && typeof hooks === "object" && Object.keys(hooks as object).length > 0,
		plugins: Array.isArray(plugins) && plugins.length > 0,
		permissionGating:
			!!permissionMode && permissionMode !== "bypassPermissions" && permissionMode !== "bypass",
		provider: resolveModelProvider(typeof c.modelSpec === "string" ? c.modelSpec : null),
		durability: c.requiresDurability === "per-activity" ? "per-activity" : null
	};
}

export function rejectLossySwapEnabled(): boolean {
	const raw = (env.AGENT_RUNTIME_REJECT_LOSSY_SWAP ?? process.env.AGENT_RUNTIME_REJECT_LOSSY_SWAP ?? "")
		.trim()
		.toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Compare an agent's requirements against a target runtime's declared capabilities. */
export function assertSwapSafe(
	requirements: AgentRequirements,
	target: RuntimeDescriptor,
	opts?: { rejectEnabled?: boolean }
): SwapVerdict {
	const caps = target.capabilities;
	const drops: SwapDrop[] = [];

	if (requirements.mcp && !caps.supportsMcp) {
		drops.push({
			capability: "mcp",
			severity: "reject",
			detail: `agent declares MCP servers but runtime "${target.id}" does not support MCP`
		});
	}
	if (requirements.provider && !caps.supportedProviders.includes(requirements.provider)) {
		drops.push({
			capability: "provider",
			severity: "reject",
			detail: `model provider "${requirements.provider}" is not in runtime "${target.id}" supportedProviders [${caps.supportedProviders.join(", ")}]`
		});
	}
	if (requirements.hooks && !caps.supportsHooks) {
		drops.push({
			capability: "hooks",
			severity: "warn",
			detail: `agent declares hooks but runtime "${target.id}" does not support hooks`
		});
	}
	if (requirements.plugins && !caps.supportsPlugins) {
		drops.push({
			capability: "plugins",
			severity: "warn",
			detail: `agent declares plugins but runtime "${target.id}" does not support plugins`
		});
	}
	if (requirements.permissionGating && !caps.supportsPermissionGating) {
		drops.push({
			capability: "permissionGating",
			severity: "warn",
			detail: `agent uses a non-bypass permission mode but runtime "${target.id}" does not enforce permission gating`
		});
	}
	if (requirements.durability === "per-activity" && caps.durabilityGranularity === "per-turn") {
		drops.push({
			capability: "durability",
			severity: "warn",
			detail: `agent requires per-activity durability but runtime "${target.id}" is per-turn (coarser crash recovery)`
		});
	}

	const rejectEnabled = opts?.rejectEnabled ?? rejectLossySwapEnabled();
	const hasReject = drops.some((d) => d.severity === "reject");
	const decision: SwapVerdict["decision"] =
		hasReject && rejectEnabled ? "reject" : drops.length > 0 ? "warn" : "allow";
	return { decision, drops };
}

/**
 * Convenience for call sites: run the gate against an agentConfig + target,
 * returning the verdict. The caller decides how to react (log, emit a
 * `runtime.swap_degraded` event, or throw on `decision === "reject"`).
 */
export function evaluateSwap(
	agentConfig: Record<string, unknown> | null | undefined,
	target: RuntimeDescriptor,
	opts?: { rejectEnabled?: boolean }
): SwapVerdict {
	return assertSwapSafe(deriveAgentRequirements(agentConfig), target, opts);
}
