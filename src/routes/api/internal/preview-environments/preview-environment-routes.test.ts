import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const app = {
    vclusterPreviews: {
      list: vi.fn(async () => ({ previews: [], counts: null })),
      present: vi.fn((preview: unknown) => preview),
      presentLaunch: vi.fn(() => ({
        ok: true as const,
        preview: { name: "preview-one", phase: "provisioning" },
        pooled: false,
      })),
      observeRuntime: vi.fn(async () => ({ name: "preview-one", services: [] })),
      teardownStatus: vi.fn(async () => ({ phase: "complete" })),
    },
    previewEnvironmentLaunchBroker: {
      launchForUser: vi.fn(async () => ({ ok: true, environment: {} })),
    },
    previewAccess: {
      authorize: vi.fn(async () => ({
        preview: { name: "preview-one", phase: "ready" },
      })),
    },
    previewTraces: {
      list: vi.fn(async () => ({ traces: [], services: [], observedAt: "now" })),
    },
    previewTeardown: {
      teardown: vi.fn(async () => ({
        preview: { name: "preview-one", phase: "terminating" },
        archive: null,
        ticket: {
          name: "preview-one",
          environmentUid: "uid-1",
          requestId: "request-1",
          sourceRevision: "b".repeat(40),
          signature: "e".repeat(64),
        },
      })),
    },
  };
  return {
    app,
    guardPreviewMcp: vi.fn(async () => ({
      ok: true as const,
      app,
      principal: { userId: "user-1", projectId: "project-1" },
    })),
  };
});

vi.mock("./guard", () => ({
  guardPreviewMcp: mocks.guardPreviewMcp,
  previewMcpError: (cause: unknown) => {
    throw cause;
  },
}));

import { GET as FLEET, POST as LAUNCH } from "./+server";
import { DELETE as TEARDOWN, GET as STATUS } from "./[name]/+server";
import { GET as RUNTIME } from "./[name]/runtime/+server";
import { GET as TRACES } from "./[name]/traces/+server";
import { POST as CLEANUP } from "./[name]/teardown/status/+server";

const base = "http://localhost/api/internal/preview-environments";

function getEvent(path = "", params: Record<string, string> = {}) {
  const url = new URL(`${base}${path}`);
  return { request: new Request(url), url, params };
}

function bodyEvent(
  method: string,
  path: string,
  body: unknown,
  params: Record<string, string> = {},
) {
  const url = new URL(`${base}${path}`);
  return {
    request: new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    params,
  };
}

describe("internal Workflow MCP preview routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guardPreviewMcp.mockResolvedValue({
      ok: true,
      app: mocks.app,
      principal: { userId: "user-1", projectId: "project-1" },
    });
  });

  it("requires control-plane admin authority for fleet listing and launch", async () => {
    await FLEET(getEvent() as never);
    expect(mocks.guardPreviewMcp).toHaveBeenLastCalledWith(expect.any(Request), {
      requiredScope: "workflow:read",
      admin: true,
      controlPlane: true,
    });

    await LAUNCH(
      bodyEvent("POST", "", { name: "preview-one" }) as never,
    );
    expect(mocks.guardPreviewMcp).toHaveBeenLastCalledWith(expect.any(Request), {
      requiredScope: "workflow:execute",
      admin: true,
      controlPlane: true,
    });
  });

  it("passes the requested preview through deployment-scope checks for every read", async () => {
    const params = { name: "preview-one" };
    await STATUS(getEvent("/preview-one", params) as never);
    expect(mocks.guardPreviewMcp).toHaveBeenLastCalledWith(expect.any(Request), {
      requiredScope: "workflow:read",
      previewName: "preview-one",
    });

    await RUNTIME(getEvent("/preview-one/runtime", params) as never);
    expect(mocks.guardPreviewMcp).toHaveBeenLastCalledWith(expect.any(Request), {
      requiredScope: "workflow:read",
      previewName: "preview-one",
    });

    await TRACES(getEvent("/preview-one/traces?range=7d", params) as never);
    expect(mocks.guardPreviewMcp).toHaveBeenLastCalledWith(expect.any(Request), {
      requiredScope: "workflow:read",
      previewName: "preview-one",
    });
    expect(mocks.app.previewTraces.list).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ range: "7d" }) }),
    );
  });

  it("requires execute plus admin and control-plane scope for teardown", async () => {
    const params = { name: "preview-one" };
    await TEARDOWN(
      bodyEvent(
        "DELETE",
        "/preview-one",
        {
          expectedRequestId: "request-1",
          expectedSourceRevision: "b".repeat(40),
        },
        params,
      ) as never,
    );
    expect(mocks.guardPreviewMcp).toHaveBeenLastCalledWith(expect.any(Request), {
      requiredScope: "workflow:execute",
      admin: true,
      controlPlane: true,
      previewName: "preview-one",
    });

    await CLEANUP(
      bodyEvent(
        "POST",
        "/preview-one/teardown/status",
        {
          name: "preview-one",
          environmentUid: "uid-1",
          requestId: "request-1",
          sourceRevision: "b".repeat(40),
          signature: "e".repeat(64),
        },
        params,
      ) as never,
    );
    expect(mocks.guardPreviewMcp).toHaveBeenLastCalledWith(expect.any(Request), {
      requiredScope: "workflow:read",
      admin: true,
      controlPlane: true,
      previewName: "preview-one",
    });
  });

  it("returns failed cleanup checks as a terminal non-success response", async () => {
    mocks.app.vclusterPreviews.teardownStatus.mockResolvedValueOnce({
      phase: "failed",
      checks: {
        "runner-succeeded": false,
        "preview-environment-absent": true,
      },
      message: "runner failed",
    } as never);
    const params = { name: "preview-one" };
    const response = await CLEANUP(
      bodyEvent(
        "POST",
        "/preview-one/teardown/status",
        {
          name: "preview-one",
          environmentUid: "uid-1",
          requestId: "request-1",
          sourceRevision: "b".repeat(40),
          signature: "e".repeat(64),
        },
        params,
      ) as never,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      teardown: {
        phase: "failed",
        checks: { "runner-succeeded": false },
      },
      error: {
        code: "preview_teardown_failed",
        message: "runner failed",
      },
    });
  });
});
