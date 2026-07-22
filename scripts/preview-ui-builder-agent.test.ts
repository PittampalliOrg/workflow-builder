import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_CONFIG,
	PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_PROFILE,
	PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_RUNTIME,
	PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_SLUG,
	PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_SYSTEM_PROMPT,
} from "./preview-ui-builder-agent";

describe("Pydantic AI Kimi K3 preview UI builder seed", () => {
	it("pins the policy-selected coding runtime and shared workspace budget", () => {
		expect(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_PROFILE).toBe(
			"pydantic-ai-k3-ui",
		);
		expect(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_SLUG).toBe(
			"pydantic-ai-k3-preview-ui-builder-agent",
		);
		expect(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_RUNTIME).toBe(
			"pydantic-ai-agent-py",
		);
		expect(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_CONFIG).toMatchObject({
			runtime: "pydantic-ai-agent-py",
			runtimeClass: "coding",
			runtimeIsolation: "shared",
			modelSpec: "kimi/kimi-k3",
			reasoningEffort: "max",
			contextWindowTokens: 1_048_576,
			maxTurns: 40,
			timeoutMinutes: 60,
			cwd: "/sandbox/work",
			mcpConnectionMode: "explicit",
			mcpServers: [],
			memory: { backend: "none" },
		});
	});

	it("exposes coding tools without MCP, memory, or control-plane authority", () => {
		expect(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_CONFIG.builtinTools).toEqual(
			expect.arrayContaining([
				"read_file",
				"write_file",
				"edit_file",
				"search_files",
				"run_command",
				"start_command",
				"check_command",
				"stop_command",
			]),
		);
		expect(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_CONFIG.tools).toEqual([]);
		expect(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_CONFIG.skills).toEqual([]);
		expect(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_SYSTEM_PROMPT).toContain(
			"Do not read credentials",
		);
		expect(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_SYSTEM_PROMPT).toContain(
			"snapshot and draft-PR promotion path",
		);
	});

	it("is present in the deployable workflow seed bundle", () => {
		const bundle = readFileSync(
			new URL("./seed-workflows.bundle.js", import.meta.url),
			"utf8",
		);

		expect(bundle).toContain(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_SLUG);
		expect(bundle).toContain(PYDANTIC_AI_K3_PREVIEW_UI_BUILDER_RUNTIME);
	});
});
