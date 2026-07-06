import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));

const mocks = vi.hoisted(() => {
	const getSessionFileOwner = vi.fn(async () => ({
		id: "sess-1",
		userId: "user-1",
		projectId: "proj-1",
	}) as { id: string; userId: string; projectId: string | null } | null);
	type CreateResult =
		| { status: "ok"; httpStatus: number; body: { id: string } }
		| { status: "error"; httpStatus: number; body: string };
	const createWorkflow = vi.fn(
		async (): Promise<CreateResult> => ({
			status: "ok",
			httpStatus: 201,
			body: { id: "wf-inline-1" },
		}),
	);
	const validateInternalToken = vi.fn(() => true);
	const startWorkflowRun = vi.fn(async () => ({
		ok: true as const,
		executionId: "exec-1",
		instanceId: "dsw-1",
		workflowId: "wf-inline-1",
		workflowName: "Inline dynamic script",
		status: "running" as const,
		reused: false,
	}));
	return { getSessionFileOwner, createWorkflow, validateInternalToken, startWorkflowRun };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: { getSessionFileOwner: mocks.getSessionFileOwner },
		workflowDefinitionCommands: { createWorkflow: mocks.createWorkflow },
	}),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/workflows/start-run", () => ({
	startWorkflowRun: mocks.startWorkflowRun,
}));

import { POST } from "./+server";

const SCRIPT = "export const meta = { name: 'Inline demo' }\nreturn {}";

function req(body: unknown, headers: Record<string, string> = {}): Request {
	return new Request("http://x/api/internal/agent/workflows/execute-script", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function call(request: Request) {
	return POST({ request } as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.validateInternalToken.mockReturnValue(true);
	mocks.getSessionFileOwner.mockResolvedValue({
		id: "sess-1",
		userId: "user-1",
		projectId: "proj-1",
	});
	mocks.createWorkflow.mockResolvedValue({
		status: "ok",
		httpStatus: 201,
		body: { id: "wf-inline-1" },
	});
});

describe("POST /api/internal/agent/workflows/execute-script", () => {
	it("validates → creates ephemeral workflow → starts run, returns ids", async () => {
		const res = await call(req({ script: SCRIPT, args: { topic: "hi" }, budgetTotal: 5000 }, { "X-Wfb-Session-Id": "sess-1" }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			executionId: "exec-1",
			instanceId: "dsw-1",
			workflowId: "wf-inline-1",
		});
		expect(mocks.createWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				projectId: "proj-1",
				body: expect.objectContaining({ engineType: "dynamic-script" }),
			}),
		);
		expect(mocks.startWorkflowRun).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "wf-inline-1",
				triggerData: { topic: "hi" },
				userId: "user-1",
				budgetTotal: 5000,
			}),
		);
	});

	it("401s without a valid internal token", async () => {
		mocks.validateInternalToken.mockReturnValue(false);
		const res = await call(req({ script: SCRIPT }, { "X-Wfb-Session-Id": "sess-1" }));
		expect(res.status).toBe(401);
	});

	it("400s when script is missing", async () => {
		const res = await call(req({ args: {} }, { "X-Wfb-Session-Id": "sess-1" }));
		expect(res.status).toBe(400);
	});

	it("400s when the session header is absent", async () => {
		const res = await call(req({ script: SCRIPT }));
		expect(res.status).toBe(400);
	});

	it("404s when the session owner cannot be resolved", async () => {
		mocks.getSessionFileOwner.mockResolvedValue(null);
		const res = await call(req({ script: SCRIPT }, { "X-Wfb-Session-Id": "ghost" }));
		expect(res.status).toBe(404);
	});

	it("forwards a validation failure from createWorkflow", async () => {
		mocks.createWorkflow.mockResolvedValue({
			status: "error",
			httpStatus: 400,
			body: "script must declare `export const meta = …`",
		});
		const res = await call(req({ script: "bad" }, { "X-Wfb-Session-Id": "sess-1" }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/export const meta/);
	});
});
