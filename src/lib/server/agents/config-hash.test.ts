import { describe, expect, it } from "vitest";
import type { AgentConfig } from "$lib/types/agents";
import { canonicalJson, hashAgentConfig } from "./config-hash";

function minimalConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		builtinTools: ["read_file"],
		mcpConnectionMode: "explicit",
		mcpServers: [],
		skills: [],
		runtime: "dapr-agent-py",
		runtimeOverridePolicy: {
			allowToolNarrowing: true,
			allowServerAdditions: false,
			allowCredentialBinding: true,
			allowSkillAdditions: false,
			allowSkillNarrowing: true,
		},
		...overrides,
	};
}

describe("canonicalJson", () => {
	it("sorts object keys", () => {
		const a = { b: 1, a: 2 };
		const b = { a: 2, b: 1 };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
	});

	it("preserves array order", () => {
		const a = { tools: ["read", "write"] };
		const b = { tools: ["write", "read"] };
		expect(canonicalJson(a)).not.toBe(canonicalJson(b));
	});

	it("strips undefined", () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
	});

	it("recursively canonicalizes nested objects", () => {
		const a = { outer: { z: 1, a: 2 } };
		const b = { outer: { a: 2, z: 1 } };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
	});
});

describe("hashAgentConfig", () => {
	it("produces the same hash for semantically equal configs", () => {
		const a = minimalConfig({ modelSpec: "anthropic/claude-opus-4-7" });
		const b: AgentConfig = {
			modelSpec: "anthropic/claude-opus-4-7",
			runtimeOverridePolicy: {
				allowSkillNarrowing: true,
				allowSkillAdditions: false,
				allowCredentialBinding: true,
				allowServerAdditions: false,
				allowToolNarrowing: true,
			},
			runtime: "dapr-agent-py",
			skills: [],
			mcpServers: [],
			mcpConnectionMode: "explicit",
			builtinTools: ["read_file"],
		};
		expect(hashAgentConfig(a)).toBe(hashAgentConfig(b));
	});

	it("differs when a field value changes", () => {
		const a = minimalConfig({ modelSpec: "anthropic/claude-opus-4-7" });
		const b = minimalConfig({ modelSpec: "anthropic/claude-sonnet-4-6" });
		expect(hashAgentConfig(a)).not.toBe(hashAgentConfig(b));
	});

	it("is stable across array-valued fields in insertion order", () => {
		const a = minimalConfig({ builtinTools: ["a", "b", "c"] });
		const b = minimalConfig({ builtinTools: ["a", "b", "c"] });
		expect(hashAgentConfig(a)).toBe(hashAgentConfig(b));
	});

	it("distinguishes array orderings", () => {
		const a = minimalConfig({ builtinTools: ["a", "b"] });
		const b = minimalConfig({ builtinTools: ["b", "a"] });
		expect(hashAgentConfig(a)).not.toBe(hashAgentConfig(b));
	});
});
