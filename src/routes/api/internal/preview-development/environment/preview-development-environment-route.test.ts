import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewDevelopmentEnvironmentError } from "$lib/server/application/preview-development-environment";

const TARGET = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  platformRevision: "a".repeat(40),
  sourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}`,
};
const TICKET = {
  name: "feature-one",
  environmentUid: "uid-1",
  requestId: "request-1",
  sourceRevision: "b".repeat(40),
  signature: "d".repeat(64),
};

const mocks = vi.hoisted(() => ({
  requirePreviewActionInternal: vi.fn((request: Request) => {
    if (
      request.headers.get("x-preview-action-token") !== "preview-purpose-token"
    ) {
      throw new Error("invalid preview action token");
    }
  }),
  launchEnvironment: vi.fn(async (input) => ({
    kind: "launch-environment",
    operationId: input.operationId,
    target: TARGET,
    phase: "provisioning",
    ready: false,
    url: null,
    reused: false,
  })),
  getEnvironmentStatus: vi.fn(async (input) => ({
    kind: "get-environment-status",
    operationId: input.operationId,
    target: input.target,
    phase: "ready",
    ready: true,
    url: "https://wfb-feature-one.tailnet.ts.net/",
  })),
  teardownEnvironment: vi.fn(async (input) => ({
    kind: "teardown-environment",
    operationId: input.operationId,
    target: input.target,
    phase: "terminating",
    ticket: TICKET,
    complete: false,
  })),
  getEnvironmentTeardownStatus: vi.fn(async (input) => ({
    kind: "get-environment-teardown-status",
    operationId: input.operationId,
    target: input.target,
    ticket: input.ticket,
    cleanup: { name: "feature-one", complete: true },
    complete: true,
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewActionInternal: mocks.requirePreviewActionInternal,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewDevelopmentEnvironment: {
      launchEnvironment: mocks.launchEnvironment,
      getEnvironmentStatus: mocks.getEnvironmentStatus,
      teardownEnvironment: mocks.teardownEnvironment,
      getEnvironmentTeardownStatus: mocks.getEnvironmentTeardownStatus,
    },
  }),
}));

import { POST } from "./+server";

function event(command: Record<string, unknown>, outer = {}) {
  return {
    request: new Request(
      "http://workflow-builder/api/internal/preview-development/environment",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-preview-action-token": "preview-purpose-token",
        },
        body: JSON.stringify({
          parentExecutionId: "parent-execution-1",
          command,
          ...outer,
        }),
      },
    ),
  };
}

describe("host preview development environment route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates and dispatches only the narrow launch intent", async () => {
    const response = (await POST(
      event({
        kind: "launch-environment",
        operationId: `pdt-launch-environment-${"e".repeat(64)}`,
        input: {
          environmentName: "feature-one",
          services: ["workflow-builder"],
          ttlHours: 8,
          retainAfterCompletion: false,
        },
      }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requirePreviewActionInternal).toHaveBeenCalledOnce();
    expect(mocks.launchEnvironment).toHaveBeenCalledWith({
      parentExecutionId: "parent-execution-1",
      operationId: `pdt-launch-environment-${"e".repeat(64)}`,
      launch: {
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: 8,
        retainAfterCompletion: false,
      },
    });
  });

  it("rejects the broad internal token before lifecycle dispatch", async () => {
    const request = event({
      kind: "launch-environment",
      operationId: `pdt-launch-environment-${"e".repeat(64)}`,
      input: {
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: 8,
        retainAfterCompletion: false,
      },
    });
    request.request.headers.delete("x-preview-action-token");
    request.request.headers.set("x-internal-token", "broad-internal-token");
    await expect(POST(request as never)).rejects.toThrow(
      "invalid preview action token",
    );
    expect(mocks.launchEnvironment).not.toHaveBeenCalled();
  });

  it("dispatches the exact target and signed ticket for cleanup proof", async () => {
    const response = (await POST(
      event({
        kind: "get-environment-teardown-status",
        operationId: `pdt-get-environment-teardown-status-${"e".repeat(64)}`,
        target: TARGET,
        ticket: TICKET,
      }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.getEnvironmentTeardownStatus).toHaveBeenCalledWith({
      parentExecutionId: "parent-execution-1",
      operationId: `pdt-get-environment-teardown-status-${"e".repeat(64)}`,
      target: TARGET,
      ticket: TICKET,
    });
  });

  it("rejects caller-supplied identity, revisions, origins, URLs, and credentials", async () => {
    const response = (await POST(
      event(
        {
          kind: "launch-environment",
          operationId: `pdt-launch-environment-${"e".repeat(64)}`,
          input: {
            environmentName: "feature-one",
            services: ["workflow-builder"],
            ttlHours: 8,
            retainAfterCompletion: false,
            sourceRevision: "attacker",
            previewOrigin: "https://attacker.example",
            kubeconfig: "secret",
          },
        },
        { userId: "attacker" },
      ) as never,
    )) as Response;

    expect(response.status).toBe(400);
    expect(mocks.launchEnvironment).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid-request",
    });
  });

  it("maps generation conflicts without invoking another command", async () => {
    mocks.getEnvironmentStatus.mockRejectedValueOnce(
      new PreviewDevelopmentEnvironmentError(
        "contract-mismatch",
        "generation changed",
      ),
    );
    const response = (await POST(
      event({
        kind: "get-environment-status",
        operationId: `pdt-get-environment-status-${"e".repeat(64)}`,
        target: TARGET,
      }) as never,
    )) as Response;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "generation changed",
      code: "contract-mismatch",
    });
  });
});
