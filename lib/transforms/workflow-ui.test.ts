import { describe, expect, it } from "vitest";
import {
	parseExecutionFileChangeData,
	parseExecutionOutcomeSummary,
} from "./workflow-ui";

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

describe("parseExecutionFileChangeData", () => {
	it("parses top-level file change fields", () => {
		const data = parseExecutionFileChangeData({
			fileChanges: [
				{ path: "scripts/demo.sh", operation: "created" },
				{ path: "docs/usage.md", operation: "modified" },
			],
			patch: "diff --git a/docs/usage.md b/docs/usage.md",
			patchRef: "/api/workspaces/executions/ex_123/patch",
			snapshotRefs: ["scripts/demo.sh", "docs/usage.md"],
			daprInstanceId: "dapr-instance-123",
		});

		expect(data).toEqual({
			files: [
				{ path: "docs/usage.md", status: "M", oldPath: undefined },
				{ path: "scripts/demo.sh", status: "A", oldPath: undefined },
			],
			patch: "diff --git a/docs/usage.md b/docs/usage.md",
			patchRef: "/api/workspaces/executions/ex_123/patch",
			snapshotRefs: ["docs/usage.md", "scripts/demo.sh"],
			stats: undefined,
			sourceNodeKey: undefined,
			durableInstanceId: "dapr-instance-123",
		});
	});

	it("falls back to feature-delivery node output", () => {
		const data = parseExecutionFileChangeData({
			success: true,
			outputs: {
				da_agent_system_demo: {
					changeSummary: {
						files: [
							{ path: "docs/report.md", op: "modified" },
							{
								path: "scripts/verify-repo.sh",
								op: "renamed",
								oldPath: "scripts/check-repo.sh",
							},
						],
						stats: {
							files: 2,
							additions: 14,
							deletions: 3,
						},
					},
					patch: "diff --git a/docs/report.md b/docs/report.md",
					snapshotRefs: ["docs/report.md", "scripts/verify-repo.sh"],
				},
			},
		});

		expect(data).toEqual({
			files: [
				{ path: "docs/report.md", status: "M", oldPath: undefined },
				{
					path: "scripts/verify-repo.sh",
					status: "R",
					oldPath: "scripts/check-repo.sh",
				},
			],
			patch: "diff --git a/docs/report.md b/docs/report.md",
			patchRef: undefined,
			snapshotRefs: ["docs/report.md", "scripts/verify-repo.sh"],
			stats: {
				files: 2,
				additions: 14,
				deletions: 3,
			},
			sourceNodeKey: "da_agent_system_demo",
			durableInstanceId: undefined,
		});
	});

	it("extracts durable instance id from patchRef when explicit field is absent", () => {
		const data = parseExecutionFileChangeData({
			outputs: {
				da_agent_system_demo: {
					fileChanges: [{ path: "src/index.ts", operation: "modified" }],
					patchRef:
						"/api/workspaces/executions/ex_123/patch?durableInstanceId=durable-456",
				},
			},
		});

		expect(data).toEqual({
			files: [{ path: "src/index.ts", status: "M", oldPath: undefined }],
			patch: undefined,
			patchRef:
				"/api/workspaces/executions/ex_123/patch?durableInstanceId=durable-456",
			snapshotRefs: [],
			stats: undefined,
			sourceNodeKey: "da_agent_system_demo",
			durableInstanceId: "durable-456",
		});
	});

	it("infers changed files from openshell output text when patch artifacts are absent", () => {
		const data = parseExecutionFileChangeData({
			outputs: {
				da_agent_system_demo: {
					text: "Script created and verified. Here's the summary:\n\n**Changed files:** `scripts/workflow_builder_demo_report.py` (new file), `docs/notes.md`",
				},
			},
		});

		expect(data).toEqual({
			files: [
				{
					path: "docs/notes.md",
					status: "M",
					oldPath: undefined,
				},
				{
					path: "scripts/workflow_builder_demo_report.py",
					status: "A",
					oldPath: undefined,
				},
			],
			patch: undefined,
			patchRef: undefined,
			snapshotRefs: [],
			stats: {
				files: 2,
			},
			sourceNodeKey: "da_agent_system_demo",
			durableInstanceId: undefined,
		});
	});

	it("returns null when no file change fields exist", () => {
		expect(parseExecutionFileChangeData({ success: true })).toBeNull();
	});
});
