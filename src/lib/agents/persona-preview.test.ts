import { describe, expect, it } from "vitest";
import { formatAgentPersonaPreview } from "./persona-preview";

describe("formatAgentPersonaPreview", () => {
	it("renders array instructions without coercing them to an object string", () => {
		const preview = formatAgentPersonaPreview({
			systemPrompt: "System text",
			role: "Reviewer",
			goal: "Find regressions",
			instructions: ["Check behavior", "Run tests"],
			styleGuidelines: ["Be concise"],
		});

		expect(preview).toContain("## System Prompt\nSystem text");
		expect(preview).toContain("## Role\nReviewer");
		expect(preview).toContain("## Goal\nFind regressions");
		expect(preview).toContain("- Check behavior");
		expect(preview).toContain("- Run tests");
		expect(preview).toContain("## Style\n- Be concise");
		expect(preview).not.toContain("[object Object]");
	});
});
