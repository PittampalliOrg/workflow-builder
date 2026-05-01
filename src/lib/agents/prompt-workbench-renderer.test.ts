import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "$lib/types/agents";
import type { PromptPresetSummary } from "$lib/types/prompt-presets";
import {
	applyPromptPresetToConfig,
	buildPromptWorkbenchPreview,
	renderMustachePreview,
	templateHash,
} from "./prompt-workbench-renderer";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
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

function preset(): PromptPresetSummary {
	return {
		id: "prompt_1",
		name: "review",
		title: "review",
		description: null,
		version: 2,
		isEnabled: true,
		metadata: null,
		userId: "user_1",
		projectId: "project_1",
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		latestVersion: {
			id: "version_2",
			promptId: "prompt_1",
			version: 2,
			templateFormat: "mustache",
			templateHash: "hash",
			createdByUserId: "user_1",
			createdAt: new Date(0).toISOString(),
			arguments: [{ name: "ticket", required: true }],
			metadata: {
				agentConfigPatch: {
					systemPrompt: "Review {{args.ticket}}",
					instructions: ["Preserve behavior"],
				},
			},
			messages: [
				{ role: "system", content: "Review {{args.ticket}} in {{runtime.cwd}}" },
				{ role: "user", content: "Use {{missing.value}}" },
			],
		},
	};
}

describe("prompt workbench renderer", () => {
	it("renders Mustache variables from sample context and leaves unresolved variables", () => {
		const rendered = renderMustachePreview("cwd={{runtime.cwd}} missing={{nope}}", {
			runtime: { cwd: "/sandbox/repo" },
		});

		expect(rendered.content).toBe("cwd=/sandbox/repo missing={{nope}}");
		expect(rendered.unresolvedVariables).toEqual(["nope"]);
	});

	it("preserves preset message role ordering and reports unresolved variables", () => {
		const preview = buildPromptWorkbenchPreview({
			config: config({ role: "Reviewer" }),
			preset: preset(),
			runtime: { cwd: "/sandbox/repo" },
			userPrompt: "Run {{runtime.cwd}}",
		});

		expect(preview.presetMessages.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(preview.presetMessages[0].content).toContain("/sandbox/repo");
		expect(preview.presetMessages[1].content).toContain("{{missing.value}}");
		expect(preview.warnings.map((warning) => warning.variable)).toContain(
			"missing.value",
		);
		expect(preview.warnings.map((warning) => warning.variable)).toContain(
			"runtime.cwd",
		);
	});

	it("produces stable template hashes", () => {
		const first = templateHash({
			templateFormat: "mustache",
			arguments: [{ name: "ticket", required: true }],
			messages: [{ role: "system", content: "Review {{args.ticket}}" }],
		});
		const second = templateHash({
			messages: [{ content: "Review {{args.ticket}}", role: "system" }],
			arguments: [{ required: true, name: "ticket" }],
			templateFormat: "mustache",
		});

		expect(first).toBe(second);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
	});

	it("uses sha256-compatible hashing for audit fields", () => {
		const canonical =
			'{"arguments":[],"messages":[{"content":"","role":"system"}],"templateFormat":"mustache"}';
		expect(
			templateHash({
				templateFormat: "mustache",
				arguments: [],
				messages: [{ role: "system", content: "" }],
			}),
		).toBe(createHash("sha256").update(canonical).digest("hex"));
	});

	it("applies preset metadata back to persona fields", () => {
		const next = applyPromptPresetToConfig(config({ role: "Old" }), preset());

		expect(next.role).toBe("Old");
		expect(next.systemPrompt).toBe("Review {{args.ticket}}");
		expect(next.instructions).toEqual(["Preserve behavior"]);
	});
});
