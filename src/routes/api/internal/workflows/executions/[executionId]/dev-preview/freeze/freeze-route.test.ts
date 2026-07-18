import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requirePreviewActionInternal: vi.fn(),
	resolveCanonicalExecutionId: vi.fn(async () => "exec-1"),
	freezeSources: vi.fn(async () => ({
		ok: true,
		executionId: "exec-1",
		services: [
			{
				service: "workflow-orchestrator",
				status: "frozen",
				message: "source receiver is frozen",
			},
		],
	})),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requirePreviewActionInternal: mocks.requirePreviewActionInternal,
}));
vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: {
			resolveCanonicalExecutionId: mocks.resolveCanonicalExecutionId,
		},
		previewEnvironmentProvisioner: {
			freezeSources: mocks.freezeSources,
		},
	}),
}));

import { POST } from "./+server";

function makeRequest(body?: unknown): Request {
	return new Request(
		"http://workflow-builder/api/internal/workflows/executions/sw-exec-1/dev-preview/freeze",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-preview-action-token": "action-token",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		},
	);
}

describe("internal dev-preview freeze route", () => {
	it("requires the dedicated dev/* preview-action credential", async () => {
		mocks.requirePreviewActionInternal.mockImplementationOnce(() => {
			throw Object.assign(new Error("401"), { status: 401 });
		});
		const request = makeRequest({ services: ["workflow-orchestrator"] });
		await expect(
			POST({ params: { executionId: "sw-exec-1" }, request } as never),
		).rejects.toMatchObject({ status: 401 });
		expect(mocks.requirePreviewActionInternal).toHaveBeenCalledWith(request);
		expect(mocks.freezeSources).not.toHaveBeenCalled();
	});

	it("resolves the canonical execution id and fans the freeze out per service", async () => {
		const request = makeRequest({
			services: ["workflow-orchestrator", "workflow-orchestrator", " "],
		});
		const response = (await POST({
			params: { executionId: "sw-exec-1" },
			request,
		} as never)) as Response;

		expect(mocks.resolveCanonicalExecutionId).toHaveBeenCalledWith({
			executionId: "sw-exec-1",
		});
		expect(mocks.freezeSources).toHaveBeenCalledWith({
			executionId: "exec-1",
			services: ["workflow-orchestrator"],
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			ok: true,
			services: [
				expect.objectContaining({
					service: "workflow-orchestrator",
					status: "frozen",
				}),
			],
		});
	});

	it("reports no_dev_previews when the execution has nothing to freeze", async () => {
		mocks.freezeSources.mockResolvedValueOnce({
			ok: true,
			executionId: "exec-1",
			services: [],
		});
		const response = (await POST({
			params: { executionId: "sw-exec-1" },
			request: makeRequest(),
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			skipped: "no_dev_previews",
			executionId: "exec-1",
			services: [],
		});
	});

	it("maps a partial freeze to 502 with per-service outcomes intact", async () => {
		mocks.freezeSources.mockResolvedValueOnce({
			ok: false,
			executionId: "exec-1",
			services: [
				{
					service: "workflow-orchestrator",
					status: "failed",
					message: "dev-preview receiver is unavailable for workflow-orchestrator",
				},
			],
		});
		const response = (await POST({
			params: { executionId: "sw-exec-1" },
			request: makeRequest(),
		} as never)) as Response;

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			services: [expect.objectContaining({ status: "failed" })],
		});
	});
});
