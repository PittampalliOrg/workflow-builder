import { describe, expect, it, vi } from "vitest";
import type { WorkflowMcpPrincipal } from "../auth-context.js";
import {
  HttpWorkflowDiagnosticsAdapter,
  WorkflowDiagnosticsHttpError,
} from "./http-workflow-diagnostics.js";

const principal: WorkflowMcpPrincipal = {
  authMode: "workspace_api_key",
  userId: "user-1",
  projectId: "project-1",
  scopes: ["workflow:read"],
  principalAssertion: "signed-principal",
  capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("HttpWorkflowDiagnosticsAdapter", () => {
  it("forwards only service auth and the signed workspace assertion", async () => {
    const fetchImpl = vi.fn(async () => response(200, { executions: [] }));
    const adapter = new HttpWorkflowDiagnosticsAdapter({
      principal: { ...principal, sessionId: "optional-lineage" },
      fetchImpl: fetchImpl as any,
      workflowBuilderUrl: "http://bff/",
      internalApiToken: "internal-token",
      timeoutMs: 1234,
    });

    await adapter.listWorkflowExecutions({
      workflowId: "workflow-1",
      status: "error",
      limit: 15,
      cursor: "cursor-1",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://bff/api/internal/observability/executions?workflowId=workflow-1&status=error&limit=15&cursor=cursor-1",
    );
    expect(init.headers).toEqual({
      Accept: "application/json",
      "X-Internal-Token": "internal-token",
      "X-Wfb-Principal-Assertion": "signed-principal",
    });
    expect(JSON.stringify(init.headers)).not.toContain("optional-lineage");
    expect(JSON.stringify(init.headers)).not.toContain("project-1");
    expect(JSON.stringify(init.headers)).not.toContain("user-1");
  });

  it("encodes execution ids and forwards bounded trace filters", async () => {
    const fetchImpl = vi.fn(async () => response(200, { spans: [] }));
    const adapter = new HttpWorkflowDiagnosticsAdapter({
      principal,
      fetchImpl: fetchImpl as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal",
    });

    await adapter.searchSpans("execution/one", {
      query: "failed tool",
      errorsOnly: true,
      limit: 25,
      cursor: "next",
    });

    expect((fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[0]).toBe(
      "http://bff/api/internal/observability/executions/execution%2Fone/spans?query=failed+tool&errorsOnly=true&limit=25&cursor=next",
    );
  });

  it("forwards tool-call filters and the span-tree node cap", async () => {
    const fetchImpl = vi.fn(async () => response(200, { toolCalls: [] }));
    const adapter = new HttpWorkflowDiagnosticsAdapter({
      principal,
      fetchImpl: fetchImpl as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal",
    });

    await adapter.getToolCalls("execution-1", {
      sessionId: "session-1",
      toolName: "run_command",
      errorsOnly: true,
      limit: 10,
    });
    await adapter.getSpanTree("execution-1", 200);

    const urls = (
      fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>
    ).map((call) => call[0]);
    expect(urls[0]).toBe(
      "http://bff/api/internal/observability/executions/execution-1/tool-calls?sessionId=session-1&toolName=run_command&errorsOnly=true&limit=10",
    );
    expect(urls[1]).toBe(
      "http://bff/api/internal/observability/executions/execution-1/tree?maxNodes=200",
    );
  });

  it("maps BFF failures to stable diagnostics errors", async () => {
    const adapter = new HttpWorkflowDiagnosticsAdapter({
      principal,
      fetchImpl: vi.fn(async () =>
        response(404, { code: "execution_not_found", error: "Execution not found" }),
      ) as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal",
    });

    await expect(adapter.getDigest("execution-1")).rejects.toMatchObject({
      name: "WorkflowDiagnosticsHttpError",
      status: 404,
      code: "execution_not_found",
      message: "Execution not found",
    } satisfies Partial<WorkflowDiagnosticsHttpError>);
  });
});
