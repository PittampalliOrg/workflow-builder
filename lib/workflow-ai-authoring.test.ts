import { describe, expect, it } from "vitest";
import {
	buildDefaultWorkflowGenerationDraftSettings,
	buildWorkflowAiRefinedPrompt,
} from "./workflow-ai-authoring";

describe("workflow AI authoring helpers", () => {
	it("infers multi-agent settings from the prompt", () => {
		const settings = buildDefaultWorkflowGenerationDraftSettings(
			"Create a multi-agent workflow with a review loop",
		);

		expect(settings.complexity).toBe("multi_agent");
		expect(settings.requiresPullRequest).toBe(true);
		expect(settings.preferAvailableMcp).toBe(true);
	});

	it("appends refinements without losing the original prompt", () => {
		const refined = buildWorkflowAiRefinedPrompt(
			"Resolve a GitHub issue",
			"Use dapr-swe and create a PR",
		);

		expect(refined).toContain("Resolve a GitHub issue");
		expect(refined).toContain("Additional user refinement");
		expect(refined).toContain("Use dapr-swe and create a PR");
	});
});
