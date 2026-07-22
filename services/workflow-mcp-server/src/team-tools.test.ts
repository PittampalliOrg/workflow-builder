import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWithWorkflowMcpContext,
  type WorkflowMcpRequestContext,
} from "./auth-context.js";
import { runWithSessionContext } from "./session-context.js";
import { runWithTeamContext } from "./team-context.js";
import {
  currentTeamActionHeaders,
  redriveAcceptedTeamAction,
  registerTeamTools,
} from "./team-tools.js";

const { fetchMock } = vi.hoisted(() => {
  process.env.INTERNAL_API_TOKEN = "test-internal-token";
  process.env.TEAM_ACTION_PENDING_MAX_ATTEMPTS = "2";
  process.env.TEAM_ACTION_PENDING_RETRY_MS = "1";
  return { fetchMock: vi.fn() };
});

const context: WorkflowMcpRequestContext = {
  principal: {
    authMode: "platform_session",
    userId: "user-1",
    projectId: "project-1",
    scopes: ["session:team"],
    sessionId: "session-1",
    principalAssertion: "signed-team-principal",
    capabilities: {
      scriptDepth: 0,
      teamId: "team-session-1",
      teamRole: "lead",
    },
  },
};

describe("Workflow MCP team action headers", () => {
  it("forwards the signed principal assertion and its exact session lineage", () => {
    const headers = runWithWorkflowMcpContext(context, () =>
      runWithSessionContext({ sessionId: "session-1" }, () =>
        currentTeamActionHeaders(),
      ),
    );

    expect(headers).toMatchObject({
      "X-Wfb-Principal-Assertion": "signed-team-principal",
      "X-Wfb-Session-Id": "session-1",
    });
    expect(headers).not.toHaveProperty("X-Wfb-Principal-User-Id");
  });

  it("rejects a request context whose session differs from the assertion", () => {
    expect(() =>
      runWithWorkflowMcpContext(context, () =>
        runWithSessionContext({ sessionId: "other-session" }, () =>
          currentTeamActionHeaders(),
        ),
      ),
    ).toThrow("signed Workflow MCP session principal");
  });
});

describe("accepted team action redrive", () => {
  const response = (status: number) => ({
    ok: status >= 200 && status < 300,
    status,
    json: status === 202 ? { pending: true } : { ok: true },
    text: "",
  });

  it("redrives a pending action until the BFF proves it terminal", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(202))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      redriveAcceptedTeamAction(request, {
        maxAttempts: 3,
        retryDelayMs: 25,
        sleep,
      }),
    ).resolves.toEqual(response(200));
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("returns a still-pending response after the bounded attempts", async () => {
    const request = vi.fn().mockResolvedValue(response(202));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      redriveAcceptedTeamAction(request, {
        maxAttempts: 3,
        retryDelayMs: 0,
        sleep,
      }),
    ).resolves.toEqual(response(202));
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not redrive a terminal response", async () => {
    const request = vi.fn().mockResolvedValue(response(422));

    await expect(
      redriveAcceptedTeamAction(request, { maxAttempts: 3 }),
    ).resolves.toEqual(response(422));
    expect(request).toHaveBeenCalledOnce();
  });

  it("redrives a transient server failure with the identical request", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      redriveAcceptedTeamAction(request, {
        maxAttempts: 3,
        retryDelayMs: 25,
        sleep,
      }),
    ).resolves.toEqual(response(200));
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("redrives an ambiguous transport failure with the identical request", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      redriveAcceptedTeamAction(request, {
        maxAttempts: 3,
        retryDelayMs: 25,
        sleep,
      }),
    ).resolves.toEqual(response(200));
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });
});

describe("team action tool pending wiring", () => {
  let handlers: Map<string, (args: any) => Promise<any>>;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    handlers = new Map();
    registerTeamTools({
      registerTool: vi.fn(
        (
          name: string,
          _definition: unknown,
          handler: (args: any) => Promise<any>,
        ) => {
          handlers.set(name, handler);
        },
      ),
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function runHandler(name: string, args: Record<string, unknown>) {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`missing ${name} handler`);
    return runWithWorkflowMcpContext(context, () =>
      runWithSessionContext({ sessionId: "session-1" }, () =>
        runWithTeamContext({ teamId: "team-session-1" }, () => handler(args)),
      ),
    );
  }

  it("redrives spawn_teammate with the identical request before succeeding", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, spawn: { pending: true } }), {
          status: 202,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, spawn: { pending: false } }), {
          status: 200,
        }),
      );

    const result = await runHandler("spawn_teammate", {
      agentSlug: "worker",
      name: "researcher",
      prompt: "Investigate",
      planModeRequired: false,
    });

    expect(result).not.toHaveProperty("isError");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requests = fetchMock.mock.calls.map(([, init]) => init?.body);
    expect(requests[0]).toBe(requests[1]);
  });

  it("reports revive_teammate as nonterminal when bounded redrive stays pending", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, spawn: { pending: true } }), {
          status: 202,
        }),
      ),
    );

    const result = await runHandler("revive_teammate", {
      name: "researcher",
      prompt: "Continue",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]?.text).toContain("accepted but is still pending");
  });
});
