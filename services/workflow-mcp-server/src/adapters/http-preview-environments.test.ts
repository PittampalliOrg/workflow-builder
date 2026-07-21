import { describe, expect, it, vi } from "vitest";
import type { WorkflowMcpPrincipal } from "../auth-context.js";
import {
  DEFAULT_PREVIEW_ENVIRONMENT_REQUEST_TIMEOUT_MS,
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

  it("keeps the MCP transport outside the broker timeout budget", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const adapter = new HttpPreviewEnvironmentsAdapter({
      principal,
      fetchImpl: vi.fn(async () => response(200, { previews: [] })) as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal-token",
    });

    await adapter.list();

    expect(DEFAULT_PREVIEW_ENVIRONMENT_REQUEST_TIMEOUT_MS).toBe(25_000);
    expect(timeout).toHaveBeenCalledWith(25_000);
    timeout.mockRestore();
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

  it("preserves the bounded trace retry contract from the BFF", async () => {
    const adapter = new HttpPreviewEnvironmentsAdapter({
      principal,
      fetchImpl: vi.fn(async () =>
        response(
          504,
          {
            error: {
              code: "preview_trace_timeout",
              message: "trace evidence timed out",
              details: { range: "24h", retryRange: "6h" },
            },
          },
          "1",
        ),
      ) as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal-token",
    });

    await expect(
      adapter.queryTraces("preview-one", { range: "24h" }),
    ).rejects.toMatchObject({
      status: 504,
      code: "preview_trace_timeout",
      retryAfterMs: 1_000,
      details: { range: "24h", retryRange: "6h" },
    } satisfies Partial<PreviewEnvironmentsHttpError>);
  });

  it("preserves terminal teardown evidence from a failed cleanup response", async () => {
    const teardown = {
      phase: "failed",
      checks: { "runner-succeeded": false },
      message: "runner failed",
    };
    const ticket = {
      name: "preview-one",
      environmentUid: "uid-1",
      requestId: "request-1",
      sourceRevision: "b".repeat(40),
      signature: "e".repeat(64),
    };
    const adapter = new HttpPreviewEnvironmentsAdapter({
      principal,
      fetchImpl: vi.fn(async () =>
        response(409, {
          teardown,
          ticket,
          error: {
            code: "preview_teardown_failed",
            message: "runner failed",
          },
        }),
      ) as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal-token",
    });

    await expect(adapter.getTeardownStatus(ticket)).rejects.toMatchObject({
      status: 409,
      code: "preview_teardown_failed",
      retryable: false,
      details: { teardown, ticket },
    } satisfies Partial<PreviewEnvironmentsHttpError>);
  });

  it("maps an abort while consuming a successful response body to a timeout", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw Object.assign(new Error("response body aborted"), {
            name: "AbortError",
          });
        },
      }) as unknown as Response,
    );
    const adapter = new HttpPreviewEnvironmentsAdapter({
      principal,
      fetchImpl: fetchImpl as any,
      workflowBuilderUrl: "http://bff",
      internalApiToken: "internal-token",
      timeoutMs: 4_321,
    });

    await expect(adapter.list()).rejects.toMatchObject({
      name: "PreviewEnvironmentsHttpError",
      status: 504,
      code: "preview_management_timeout",
      retryable: true,
    } satisfies Partial<PreviewEnvironmentsHttpError>);
  });

  it.each([
    ["null JSON", async () => null],
    [
      "malformed JSON",
      async () => {
        throw new SyntaxError("unexpected token");
      },
    ],
  ])(
    "rejects a successful %s body as an invalid response",
    async (_name, json) => {
      const adapter = new HttpPreviewEnvironmentsAdapter({
        principal,
        fetchImpl: vi.fn(async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            json,
          }) as unknown as Response,
        ) as any,
        workflowBuilderUrl: "http://bff",
        internalApiToken: "internal-token",
      });

      await expect(adapter.list()).rejects.toMatchObject({
        name: "PreviewEnvironmentsHttpError",
        status: 502,
        code: "preview_management_invalid_response",
        retryable: true,
      } satisfies Partial<PreviewEnvironmentsHttpError>);
    },
  );
});
