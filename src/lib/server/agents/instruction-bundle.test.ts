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
	it("renders systemPrompt, role, goal, instructions, and style together", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				systemPrompt: "Sentinel system",
				role: "Sentinel role",
				goal: "Sentinel goal",
				instructions: ["Sentinel instruction"],
				styleGuidelines: ["Sentinel style"],
			}),
			prompt: "Do the work",
			promptSource: "workflow-node",
			cwd: "/sandbox/repo",
			sandboxName: "ws-demo",
			agent: { id: "a1", version: 2, configHash: "cfg", slug: "agent" },
		});

		expect(bundle.rendered.system).toContain("Sentinel system");
		expect(bundle.rendered.system).toContain("Sentinel role");
		expect(bundle.rendered.system).toContain("Sentinel goal");
		expect(bundle.rendered.system).toContain("Sentinel instruction");
		expect(bundle.rendered.system).toContain("Sentinel style");
		expect(bundle.rendered.user).toBe("Do the work");
		expect(bundle.instructionHash).toMatch(/^[a-f0-9]{64}$/);
		expect(bundle.templateName).toBe(CANONICAL_BUNDLE_TEMPLATE_NAME);
		expect(bundle.templateHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("has a stable hash for semantically identical persona inputs", () => {
		const first = buildInstructionBundle({
			agentConfig: minimalConfig({
				role: " role ",
				instructions: [" keep order ", ""],
			}),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		const second = buildInstructionBundle({
			agentConfig: minimalConfig({
				instructions: ["keep order"],
				role: "role",
			}),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});

		expect(first.instructionHash).toBe(second.instructionHash);
	});

	it("uses the shared renderer for platform and runtime fields", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				role: "Runtime role",
				skills: [{ name: "reviewer", registryId: "skill_1" }] as AgentConfig["skills"],
			}),
			prompt: "Prompt",
			promptSource: "workflow-node",
			cwd: "/sandbox/repo",
			platformSystemSections: ["Platform section"],
		});

		expect(bundle.rendered.system).toContain("Platform section");
		expect(bundle.rendered.system).toContain("Runtime role");
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
			agentConfig: minimalConfig({ role: "Reviewer" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
			platformSystemSections: ["Platform"],
		});
		expect(bundle.rendered.system).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		const [pre, post] = bundle.rendered.system.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		expect(pre).toContain("Reviewer");
		expect(post).toContain("Working directory");
	});

	it("customSystemPrompt replaces persona-derived sections", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({
				role: "should-not-appear",
				goal: "should-not-appear",
				instructions: ["should-not-appear"],
				styleGuidelines: ["should-not-appear"],
				systemPrompt: "should-not-appear",
				customSystemPrompt: "Bespoke override prose.",
			}),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		expect(bundle.rendered.system).toContain("Bespoke override prose.");
		expect(bundle.rendered.system).not.toContain("should-not-appear");
		expect(bundle.sources.map((s) => s.field)).toContain(
			"persona.customSystemPrompt",
		);
	});

	it("appendSystemPrompt always lands at the very end", () => {
		const defaultPath = buildInstructionBundle({
			agentConfig: minimalConfig({
				role: "Reviewer",
				appendSystemPrompt: "FINAL_APPEND_MARKER",
			}),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		expect(defaultPath.rendered.system.endsWith("FINAL_APPEND_MARKER")).toBe(true);

		const customPath = buildInstructionBundle({
			agentConfig: minimalConfig({
				customSystemPrompt: "Custom prefix.",
				appendSystemPrompt: "FINAL_APPEND_MARKER_2",
			}),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		expect(customPath.rendered.system.endsWith("FINAL_APPEND_MARKER_2")).toBe(true);
	});

	it("currentDate and mcpInstructions land in the dynamic tail", () => {
		const bundle = buildInstructionBundle({
			agentConfig: minimalConfig({ role: "Reviewer" }),
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

	it("hash changes when customSystemPrompt or appendSystemPrompt is set", () => {
		const base = buildInstructionBundle({
			agentConfig: minimalConfig({ role: "Reviewer" }),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		const withCustom = buildInstructionBundle({
			agentConfig: minimalConfig({
				role: "Reviewer",
				customSystemPrompt: "Override.",
			}),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		const withAppend = buildInstructionBundle({
			agentConfig: minimalConfig({
				role: "Reviewer",
				appendSystemPrompt: "Tail.",
			}),
			prompt: "Prompt",
			promptSource: "session",
			cwd: "/sandbox",
		});
		expect(base.instructionHash).not.toBe(withCustom.instructionHash);
		expect(base.instructionHash).not.toBe(withAppend.instructionHash);
	});
});
