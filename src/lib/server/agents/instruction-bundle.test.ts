import { describe, expect, it } from "vitest";
import {
	CANONICAL_BUNDLE_TEMPLATE_NAME,
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
});
