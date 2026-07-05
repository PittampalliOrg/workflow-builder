import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workflowData: {
		getSessionDetail: vi.fn(),
		findProjectWorkflowIdByIdOrNamePrefix: vi.fn(),
		getDevEnvironmentOrPending: vi.fn(),
		listDevEnvironmentGroups: vi.fn(),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { load } from "./+page.server";

const locals = { session: { userId: "u1", projectId: "p1" } };

function baseSession(over: Record<string, unknown> = {}) {
	return {
		id: "s1",
		title: "t",
		status: "idle",
		stopReason: null,
		agentId: "a1",
		agentSlug: "claude-code",
		workflowExecutionId: null,
		workflowId: null,
		...over,
	};
}

describe("session detail loader", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.findProjectWorkflowIdByIdOrNamePrefix.mockResolvedValue(
			null,
		);
		mocks.workflowData.listDevEnvironmentGroups.mockResolvedValue([]);
		mocks.workflowData.getDevEnvironmentOrPending.mockResolvedValue(null);
	});

	it("401s an unauthenticated request pre-paint", async () => {
		await expect(
			load({ params: { id: "s1" }, locals: {} } as never),
		).rejects.toMatchObject({ status: 401 });
		expect(mocks.workflowData.getSessionDetail).not.toHaveBeenCalled();
	});

	it("404s an unknown / out-of-scope session pre-paint", async () => {
		mocks.workflowData.getSessionDetail.mockResolvedValue(null);
		await expect(
			load({ params: { id: "nope" }, locals } as never),
		).rejects.toMatchObject({ status: 404 });
		expect(mocks.workflowData.getSessionDetail).toHaveBeenCalledWith({
			sessionId: "nope",
			projectId: "p1",
			userId: "u1",
		});
	});

	it("classifies an interactive session and loads no dev context", async () => {
		mocks.workflowData.getSessionDetail.mockResolvedValue(baseSession());
		const res = await load({ params: { id: "s1" }, locals } as never);
		expect(res).toMatchObject({ kind: "interactive", devContext: null });
		expect(mocks.workflowData.getDevEnvironmentOrPending).not.toHaveBeenCalled();
	});

	it("classifies an experiment fork by slug", async () => {
		mocks.workflowData.getSessionDetail.mockResolvedValue(
			baseSession({ agentSlug: "exp-abc" }),
		);
		const res = await load({ params: { id: "s1" }, locals } as never);
		expect(res).toMatchObject({ kind: "experiment", devContext: null });
	});

	it("classifies a dev session and loads the dev topology", async () => {
		mocks.workflowData.findProjectWorkflowIdByIdOrNamePrefix.mockResolvedValue(
			"wf-dev",
		);
		mocks.workflowData.getSessionDetail.mockResolvedValue(
			baseSession({ workflowId: "wf-dev", workflowExecutionId: "e1" }),
		);
		mocks.workflowData.getDevEnvironmentOrPending.mockResolvedValue({
			executionId: "e1",
			ready: false,
		});
		mocks.workflowData.listDevEnvironmentGroups.mockResolvedValue([
			{ executionId: "e1", services: [], ready: false },
			{ executionId: "other", services: [], ready: true },
		]);
		const res = await load({ params: { id: "s1" }, locals } as never);
		expect(res).toMatchObject({
			kind: "dev",
			devContext: { executionId: "e1", group: { executionId: "e1" } },
		});
		expect(mocks.workflowData.getDevEnvironmentOrPending).toHaveBeenCalledWith({
			executionId: "e1",
			projectId: "p1",
		});
	});
});
