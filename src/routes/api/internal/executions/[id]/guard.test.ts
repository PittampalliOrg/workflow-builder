import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		workflowId: "workflow-1",
		userId: "user-1",
		projectId: "project-1",
	};
	return {
		execution,
		getScopedExecutionById: vi.fn(
			async (): Promise<typeof execution | null> => execution,
		),
		internalWorkflowPrincipal: { authorize: vi.fn() },
		resolveInternalWorkflowPrincipal: vi.fn(async () => ({
			ok: true as const,
			principal: {
				userId: "user-1",
				projectId: "project-1",
				sessionId: null,
				scopes: ["workflow:read", "workflow:execute"],
			},
		})),
		validateInternalToken: vi.fn(() => true),
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: { getScopedExecutionById: mocks.getScopedExecutionById },
		internalWorkflowPrincipal: mocks.internalWorkflowPrincipal,
	}),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("../../workflow-mcp-principal", () => ({
	resolveInternalWorkflowPrincipal: mocks.resolveInternalWorkflowPrincipal,
}));

import { guardInternalExecutionAccess } from "./guard";

function request() {
	return new Request(
		"http://localhost/api/internal/executions/exec-1/resume",
		{
			method: "POST",
			headers: {
				"X-Internal-Token": "internal-token",
				"X-Wfb-Principal-Assertion": "signed-principal",
			},
		},
	);
}

describe("internal execution-control guard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.getScopedExecutionById.mockResolvedValue(mocks.execution);
		mocks.resolveInternalWorkflowPrincipal.mockResolvedValue({
			ok: true,
			principal: {
				userId: "user-1",
				projectId: "project-1",
				sessionId: null,
				scopes: ["workflow:read", "workflow:execute"],
			},
		});
	});

	it("rejects an invalid service token before principal or data access", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);
		const result = await guardInternalExecutionAccess(
			request(),
			"exec-1",
			"workflow:execute",
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected denial");
		expect(result.res.status).toBe(401);
		expect(mocks.resolveInternalWorkflowPrincipal).not.toHaveBeenCalled();
		expect(mocks.getScopedExecutionById).not.toHaveBeenCalled();
	});

	it("passes the required scope through to the principal authorizer", async () => {
		const req = request();
		const result = await guardInternalExecutionAccess(
			req,
			"exec-1",
			"workflow:execute",
		);
		expect(mocks.resolveInternalWorkflowPrincipal).toHaveBeenCalledWith(
			req,
			mocks.internalWorkflowPrincipal,
			{ requiredScope: "workflow:execute" },
		);
		expect(mocks.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(result).toEqual({ ok: true, execution: mocks.execution });
	});

	it("returns the principal authorization failure before data access", async () => {
		mocks.resolveInternalWorkflowPrincipal.mockResolvedValueOnce({
			ok: false,
			status: 403,
			error: "The Workflow MCP principal lacks workflow:execute scope",
		} as never);
		const result = await guardInternalExecutionAccess(
			request(),
			"exec-1",
			"workflow:execute",
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected denial");
		expect(result.res.status).toBe(403);
		expect(mocks.getScopedExecutionById).not.toHaveBeenCalled();
	});

	it("does not reveal an execution outside the principal workspace", async () => {
		mocks.getScopedExecutionById.mockResolvedValueOnce(null);
		const result = await guardInternalExecutionAccess(
			request(),
			"exec-other",
			"workflow:read",
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected denial");
		expect(result.res.status).toBe(404);
		await expect(result.res.json()).resolves.toEqual({
			error: "Execution exec-other not found in this workspace",
		});
	});
});
