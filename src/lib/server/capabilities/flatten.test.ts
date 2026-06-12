import { describe, it, expect } from "vitest";
import { mergeBundleConfig } from "./flatten";
import { createDefaultAgentConfig } from "$lib/types/agents";
import type { AgentConfig, CapabilityBundleConfig } from "$lib/types/agents";

function cfg(over: Partial<AgentConfig>): AgentConfig {
	return { ...createDefaultAgentConfig(), ...over };
}

describe("mergeBundleConfig", () => {
	it("unions mcpServers; the config wins on name collision", () => {
		const config = cfg({
			mcpServers: [
				{ serverName: "a", url: "https://a" },
				{ serverName: "shared", url: "https://config-shared" },
			] as never,
		});
		const bundle: CapabilityBundleConfig = {
			mcpServers: [
				{ serverName: "b", url: "https://b" },
				{ serverName: "shared", url: "https://bundle-shared" },
			] as never,
		};
		const r = mergeBundleConfig(config, bundle);
		const byName = Object.fromEntries(
			(r.mcpServers as Array<{ serverName: string; url: string }>).map((s) => [s.serverName, s.url]),
		);
		expect(Object.keys(byName).sort()).toEqual(["a", "b", "shared"]);
		expect(byName.shared).toBe("https://config-shared"); // config wins
	});

	it("unions skills by registryId/slug", () => {
		const config = cfg({ skills: [{ registryId: "s1" }] as never });
		const bundle: CapabilityBundleConfig = {
			skills: [{ registryId: "s1" }, { registryId: "s2" }] as never,
		};
		const r = mergeBundleConfig(config, bundle);
		const ids = (r.skills as Array<{ registryId: string }>).map((s) => s.registryId).sort();
		expect(ids).toEqual(["s1", "s2"]);
	});

	it("unions tools + builtinTools (config + bundle)", () => {
		const config = cfg({ builtinTools: ["Bash", "Read"], tools: ["x"] });
		const bundle: CapabilityBundleConfig = { builtinTools: ["Read", "Write"], tools: ["x", "y"] };
		const r = mergeBundleConfig(config, bundle);
		expect([...(r.builtinTools ?? [])].sort()).toEqual(["Bash", "Read", "Write"]);
		expect([...(r.tools ?? [])].sort()).toEqual(["x", "y"]);
	});

	it("concatenates hooks per event (both apply)", () => {
		const config = cfg({ hooks: { PreToolUse: [{ matcher: "cfg" }] } as never });
		const bundle: CapabilityBundleConfig = {
			hooks: { PreToolUse: [{ matcher: "bundle" }], Stop: [{ matcher: "s" }] } as never,
		};
		const r = mergeBundleConfig(config, bundle) as unknown as {
			hooks: Record<string, Array<{ matcher: string }>>;
		};
		expect(r.hooks.PreToolUse.map((h) => h.matcher)).toEqual(["bundle", "cfg"]);
		expect(r.hooks.Stop.map((h) => h.matcher)).toEqual(["s"]);
	});

	it("unions prompt presets bundle-first by id", () => {
		const config = cfg({ staticPromptPresetRefs: [{ id: "p2", version: 1 }] });
		const bundle: CapabilityBundleConfig = {
			staticPromptPresetRefs: [{ id: "p1", version: 1 }],
		};
		const r = mergeBundleConfig(config, bundle);
		const ids = (r.staticPromptPresetRefs ?? []).map((p) => p.id);
		expect(ids).toEqual(["p1", "p2"]); // bundle (base) first, then config
	});

	it("is a structural no-op for an empty bundle", () => {
		const config = cfg({ mcpServers: [{ serverName: "a", url: "https://a" }] as never });
		const r = mergeBundleConfig(config, {});
		expect((r.mcpServers as Array<{ serverName: string }>).map((s) => s.serverName)).toEqual(["a"]);
	});
});
