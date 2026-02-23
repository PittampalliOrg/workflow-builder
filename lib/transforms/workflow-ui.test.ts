import { describe, expect, it } from "vitest";
import { parseExecutionOutcomeSummary } from "./workflow-ui";

describe("parseExecutionOutcomeSummary", () => {
	it("parses top-level summary fields", () => {
		const summary = parseExecutionOutcomeSummary({
			branch: "feature-branch",
			commit: "abc123",
			prNumber: 42,
			prUrl: "https://example.com/pr/42",
			prState: "open",
			changedFileCount: 6,
		});

		expect(summary).toEqual({
			branch: "feature-branch",
			commit: "abc123",
			prNumber: 42,
			prUrl: "https://example.com/pr/42",
			prState: "open",
			remote: undefined,
			changedFileCount: 6,
		});
	});

	it("parses nested result and snake_case variants", () => {
		const summary = parseExecutionOutcomeSummary({
			success: true,
			result: {
				branch: "feature-branch",
				commit: "def456",
				pr_number: "10",
				pr_url: "https://example.com/pr/10",
				pr_state: "open",
				changed_count: "7",
			},
		});

		expect(summary).toEqual({
			branch: "feature-branch",
			commit: "def456",
			prNumber: "10",
			prUrl: "https://example.com/pr/10",
			prState: "open",
			remote: undefined,
			changedFileCount: 7,
		});
	});

	it("returns null when output has no summary fields", () => {
		expect(parseExecutionOutcomeSummary({ success: true })).toBeNull();
		expect(parseExecutionOutcomeSummary("not-an-object")).toBeNull();
	});
});
