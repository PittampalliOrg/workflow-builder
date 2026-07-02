import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "success",
		input: { repoUrl: "https://github.com/fallback/repo.git", repoRef: "main" },
		output: { result: "ok" },
		summaryOutput: null,
	};
	const artifact = {
		id: "artifact-1",
		workflowExecutionId: "exec-1",
		nodeId: "agent",
		slot: "aux" as const,
		kind: "source-bundle",
		title: "Source bundle",
		description: null,
		inlinePayload: {
			tier: "tar-overlay",
			repoUrl: "https://github.com/owner/repo.git",
			base: "main",
			repoSubdir: ".",
			syncPaths: ["src"],
		},
		fileId: "file-1",
		contentType: "application/gzip",
		sizeBytes: 123,
		metadata: { previous: true },
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
		getWorkflowArtifactForExecution: vi.fn(async () => artifact),
		updateWorkflowArtifactMetadata: vi.fn(async () => ({
			...artifact,
			metadata: { previous: true, promotion: { branch: "wfb-promote-1" } },
		})),
	};
	const provisionWorkspaceHelperPod = vi.fn(async () => ({
		baseUrl: "http://helper.local",
		token: "helper-token",
	}));
	const runHelperCommand = vi.fn(async () => ({
		stdout: "BRANCH_PUSHED=wfb-promote-1\n",
		stderr: "",
	}));
	return {
		execution,
		artifact,
		workflowData,
		provisionWorkspaceHelperPod,
		runHelperCommand,
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/workflows/helper-pod", () => ({
	provisionWorkspaceHelperPod: mocks.provisionWorkspaceHelperPod,
	runHelperCommand: mocks.runHelperCommand,
	internalBffBaseUrl: () => "http://workflow-builder.local",
}));

import { POST } from "./+server";

function jsonRequest(body: unknown) {
	return new Request("http://workflow-builder.local/test", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1", artifactId: "artifact-1" },
		request: jsonRequest({ mode: "branch" }),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("workflow execution source-bundle promote route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.getWorkflowArtifactForExecution.mockResolvedValue(mocks.artifact);
		mocks.workflowData.updateWorkflowArtifactMetadata.mockResolvedValue({
			...mocks.artifact,
			metadata: { previous: true, promotion: { branch: "wfb-promote-1" } },
		});
		mocks.provisionWorkspaceHelperPod.mockResolvedValue({
			baseUrl: "http://helper.local",
			token: "helper-token",
		});
		mocks.runHelperCommand.mockResolvedValue({
			stdout: "BRANCH_PUSHED=wfb-promote-1\n",
			stderr: "",
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("records branch promotion metadata through workflowData", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			mode: "branch",
			repo: "owner/repo",
			base: "main",
			tier: "tar-overlay",
			branch: "wfb-promote-1",
			prUrl: null,
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.getWorkflowArtifactForExecution).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "artifact-1",
		});
		expect(mocks.provisionWorkspaceHelperPod).toHaveBeenCalledWith("exec-1", "promote", {
			withGithubToken: true,
		});
		expect(mocks.workflowData.updateWorkflowArtifactMetadata).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "artifact-1",
			metadata: {
				previous: true,
				promotion: expect.objectContaining({
					branch: "wfb-promote-1",
					mode: "branch",
					repo: "owner/repo",
					base: "main",
					promotedBy: "user-1",
				}),
			},
		});
	});

	it("hides executions outside the active workspace before provisioning a helper", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
		expect(mocks.workflowData.getWorkflowArtifactForExecution).not.toHaveBeenCalled();
		expect(mocks.provisionWorkspaceHelperPod).not.toHaveBeenCalled();
	});
});
