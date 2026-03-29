import { describe, expect, it } from "vitest";
import {
	deriveAgentRunsFromExecutionOutput,
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

	it("prefers the execute durable instance over an earlier plan-mode durable instance", () => {
		const data = parseExecutionFileChangeData({
			outputs: {
				planNode: {
					data: {
						daprInstanceId: "exec-123__langgraph__plan_mode",
						snapshotRefs: ["README.md"],
					},
				},
				executeNode: {
					data: {
						daprInstanceId: "exec-123__langgraph__execute_direct",
						fileChanges: [
							{ path: "app/login/page.tsx", operation: "modified" },
						],
						patch:
							"diff --git a/app/login/page.tsx b/app/login/page.tsx\nindex 123..456 100644\n",
					},
				},
			},
		});

		expect(data).toEqual({
			files: [
				{ path: "app/login/page.tsx", status: "M", oldPath: undefined },
				{ path: "README.md", status: "M", oldPath: undefined },
			],
			patch:
				"diff --git a/app/login/page.tsx b/app/login/page.tsx\nindex 123..456 100644",
			patchRef: undefined,
			snapshotRefs: ["README.md"],
			stats: undefined,
			sourceNodeKey: "executeNode",
			durableInstanceId: "exec-123__langgraph__execute_direct",
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

describe("deriveAgentRunsFromExecutionOutput", () => {
	it("prefers agent progress status over parent execution failure", () => {
		const runs = deriveAgentRunsFromExecutionOutput(
			{
				outputs: {
					executeNode: {
						data: {
							agentWorkflowId: "agent-wf-1",
							daprInstanceId: "agent-inst-1",
							traceId: "trace-1",
							agentProgress: {
								status: "completed",
								traceId: "trace-1",
							},
						},
					},
				},
			},
			{
				executionId: "exec-1",
				parentExecutionId: "parent-1",
				startedAt: "2026-03-28T19:37:00.000Z",
				completedAt: "2026-03-28T19:40:00.000Z",
				executionStatus: "error",
			},
		);

		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			nodeId: "executeNode",
			status: "completed",
			agentWorkflowId: "agent-wf-1",
			daprInstanceId: "agent-inst-1",
		});
	});

	it("falls back to boolean success when explicit status is absent", () => {
		const runs = deriveAgentRunsFromExecutionOutput(
			{
				outputs: {
					planNode: {
						data: {
							agentWorkflowId: "agent-wf-2",
							daprInstanceId: "agent-inst-2",
							traceId: "trace-2",
							success: true,
						},
					},
				},
			},
			{
				executionId: "exec-2",
				parentExecutionId: "parent-2",
				executionStatus: "error",
			},
		);

		expect(runs).toHaveLength(1);
		expect(runs[0]?.status).toBe("completed");
	});
});
