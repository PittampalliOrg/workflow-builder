import { describe, expect, it } from "vitest";
import {
	CANONICAL_BUNDLE_TEMPLATE_NAME,
	SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
	buildInstructionBundle,
} from "./instruction-bundle";
import type { AgentConfig } from "$lib/types/agents";

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

describe("buildInstructionBundle", () => {
	it("renders systemPrompt as the only persona block", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				systemPrompt: "Sentinel system",
			}),
			prompt: "Do the work",
			promptSource: "workflow-node",
			cwd: "/sandbox/repo",
			sandboxName: "ws-demo",
			agent: { id: "a1", version: 2, configHash: "cfg", slug: "agent" },
		});

		expect(bundle.rendered.system).toContain("Sentinel system");
		expect(bundle.rendered.user).toBe("Do the work");
		expect(bundle.instructionHash).toMatch(/^[a-f0-9]{64}$/);
		expect(bundle.templateName).toBe(CANONICAL_BUNDLE_TEMPLATE_NAME);
		expect(bundle.templateHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("trims whitespace and produces stable hash for semantically identical input", () => {
		const first = buildInstructionBundle({
			agentConfig: minimalConfig({ systemPrompt: " sentinel " }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		const second = buildInstructionBundle({
			agentConfig: minimalConfig({ systemPrompt: "sentinel" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});

		expect(first.instructionHash).toBe(second.instructionHash);
	});

	it("uses the shared renderer for platform and runtime fields", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				systemPrompt: "Reviewer voice",
				skills: [{ name: "reviewer", registryId: "skill_1" }] as AgentConfig["skills"],
			}),
			prompt: "Prompt",
			promptSource: "workflow-node",
			cwd: "/sandbox/repo",
			platformSystemSections: ["Platform section"],
		});

		expect(bundle.rendered.system).toContain("Platform section");
		expect(bundle.rendered.system).toContain("Reviewer voice");
		expect(bundle.rendered.system).toContain("Working directory: /sandbox/repo");
		expect(bundle.rendered.system).toContain("Configured skills: reviewer");
		expect(bundle.sources).toContainEqual({
			field: "runtime.skills",
			sourceType: "runtime",
			sourceId: "agentConfig.skills",
			overrideKind: "runtime",
		});
	});

	it("emits the static/dynamic boundary when both halves have content", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({ systemPrompt: "Reviewer voice" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
			platformSystemSections: ["Platform"],
		});
		expect(bundle.rendered.system).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		const [pre, post] = bundle.rendered.system.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		expect(pre).toContain("Reviewer voice");
		expect(post).toContain("Working directory");
	});

	it("currentDate and mcpInstructions land in the dynamic tail", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({ systemPrompt: "Reviewer voice" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
			currentDate: "2026-05-01",
			mcpInstructions: ["server-a: Use read-only tools."],
		});
		const [, dynamic] = bundle.rendered.system.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		expect(dynamic).toContain("## Current Date");
		expect(dynamic).toContain("2026-05-01");
		expect(dynamic).toContain("## MCP Server Instructions");
		expect(dynamic).toContain("server-a: Use read-only tools.");
	});

	it("static presets render before systemPrompt in the static prefix", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				systemPrompt: "Agent voice",
				compiledStaticPresetSections: [
					"## Reusable Style Guide\nKeep responses terse.",
					"## Escalation Policy\nNever escalate without TL approval.",
				],
			} as Partial<AgentConfig>),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		const [staticPart] = bundle.rendered.system.split(
			SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
		);
		const styleIdx = staticPart.indexOf("Reusable Style Guide");
		const escalationIdx = staticPart.indexOf("Escalation Policy");
		const voiceIdx = staticPart.indexOf("Agent voice");
		expect(styleIdx).toBeGreaterThan(-1);
		expect(escalationIdx).toBeGreaterThan(-1);
		expect(voiceIdx).toBeGreaterThan(-1);
		expect(styleIdx).toBeLessThan(escalationIdx);
		expect(escalationIdx).toBeLessThan(voiceIdx);
	});

	it("dynamic presets render before Runtime Context in the dynamic tail", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				systemPrompt: "Reviewer voice",
				compiledDynamicPresetSections: [
					"## Per-turn Reminder\nMention follow-ups in summary.",
				],
			} as Partial<AgentConfig>),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		const [, dynamic] = bundle.rendered.system.split(
			SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
		);
		const reminderIdx = dynamic.indexOf("Per-turn Reminder");
		const runtimeIdx = dynamic.indexOf("Runtime Context");
		expect(reminderIdx).toBeGreaterThan(-1);
		expect(runtimeIdx).toBeGreaterThan(-1);
		expect(reminderIdx).toBeLessThan(runtimeIdx);
	});

	it("retired persona fields (role/goal/instructions/styleGuidelines/customSystemPrompt/appendSystemPrompt) are NOT rendered even when smuggled in", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				systemPrompt: "Live voice",
				// Smuggle every retired field in via the loose record cast — none
				// should reach the rendered prompt.
				role: "should-not-appear",
				goal: "should-not-appear",
				instructions: ["should-not-appear"],
				styleGuidelines: ["should-not-appear"],
				customSystemPrompt: "should-not-appear",
				appendSystemPrompt: "should-not-appear",
			} as unknown as Partial<AgentConfig>),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		expect(bundle.rendered.system).toContain("Live voice");
		expect(bundle.rendered.system).not.toContain("should-not-appear");
	});

	it("sources record runtime preset entries when present", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				systemPrompt: "Voice",
				compiledStaticPresetSections: ["## A\nx"],
				compiledDynamicPresetSections: ["## B\ny"],
			} as Partial<AgentConfig>),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		const fields = bundle.sources.map((s) => s.field);
		expect(fields).toContain("runtime.compiledStaticPresetSections");
		expect(fields).toContain("runtime.compiledDynamicPresetSections");
	});

	it("hash changes when systemPrompt changes", () => {
		const base = buildInstructionBundle({
			agentConfig: minimalConfig({ systemPrompt: "Voice 1" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		const updated = buildInstructionBundle({
			agentConfig: minimalConfig({ systemPrompt: "Voice 2" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		expect(base.instructionHash).not.toBe(updated.instructionHash);
	});

	it("defaults cacheTtl to 5m and emits a 'default' source", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({ systemPrompt: "Voice" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		expect(bundle.runtime.cacheTtl).toBe("5m");
		const cacheSource = bundle.sources.find((s) => s.field === "runtime.cacheTtl");
		expect(cacheSource).toEqual({
			field: "runtime.cacheTtl",
			sourceType: "runtime",
			sourceId: "default",
			overrideKind: "runtime",
		});
	});

	it("propagates cacheTtl=1h from agentConfig and credits the agent profile", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				systemPrompt: "Voice",
				cacheTtl: "1h",
			}),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
			agent: { id: "a1", version: 1, configHash: "cfg", slug: "s" },
		});
		expect(bundle.runtime.cacheTtl).toBe("1h");
		const cacheSource = bundle.sources.find((s) => s.field === "runtime.cacheTtl");
		expect(cacheSource?.sourceId).toBe("a1");
	});

	it("flipping cacheTtl changes instructionHash so the cache key differs", () => {
		const a = buildInstructionBundle({
			agentConfig: minimalConfig({ systemPrompt: "Voice", cacheTtl: "5m" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		const b = buildInstructionBundle({
			agentConfig: minimalConfig({ systemPrompt: "Voice", cacheTtl: "1h" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		expect(a.instructionHash).not.toBe(b.instructionHash);
	});
});
