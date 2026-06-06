import { describe, it, expect } from "vitest";
import { getRuntimeDescriptor, type RuntimeDescriptor } from "./runtime-registry";
import {
	resolveModelProvider,
	deriveAgentRequirements,
	assertSwapSafe,
	evaluateSwap
} from "./swap-safety";

function runtime(id: string): RuntimeDescriptor {
	const d = getRuntimeDescriptor(id);
	if (!d) throw new Error(`no descriptor for ${id}`);
	return d;
}

/** A real descriptor with some capabilities overridden (for cases no live runtime exhibits). */
function withCaps(id: string, overrides: Partial<RuntimeDescriptor["capabilities"]>): RuntimeDescriptor {
	const base = runtime(id);
	return { ...base, capabilities: { ...base.capabilities, ...overrides } };
}

describe("resolveModelProvider", () => {
	it("extracts the provider prefix", () => {
		expect(resolveModelProvider("anthropic/claude-opus-4-8")).toBe("anthropic");
		expect(resolveModelProvider("kimi/kimi-k2.6")).toBe("kimi");
		expect(resolveModelProvider("deepseek/deepseek-v4-pro")).toBe("deepseek");
		expect(resolveModelProvider("foundry/DeepSeek-V4-Flash")).toBe("foundry");
	});
	it("handles bare model names", () => {
		expect(resolveModelProvider("claude-sonnet-4-6")).toBe("anthropic");
		expect(resolveModelProvider("gpt5")).toBe("openai");
		expect(resolveModelProvider("gemini-2.5-pro")).toBe("gemini");
	});
	it("returns null for empty/unknown", () => {
		expect(resolveModelProvider(null)).toBeNull();
		expect(resolveModelProvider("")).toBeNull();
		expect(resolveModelProvider("mystery-model")).toBeNull();
	});
});

describe("deriveAgentRequirements", () => {
	it("flags MCP when mcpServers is non-empty", () => {
		expect(deriveAgentRequirements({ mcpServers: [{ name: "x" }] }).mcp).toBe(true);
		expect(deriveAgentRequirements({ mcpServers: [] }).mcp).toBe(false);
		expect(deriveAgentRequirements({}).mcp).toBe(false);
	});
	it("flags hooks/plugins/permission-gating/provider/durability", () => {
		const r = deriveAgentRequirements({
			hooks: { PreToolUse: [{}] },
			plugins: ["p"],
			permissionMode: "default",
			modelSpec: "deepseek/deepseek-v4-pro",
			requiresDurability: "per-activity"
		});
		expect(r).toEqual({
			mcp: false,
			hooks: true,
			plugins: true,
			permissionGating: true,
			provider: "deepseek",
			durability: "per-activity"
		});
	});
	it("bypassPermissions does not require permission gating", () => {
		expect(deriveAgentRequirements({ permissionMode: "bypassPermissions" }).permissionGating).toBe(false);
		expect(deriveAgentRequirements({ permissionMode: "bypass" }).permissionGating).toBe(false);
	});
});

describe("assertSwapSafe", () => {
	it("allows when the runtime satisfies all requirements", () => {
		const req = deriveAgentRequirements({
			mcpServers: [{ name: "x" }],
			modelSpec: "anthropic/claude-opus-4-8"
		});
		expect(assertSwapSafe(req, runtime("claude-agent-py")).decision).toBe("allow");
	});

	it("REJECTS an MCP agent on a no-MCP runtime (when rejection enabled)", () => {
		const req = deriveAgentRequirements({ mcpServers: [{ name: "x" }] });
		const target = withCaps("adk-agent-py", { supportsMcp: false });
		const v = assertSwapSafe(req, target, { rejectEnabled: true });
		expect(v.decision).toBe("reject");
		expect(v.drops.map((d) => d.capability)).toContain("mcp");
	});

	it("REJECTS a provider mismatch (DeepSeek model on Anthropic-only claude)", () => {
		const req = deriveAgentRequirements({ modelSpec: "deepseek/deepseek-v4-pro" });
		const v = assertSwapSafe(req, runtime("claude-agent-py"), { rejectEnabled: true });
		expect(v.decision).toBe("reject");
		expect(v.drops.find((d) => d.capability === "provider")?.severity).toBe("reject");
	});

	it("allows a multi-provider runtime to run any of its providers", () => {
		const req = deriveAgentRequirements({ modelSpec: "kimi/kimi-k2.6" });
		// dapr-agent-py lists kimi among supportedProviders.
		expect(assertSwapSafe(req, runtime("dapr-agent-py")).decision).toBe("allow");
		// claude-agent-py does not.
		expect(assertSwapSafe(req, runtime("claude-agent-py"), { rejectEnabled: true }).decision).toBe(
			"reject"
		);
	});

	it("WARN-first: reject-class drops are only WARN until rejection is enabled", () => {
		const req = deriveAgentRequirements({ modelSpec: "deepseek/deepseek-v4-pro" });
		const target = runtime("claude-agent-py");
		expect(assertSwapSafe(req, target, { rejectEnabled: false }).decision).toBe("warn");
		expect(assertSwapSafe(req, target, { rejectEnabled: true }).decision).toBe("reject");
	});

	it("WARNS (never rejects) on hooks/permission/durability downgrades", () => {
		const req = deriveAgentRequirements({
			hooks: { PreToolUse: [{}] },
			permissionMode: "default",
			requiresDurability: "per-activity",
			modelSpec: "anthropic/claude-opus-4-8"
		});
		// claude-agent-py: supportsHooks but hookTiming batch, no permission gating, per-turn.
		const v = assertSwapSafe(req, runtime("claude-agent-py"), { rejectEnabled: true });
		expect(v.decision).toBe("warn");
		const caps = v.drops.map((d) => d.capability);
		expect(caps).toContain("permissionGating");
		expect(caps).toContain("durability");
		expect(v.drops.every((d) => d.severity === "warn")).toBe(true);
	});

	it("a plain agent on its own runtime is always allowed", () => {
		const v = evaluateSwap(
			{ modelSpec: "anthropic/claude-opus-4-8", permissionMode: "bypassPermissions" },
			runtime("claude-agent-py"),
			{ rejectEnabled: true }
		);
		expect(v.decision).toBe("allow");
		expect(v.drops).toEqual([]);
	});
});
