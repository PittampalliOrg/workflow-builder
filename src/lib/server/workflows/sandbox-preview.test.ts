import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	getExecutionSandboxPreviewInfo,
	type SandboxPreviewInfoDataPort,
} from "$lib/server/workflows/sandbox-preview";

describe("getExecutionSandboxPreviewInfo", () => {
	it("does not import direct database modules", () => {
		const source = readFileSync(
			new URL("./sandbox-preview.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("resolves retained sandbox preview metadata through workflow-data", async () => {
		const data: SandboxPreviewInfoDataPort = {
			getExecutionById: vi.fn(async () => ({
				id: "exec-1",
				input: {
					triggerData: {
						keepSandbox: true,
					},
				},
				output: {
					workflowOutput: {
						sandboxName: "output-sandbox",
					},
					outputs: {
						initialize: {
							data: {
								provider: "openshell",
							},
						},
					},
				},
			}) as never),
			listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => [
				{
					workspaceRef: "workspace-1",
					workflowExecutionId: "exec-1",
					durableInstanceId: null,
					name: "workspace-sandbox",
					rootPath: "/sandbox/workspaces/exec-1",
					clonePath: null,
					backend: "openshell" as const,
					enabledTools: [],
					requireReadBeforeWrite: false,
					commandTimeoutMs: 30000,
					status: "active" as const,
					lastError: null,
					sandboxState: {
						workingDirectory: "/sandbox/workspaces/exec-1/repo",
						details: {
							sandboxName: "workspace-sandbox",
							provider: "openshell",
						},
					},
					createdAt: new Date("2026-07-03T00:00:00.000Z"),
					updatedAt: new Date("2026-07-03T00:00:00.000Z"),
					lastAccessedAt: new Date("2026-07-03T00:00:00.000Z"),
					cleanedAt: null,
				},
			]),
		};

		const info = await getExecutionSandboxPreviewInfo("exec-1", data);

		expect(data.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(data.listWorkflowWorkspaceSessionsByExecutionId).toHaveBeenCalledWith({
			executionId: "exec-1",
			limit: 1,
		});
		expect(info).toEqual({
			executionId: "exec-1",
			workspaceRef: "workspace-1",
			sandboxName: "workspace-sandbox",
			rootPath: "/sandbox/workspaces/exec-1",
			workingDir: "/sandbox/workspaces/exec-1/repo",
			provider: "openshell",
			kept: true,
		});
	});

	it("returns null when the execution is missing", async () => {
		const data: SandboxPreviewInfoDataPort = {
			getExecutionById: vi.fn(async () => null),
			listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => []),
		};

		await expect(getExecutionSandboxPreviewInfo("missing", data)).resolves.toBeNull();
		expect(data.listWorkflowWorkspaceSessionsByExecutionId).not.toHaveBeenCalled();
	});
});
