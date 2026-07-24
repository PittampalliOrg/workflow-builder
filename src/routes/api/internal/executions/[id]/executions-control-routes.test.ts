import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		userId: "user-1",
		projectId: "project-1",
	};
	return {
		execution,
		guardInternalExecutionAccess: vi.fn(async () => ({
			ok: true as const,
			execution,
		})),
		workflowCodeCheckpoints: {
			listForExecution: vi.fn(async () => [{ id: "cp-1" }]),
			restoreCheckpoint: vi.fn(async () => ({ ok: true, restored: true })),
		},
		workflowExecutionControl: {
			resumeExecution: vi.fn(
				async (): Promise<unknown> => ({
					status: "ok" as const,
					body: { ok: true, executionId: "exec-2" },
				}),
			),
		},
		workflowCodeVersions: {
			listVersions: vi.fn(async () => ({
				status: "ok" as const,
				body: { versions: [{ artifactId: "art-1" }], unpromotedCount: 1 },
			})),
		},
		workflowCodeVersionPromotion: {
			promote: vi.fn(async () => ({
				status: "ok" as const,
				body: { ok: true, prUrl: "https://github.com/o/r/pull/1" },
			})),
		},
	};
});

vi.mock("./guard", () => ({
	guardInternalExecutionAccess: mocks.guardInternalExecutionAccess,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowCodeCheckpoints: mocks.workflowCodeCheckpoints,
		workflowExecutionControl: mocks.workflowExecutionControl,
		workflowCodeVersions: mocks.workflowCodeVersions,
		workflowCodeVersionPromotion: mocks.workflowCodeVersionPromotion,
	}),
}));

import { GET as listCheckpoints } from "./code-checkpoints/+server";
import { POST as restoreCheckpoint } from "./code-checkpoints/[checkpointId]/restore/+server";
import { POST as resume } from "./resume/+server";
import { GET as listVersions } from "./versions/+server";
import { POST as promote } from "./versions/[artifactId]/promote/+server";

function req(body?: unknown) {
	return new Request("http://localhost/api/internal/executions/exec-1/x", {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

describe("internal execution-control routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.guardInternalExecutionAccess.mockResolvedValue({
			ok: true,
			execution: mocks.execution,
		});
	});

	it("lists checkpoints for the guarded execution (read scope)", async () => {
		const res = (await listCheckpoints({
			params: { id: "exec-1" },
			request: req(),
		} as never)) as Response;
		expect(mocks.guardInternalExecutionAccess).toHaveBeenCalledWith(
			expect.anything(),
			"exec-1",
			"workflow:read",
		);
		expect(mocks.workflowCodeCheckpoints.listForExecution).toHaveBeenCalledWith({
			executionId: "exec-1",
		});
		await expect(res.json()).resolves.toEqual({ checkpoints: [{ id: "cp-1" }] });
	});

	it("short-circuits when the guard denies access", async () => {
		mocks.guardInternalExecutionAccess.mockResolvedValueOnce({
			ok: false,
			res: new Response(JSON.stringify({ error: "unauthorized" }), {
				status: 401,
			}),
		} as never);
		const res = (await listCheckpoints({
			params: { id: "exec-1" },
			request: req(),
		} as never)) as Response;
		expect(res.status).toBe(401);
		expect(mocks.workflowCodeCheckpoints.listForExecution).not.toHaveBeenCalled();
	});

	it("restores a checkpoint under execute scope", async () => {
		const res = (await restoreCheckpoint({
			params: { id: "exec-1", checkpointId: "cp-1" },
			request: req({ sandboxName: "sbx-9" }),
		} as never)) as Response;
		expect(mocks.guardInternalExecutionAccess).toHaveBeenCalledWith(
			expect.anything(),
			"exec-1",
			"workflow:execute",
		);
		expect(mocks.workflowCodeCheckpoints.restoreCheckpoint).toHaveBeenCalledWith({
			executionId: "exec-1",
			checkpointId: "cp-1",
			sandboxName: "sbx-9",
			repoPath: null,
		});
		await expect(res.json()).resolves.toMatchObject({ ok: true });
	});

	it("resumes and maps the control result body", async () => {
		const res = (await resume({
			params: { id: "exec-1" },
			request: req({ fromNodeId: "node-b" }),
		} as never)) as Response;
		expect(mocks.workflowExecutionControl.resumeExecution).toHaveBeenCalledWith({
			executionId: "exec-1",
			body: { fromNodeId: "node-b" },
			userId: "user-1",
			projectId: "project-1",
		});
		await expect(res.json()).resolves.toEqual({
			ok: true,
			executionId: "exec-2",
		});
	});

	it("maps a control error result to its httpStatus", async () => {
		mocks.workflowExecutionControl.resumeExecution.mockResolvedValueOnce({
			status: "error",
			httpStatus: 409,
			message: "Source run is still active",
		});
		const res = (await resume({
			params: { id: "exec-1" },
			request: req({}),
		} as never)) as Response;
		expect(res.status).toBe(409);
		await expect(res.json()).resolves.toEqual({
			error: "Source run is still active",
		});
	});

	it("lists versions (read scope) and promotes (execute scope)", async () => {
		const vres = (await listVersions({
			params: { id: "exec-1" },
			request: req(),
		} as never)) as Response;
		await expect(vres.json()).resolves.toMatchObject({ unpromotedCount: 1 });

		const pres = (await promote({
			params: { id: "exec-1", artifactId: "art-1" },
			request: req({ mode: "pr" }),
		} as never)) as Response;
		expect(mocks.workflowCodeVersionPromotion.promote).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "art-1",
			userId: "user-1",
			projectId: "project-1",
			body: { mode: "pr" },
		});
		await expect(pres.json()).resolves.toMatchObject({
			ok: true,
			prUrl: "https://github.com/o/r/pull/1",
		});
	});
});
