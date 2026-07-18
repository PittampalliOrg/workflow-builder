import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	validateInternalToken: vi.fn(() => true),
	validatePreviewActionInternalToken: vi.fn(() => false),
	resolveCanonicalExecutionId: vi.fn(async () => "exec-1"),
	releaseSandboxes: vi.fn(async () => ({
		ok: true,
		complete: true,
		pending: false,
		found: true,
		executionId: "exec-1",
		sandboxes: [
			{
				sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
				service: "workflow-orchestrator",
				status: "released",
				message: null as string | null,
			},
			{
				sandboxName: "wfb-dev-preview-function-router-exec-1",
				service: "function-router",
				status: "released",
				message: null as string | null,
			},
		],
	})),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
	validatePreviewActionInternalToken: mocks.validatePreviewActionInternalToken,
}));
vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: {
			resolveCanonicalExecutionId: mocks.resolveCanonicalExecutionId,
		},
		previewEnvironmentProvisioner: {
			releaseSandboxes: mocks.releaseSandboxes,
		},
	}),
}));

import { POST } from "./+server";

function makeRequest(body?: unknown): Request {
	return new Request(
		"http://workflow-builder/api/internal/workflows/executions/sw-exec-1/dev-preview/release",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-internal-token": "internal-token",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		},
	);
}

describe("internal dev-preview release route", () => {
	it("rejects callers without an internal or preview-action credential", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);
		mocks.validatePreviewActionInternalToken.mockReturnValueOnce(false);
		await expect(
			POST({
				params: { executionId: "sw-exec-1" },
				request: makeRequest(),
			} as never),
		).rejects.toMatchObject({ status: 401 });
		expect(mocks.releaseSandboxes).not.toHaveBeenCalled();
	});

	it("accepts the sibling dev/* preview-action credential", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);
		mocks.validatePreviewActionInternalToken.mockReturnValueOnce(true);
		const response = (await POST({
			params: { executionId: "sw-exec-1" },
			request: makeRequest(),
		} as never)) as Response;
		expect(response.status).toBe(200);
	});

	it("releases every dev-preview sandbox for the canonical execution", async () => {
		const response = (await POST({
			params: { executionId: "sw-exec-1" },
			request: makeRequest(),
		} as never)) as Response;

		expect(mocks.resolveCanonicalExecutionId).toHaveBeenCalledWith({
			executionId: "sw-exec-1",
		});
		expect(mocks.releaseSandboxes).toHaveBeenCalledWith({
			executionId: "exec-1",
			service: null,
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			complete: true,
			sandboxes: [
				expect.objectContaining({ service: "workflow-orchestrator" }),
				expect.objectContaining({ service: "function-router" }),
			],
		});
	});

	it("narrows the release to one requested service", async () => {
		await POST({
			params: { executionId: "sw-exec-1" },
			request: makeRequest({ service: " workflow-orchestrator " }),
		} as never);
		expect(mocks.releaseSandboxes).toHaveBeenCalledWith({
			executionId: "exec-1",
			service: "workflow-orchestrator",
		});
	});

	it("returns 404 when the execution has no dev previews", async () => {
		mocks.releaseSandboxes.mockResolvedValueOnce({
			ok: true,
			complete: false,
			pending: false,
			found: false,
			executionId: "exec-1",
			sandboxes: [],
		});
		const response = (await POST({
			params: { executionId: "sw-exec-1" },
			request: makeRequest(),
		} as never)) as Response;

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			error: "no dev previews found for this execution",
			executionId: "exec-1",
			sandboxes: [],
		});
	});

	it("returns 202 while a response-path restore is deferred and 503 on failure", async () => {
		mocks.releaseSandboxes.mockResolvedValueOnce({
			ok: true,
			complete: false,
			pending: true,
			found: true,
			executionId: "exec-1",
			sandboxes: [
				{
					sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
					service: "workflow-builder",
					status: "deferred",
					message: "prod restore is deferred to the response path",
				},
			],
		});
		const deferred = (await POST({
			params: { executionId: "sw-exec-1" },
			request: makeRequest(),
		} as never)) as Response;
		expect(deferred.status).toBe(202);

		mocks.releaseSandboxes.mockResolvedValueOnce({
			ok: false,
			complete: false,
			pending: false,
			found: true,
			executionId: "exec-1",
			sandboxes: [
				{
					sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
					service: "workflow-orchestrator",
					status: "failed",
					message: "lease is held by another owner",
				},
			],
		});
		const failed = (await POST({
			params: { executionId: "sw-exec-1" },
			request: makeRequest(),
		} as never)) as Response;
		expect(failed.status).toBe(503);
	});
});
