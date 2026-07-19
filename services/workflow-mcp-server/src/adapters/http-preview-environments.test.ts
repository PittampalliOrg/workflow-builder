import { describe, expect, it, vi } from "vitest";
import type { WorkflowMcpPrincipal } from "../auth-context.js";
import {
  HttpPreviewEnvironmentsAdapter,
  PreviewEnvironmentsHttpError,
} from "./http-preview-environments.js";

const principal: WorkflowMcpPrincipal = {
  authMode: "workspace_api_key",
  userId: "user-1",
  projectId: "project-1",
  sessionId: "session-1",
  scopes: ["workflow:read", "workflow:execute"],
  principalAssertion: "signed-principal",
  capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
};

function response(status: number, body: unknown, retryAfter?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(retryAfter ? { "retry-after": retryAfter } : {}),
  } as Response;
}

describe("HttpPreviewEnvironmentsAdapter", () => {
  it("forwards only service auth and the BFF-signed principal assertion", async () => {
    const fetchImpl = vi.fn(async () => response(200, { previews: [] }));
    const adapter = new HttpPreviewEnvironmentsAdapter({
      principal,
      fetchImpl: fetchImpl as any,
      workflowBuilderUrl: "http://bff/",
      internalApiToken: "internal-token",
    });

    await adapter.list();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://bff/api/internal/preview-environments");
    expect(init.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Internal-Token": "internal-token",
      "X-Wfb-Principal-Assertion": "signed-principal",
    });
    expect(JSON.stringify(init.headers)).not.toContain("session-1");
    expect(JSON.stringify(init.headers)).not.toContain("project-1");
    expect(JSON.stringify(init.headers)).not.toContain("user-1");
    expect(JSON.stringify(init.headers)).not.toContain("Authorization");
  });

  it("encodes names and bounded 7d trace filters", async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, { traces: [], services: [], observedAt: "now" }),
    );
    const adapter = new HttpPreviewEnvironmentsAdapter({
      principal,
      fetchImpl: fetchImpl as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal-token",
    });

    await adapter.queryTraces("preview/one", {
      range: "7d",
      status: "error",
      service: "workflow-builder",
      limit: 50,
    });

    expect(
      (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]?.[0],
    ).toBe(
      "http://bff/api/internal/preview-environments/preview%2Fone/traces?range=7d&status=error&service=workflow-builder&limit=50",
    );
  });

  it("keeps teardown tickets in a request body rather than a URL", async () => {
    const fetchImpl = vi.fn(async () =>
      response(202, { teardown: { phase: "pending" } }),
    );
    const adapter = new HttpPreviewEnvironmentsAdapter({
      principal,
      fetchImpl: fetchImpl as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal-token",
    });
    const ticket = {
      name: "preview-one",
      environmentUid: "uid-1",
      requestId: "request-1",
      sourceRevision: "b".repeat(40),
      signature: "e".repeat(64),
    };

    await adapter.getTeardownStatus(ticket);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).not.toContain(ticket.signature);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(ticket);
  });

  it("maps retryable BFF failures and retry guidance", async () => {
    const adapter = new HttpPreviewEnvironmentsAdapter({
      principal,
      fetchImpl: vi.fn(async () =>
        response(
          503,
          { error: { code: "preview_service_unavailable", message: "offline" } },
          "5",
        ),
      ) as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal-token",
    });

    await expect(adapter.get("preview-one")).rejects.toMatchObject({
      name: "PreviewEnvironmentsHttpError",
      status: 503,
      code: "preview_service_unavailable",
      message: "offline",
      retryable: true,
      retryAfterMs: 5_000,
    } satisfies Partial<PreviewEnvironmentsHttpError>);
  });
});
