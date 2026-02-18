import { describe, expect, it } from "vitest";
import {
	buildPlanModePrompt,
	buildPlanRepairPrompt,
} from "../src/service/plan-mode-prompt.js";

describe("plan mode prompt builders", () => {
	it("enforces strict proposed_plan output contract in codex profile", () => {
		const result = buildPlanModePrompt({
			userPrompt: "Add a health endpoint",
			repositoryRoot: "/workspace/repo",
			promptProfile: "codex_cli_v1",
		});

		expect(result.profile).toBe("codex_cli_v1");
		expect(result.prompt).toContain("Output contract (hard requirement)");
		expect(result.prompt).toContain(
			"Return exactly one <proposed_plan> block and nothing else.",
		);
		expect(result.prompt).toContain("This request is non-interactive.");
	});

	it("includes proposed_plan requirement in legacy profile", () => {
		const result = buildPlanModePrompt({
			userPrompt: "Refactor parser",
			promptProfile: "legacy_v0",
		});

		expect(result.profile).toBe("legacy_v0");
		expect(result.prompt).toContain(
			"emit exactly one <proposed_plan> block and nothing else",
		);
	});

	it("builds a repair prompt that requires block-only output", () => {
		const result = buildPlanRepairPrompt({
			userPrompt: "Implement auth flow",
			priorResponse: "Here is a draft plan without tags",
			attempt: 2,
			promptProfile: "codex_cli_v1",
		});

		expect(result.prompt).toContain("Plan finalization repair (attempt 2)");
		expect(result.prompt).toContain(
			"Return exactly one <proposed_plan>...</proposed_plan> block.",
		);
		expect(result.prompt).toContain("Previous rejected response");
		expect(result.prompt).toContain("Here is a draft plan without tags");
	});
});
