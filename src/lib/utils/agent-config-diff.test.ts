import { describe, it, expect } from "vitest";
import { diffAgentConfig, isAgentConfigEquivalent, summarizeDiff } from "./agent-config-diff";
import { createDefaultAgentConfig } from "$lib/types/agents";
import type { AgentConfig } from "$lib/types/agents";

function cfg(over: Partial<AgentConfig>): AgentConfig {
	return { ...createDefaultAgentConfig(), ...over };
}

// Pillar-3 prerequisite: diffAgentConfig must walk bundleRefs, else the session
// drawer's isAgentConfigEquivalent gate silently drops a bundle-only change.
describe("agent-config-diff bundleRefs", () => {
	it("detects an added bundle (NOT equivalent)", () => {
		const before = cfg({ bundleRefs: [] });
		const after = cfg({ bundleRefs: [{ id: "b1" }] });
		expect(isAgentConfigEquivalent(before, after)).toBe(false);
		const d = diffAgentConfig(before, after);
		expect(
			d.some((e) => e.group === "bundles" && e.kind === "added" && e.label === "b1"),
		).toBe(true);
		expect(summarizeDiff(d)).toContain("bundles");
	});

	it("detects a removed bundle", () => {
		const before = cfg({ bundleRefs: [{ id: "b1" }] });
		const after = cfg({ bundleRefs: [] });
		expect(isAgentConfigEquivalent(before, after)).toBe(false);
		expect(
			diffAgentConfig(before, after).some((e) => e.kind === "removed" && e.group === "bundles"),
		).toBe(true);
	});

	it("detects a version pin change", () => {
		const before = cfg({ bundleRefs: [{ id: "b1" }] });
		const after = cfg({ bundleRefs: [{ id: "b1", version: 2 }] });
		expect(isAgentConfigEquivalent(before, after)).toBe(false);
		expect(
			diffAgentConfig(before, after).some((e) => e.kind === "changed" && e.group === "bundles"),
		).toBe(true);
	});

	it("is equivalent when bundleRefs are unchanged", () => {
		const before = cfg({ bundleRefs: [{ id: "b1", version: 1 }] });
		const after = cfg({ bundleRefs: [{ id: "b1", version: 1 }] });
		expect(isAgentConfigEquivalent(before, after)).toBe(true);
	});
});
