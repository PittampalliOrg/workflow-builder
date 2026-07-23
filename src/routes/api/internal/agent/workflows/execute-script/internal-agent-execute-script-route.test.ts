import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));

const mocks = vi.hoisted(() => {
  const authorizePrincipal = vi.fn();
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
  const trustedInternalStartContext = vi.fn();
  const getExecutionById = vi.fn(
    async (): Promise<{
      id: string;
      daprInstanceId: string | null;
      workflowId: string;
    } | null> => null,
  );
  const getScopedWorkflowById = vi.fn(async () => null);
	const startWorkflowRun = vi.fn(async () => ({
		ok: true as const,
		executionId: "exec-1",
		instanceId: "dsw-1",
		workflowId: "wf-inline-1",
		workflowName: "Inline dynamic script",
		status: "running" as const,
		reused: false,
	}));
  return {
    authorizePrincipal,
    getScopedWorkflowById,
    getExecutionById,
    createWorkflow,
    validateInternalToken,
    trustedInternalStartContext,
    startWorkflowRun,
  };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
    internalWorkflowPrincipal: { authorize: mocks.authorizePrincipal },
    workflowData: {
      getScopedWorkflowById: mocks.getScopedWorkflowById,
    },
    workflowExecutions: { getById: mocks.getExecutionById },
		workflowDefinitionCommands: { createWorkflow: mocks.createWorkflow },
    workflowLaunchPolicy: {
      trustedInternalStartContext: mocks.trustedInternalStartContext,
    },
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

function assertion() {
  return "signed-principal";
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.validateInternalToken.mockReturnValue(true);
  mocks.trustedInternalStartContext.mockReturnValue(null);
  mocks.authorizePrincipal.mockResolvedValue({
    ok: true,
    principal: {
		userId: "user-1",
		projectId: "proj-1",
      sessionId: "sess-1",
      scopes: ["workflow:execute"],
    },
	});
	mocks.createWorkflow.mockResolvedValue({
		status: "ok",
		httpStatus: 201,
		body: { id: "wf-inline-1" },
	});
  mocks.getExecutionById.mockResolvedValue(null);
  mocks.getScopedWorkflowById.mockResolvedValue(null);
});

describe("POST /api/internal/agent/workflows/execute-script", () => {
	it("validates → creates ephemeral workflow → starts run, returns ids", async () => {
    const res = await call(
      req(
        { script: SCRIPT, args: { topic: "hi" }, budgetTotal: 5000 },
        { "X-Wfb-Session-Id": "sess-1" },
      ),
    );
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

  it("uses a trusted workspace principal without requiring a session", async () => {
    const res = await call(
      req(
        { script: SCRIPT },
        {
          "X-Wfb-Principal-Assertion": assertion(),
        },
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        projectId: "proj-1",
      }),
    );
  });

  it("uses deployment-owned launch context for inline scripts", async () => {
    mocks.trustedInternalStartContext.mockReturnValue({
      launchSurface: "dev-environment",
      launchOrigin: "https://wfb-preview-one.tail286401.ts.net",
    });
    const res = await call(
      req(
        {
          script: SCRIPT,
          launchSurface: "forged",
          launchOrigin: "https://wfb-other.example",
        },
        {
          Origin: "https://wfb-attacker.other-tailnet.ts.net",
          "X-Wfb-Principal-Assertion": assertion(),
        },
      ),
    );

    expect(res.status).toBe(200);
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        launchSurface: "dev-environment",
        launchOrigin: "https://wfb-preview-one.tail286401.ts.net",
      }),
    );
  });

  it("does not disclose an idempotent execution from another workspace", async () => {
    mocks.getExecutionById.mockResolvedValue({
      id: "execution-other",
      daprInstanceId: "instance-other",
      workflowId: "workflow-other",
    });
    mocks.getScopedWorkflowById.mockResolvedValue(null);
    const res = await call(
      req(
        { script: SCRIPT, executionId: "execution-other" },
        { "X-Wfb-Principal-Assertion": assertion() },
      ),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Execution not found" });
    expect(mocks.createWorkflow).not.toHaveBeenCalled();
  });

	it("401s without a valid internal token", async () => {
		mocks.validateInternalToken.mockReturnValue(false);
    const res = await call(
      req({ script: SCRIPT }, { "X-Wfb-Session-Id": "sess-1" }),
    );
		expect(res.status).toBe(401);
	});

	it("400s when script is missing", async () => {
		const res = await call(req({ args: {} }, { "X-Wfb-Session-Id": "sess-1" }));
		expect(res.status).toBe(400);
	});

	it("400s when the session header is absent", async () => {
    mocks.authorizePrincipal.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error:
        "An authenticated workspace principal or trusted platform session is required",
    });
		const res = await call(req({ script: SCRIPT }));
		expect(res.status).toBe(400);
	});

	it("404s when the session owner cannot be resolved", async () => {
    mocks.authorizePrincipal.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Session ghost not found",
    });
    const res = await call(
      req({ script: SCRIPT }, { "X-Wfb-Session-Id": "ghost" }),
    );
		expect(res.status).toBe(404);
	});

	it("forwards a validation failure from createWorkflow", async () => {
		mocks.createWorkflow.mockResolvedValue({
			status: "error",
			httpStatus: 400,
			body: "script must declare `export const meta = …`",
		});
    const res = await call(
      req({ script: "bad" }, { "X-Wfb-Session-Id": "sess-1" }),
    );
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/export const meta/);
	});
});
