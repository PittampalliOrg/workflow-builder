import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  freezeDevPreviewSources,
  releaseDevPreviewSandboxes,
  type DevPreviewPersistence,
} from "./dev-preview";
import { resolveDevPreviewDescriptor } from "./dev-preview-registry";

const EXECUTION_ID = "exec-1";
const OPERATION_ID = `teardown-${createHash("sha256")
  .update(EXECUTION_ID)
  .digest("hex")
  .slice(0, 40)}`;
const GENERATION = "retain-generation-1";
const CONTENT_SHA = `sha256:${"a".repeat(64)}`;

type Row = {
  workspaceRef: string;
  sandboxState: Record<string, unknown> | null;
};

function fakePersistence(rows: Row[] = []): DevPreviewPersistence {
  return {
    upsertWorkflowWorkspaceSession: vi.fn(async (input) => ({
      workspaceRef: input.workspaceRef,
    })),
    listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => rows),
    markWorkflowWorkspaceSessionCleaned: vi.fn(async () => true),
    getExecutionById: vi.fn(async () => ({
      id: EXECUTION_ID,
      userId: "user-1",
      projectId: "project-1",
    })),
    listWorkflowArtifactsByExecutionId: vi.fn(async () => []),
    persistSourceBundleArtifact: vi.fn(async () => ({
      id: "artifact-1",
      fileId: "file-1",
      bytes: 12,
    })),
  };
}

function receiverRows(
  services = ["workflow-orchestrator", "function-router"],
): Row[] {
  return services.map((service, index) => {
    const descriptor = resolveDevPreviewDescriptor(service);
    return {
      workspaceRef: `wfb-dev-preview-${service}-${EXECUTION_ID}`,
      sandboxState: {
        details: {
          kind: "dev-preview",
          executionId: EXECUTION_ID,
          sandboxName: `wfb-dev-preview-${service}-${EXECUTION_ID}`,
          service,
          podIP: `10.0.0.${index + 11}`,
          syncPort: descriptor.syncPort,
        },
      },
    };
  });
}

function podFor(rows: Row[], target: string): Row | undefined {
  return rows.find(({ sandboxState }) => {
    const details = (sandboxState?.details ?? {}) as {
      podIP?: string;
      syncPort?: number;
    };
    const url = new URL(target);
    return (
      url.origin === `http://${details.podIP}:${details.syncPort}` &&
      url.pathname === "/__freeze"
    );
  });
}

function freezeProof(
  service: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    prepared: true,
    frozen: false,
    idempotent: false,
    operationId: OPERATION_ID,
    service,
    generation: GENERATION,
    contentSha256: CONTENT_SHA,
    ...overrides,
  };
}

describe("freezeDevPreviewSources (dev/preview-freeze, retain-time)", () => {
  beforeEach(() => {
    vi.stubEnv("PREVIEW_DEV_SYNC_MINT_TOKEN", "");
    vi.stubEnv("WFB_DEV_SYNC_TOKEN", "1".repeat(64));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("freezes every requested receiver via prepare+commit and reports per-service outcomes", async () => {
    const rows = receiverRows();
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        const row = podFor(rows, target);
        if (!row) throw new Error(`unexpected request ${target}`);
        const service = String(
          (row.sandboxState!.details as Record<string, unknown>).service,
        );
        const phase = new URL(target).searchParams.get("phase");
        const operationId = new URL(target).searchParams.get("operationId");
        expect(init?.method).toBe("POST");
        expect(operationId).toBe(OPERATION_ID);
        events.push(`${phase}:${service}`);
        return Response.json(
          phase === "prepare"
            ? freezeProof(service)
            : freezeProof(service, { prepared: false, frozen: true }),
        );
      }),
    );

    const result = await freezeDevPreviewSources(
      {
        executionId: EXECUTION_ID,
        services: ["workflow-orchestrator", "function-router"],
      },
      fakePersistence(rows),
    );

    expect(result.ok).toBe(true);
    expect(result.executionId).toBe(EXECUTION_ID);
    expect(result.services).toEqual([
      {
        service: "function-router",
        status: "frozen",
        message: "source receiver is frozen",
      },
      {
        service: "workflow-orchestrator",
        status: "frozen",
        message: "source receiver is frozen",
      },
    ]);
    expect(events.sort()).toEqual([
      "commit:function-router",
      "commit:workflow-orchestrator",
      "prepare:function-router",
      "prepare:workflow-orchestrator",
    ]);
  });

  it("derives the service set from persisted dev-preview sessions when none is requested", async () => {
    const rows = receiverRows(["workflow-orchestrator"]);
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const target = String(url);
        const phase = new URL(target).searchParams.get("phase");
        events.push(`${phase}`);
        return Response.json(
          phase === "prepare"
            ? freezeProof("workflow-orchestrator")
            : freezeProof("workflow-orchestrator", {
                prepared: false,
                frozen: true,
              }),
        );
      }),
    );

    const result = await freezeDevPreviewSources(
      { executionId: EXECUTION_ID },
      fakePersistence(rows),
    );

    expect(result.ok).toBe(true);
    expect(result.services).toEqual([
      {
        service: "workflow-orchestrator",
        status: "frozen",
        message: "source receiver is frozen",
      },
    ]);
    expect(events).toEqual(["prepare", "commit"]);
  });

  it("is idempotent: an already-frozen receiver reports frozen without a commit", async () => {
    const rows = receiverRows(["workflow-orchestrator"]);
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const phase = new URL(String(url)).searchParams.get("phase");
        events.push(String(phase));
        if (phase !== "prepare") {
          throw new Error("commit must not run for an already-frozen receiver");
        }
        return Response.json(
          freezeProof("workflow-orchestrator", {
            prepared: false,
            frozen: true,
            idempotent: true,
          }),
        );
      }),
    );

    const result = await freezeDevPreviewSources(
      { executionId: EXECUTION_ID, services: ["workflow-orchestrator"] },
      fakePersistence(rows),
    );

    expect(result.ok).toBe(true);
    expect(result.services).toEqual([
      {
        service: "workflow-orchestrator",
        status: "frozen",
        message: "source receiver was already frozen",
      },
    ]);
    expect(events).toEqual(["prepare"]);
  });

  it("treats a receiver frozen by another operation as frozen", async () => {
    const rows = receiverRows(["workflow-orchestrator"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ok: false, error: "receiver frozen by another operation" },
          { status: 409 },
        ),
      ),
    );

    const result = await freezeDevPreviewSources(
      { executionId: EXECUTION_ID, services: ["workflow-orchestrator"] },
      fakePersistence(rows),
    );

    expect(result.ok).toBe(true);
    expect(result.services).toEqual([
      {
        service: "workflow-orchestrator",
        status: "frozen",
        message: "source receiver was already frozen",
      },
    ]);
  });

  it("isolates per-service failures: an unreachable receiver fails while its sibling freezes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = receiverRows(["workflow-orchestrator", "function-router"]);
    // function-router row loses its podIP → receiver unavailable.
    (rows[1]!.sandboxState!.details as Record<string, unknown>).podIP = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const phase = new URL(String(url)).searchParams.get("phase");
        return Response.json(
          phase === "prepare"
            ? freezeProof("workflow-orchestrator")
            : freezeProof("workflow-orchestrator", {
                prepared: false,
                frozen: true,
              }),
        );
      }),
    );

    const result = await freezeDevPreviewSources(
      {
        executionId: EXECUTION_ID,
        services: ["workflow-orchestrator", "function-router"],
      },
      fakePersistence(rows),
    );

    expect(result.ok).toBe(false);
    expect(result.services).toEqual([
      {
        service: "function-router",
        status: "failed",
        message: "dev-preview receiver is unavailable for function-router",
      },
      {
        service: "workflow-orchestrator",
        status: "frozen",
        message: "source receiver is frozen",
      },
    ]);
  });

  it("aborts the reversible preparation when the one-way commit cannot be proven", async () => {
    const rows = receiverRows(["workflow-orchestrator"]);
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const phase = new URL(String(url)).searchParams.get("phase");
        events.push(String(phase));
        if (phase === "prepare") {
          return Response.json(freezeProof("workflow-orchestrator"));
        }
        if (phase === "abort") {
          return Response.json({
            ok: true,
            prepared: false,
            frozen: false,
            idempotent: false,
            operationId: OPERATION_ID,
          });
        }
        return Response.json(
          { ok: false, error: "freeze state write: disk full" },
          { status: 500 },
        );
      }),
    );

    const result = await freezeDevPreviewSources(
      { executionId: EXECUTION_ID, services: ["workflow-orchestrator"] },
      fakePersistence(rows),
    );

    expect(result.ok).toBe(false);
    expect(result.services[0]).toMatchObject({
      service: "workflow-orchestrator",
      status: "failed",
    });
    expect(events[0]).toBe("prepare");
    expect(events).toContain("abort");
  });

  it("fails closed without persistence", async () => {
    await expect(
      freezeDevPreviewSources({ executionId: EXECUTION_ID }),
    ).rejects.toThrow("dev-preview source freeze is unavailable");
  });
});

describe("releaseDevPreviewSandboxes (retained dev-preview lease release)", () => {
  beforeEach(() => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubEnv("SANDBOX_EXECUTION_API_TOKEN", "sandbox-internal-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function inventoryBody(services: string[]) {
    return {
      executionId: EXECUTION_ID,
      complete: true,
      services: services.map((service) => ({
        service,
        sandboxName: `wfb-dev-preview-${service}-${EXECUTION_ID}`,
      })),
    };
  }

  it("releases every dev-preview sandbox for the execution behind the teardown fence", async () => {
    const rows = receiverRows(["workflow-orchestrator", "function-router"]);
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.startsWith("http://sandbox-api/internal/dev-previews?")) {
          events.push("inventory");
          return Response.json(
            inventoryBody(["workflow-orchestrator", "function-router"]),
          );
        }
        if (target.endsWith("/internal/dev-previews/teardown-intent")) {
          events.push("intent");
          expect(init?.method).toBe("POST");
          return Response.json({ accepted: true, executionId: EXECUTION_ID });
        }
        if (target.endsWith("/internal/dev-preview/restore-orphans")) {
          events.push("restore-orphans");
          return Response.json({ restored: [], releasedLeases: [] });
        }
        if (init?.method === "DELETE") {
          const sandboxName = decodeURIComponent(
            new URL(target).pathname.split("/").at(-1) ?? "",
          );
          events.push(`delete:${sandboxName}`);
          expect(init.headers).toEqual({
            Authorization: "Bearer sandbox-internal-token",
          });
          return Response.json({
            sandboxName,
            accepted: true,
            deleted: true,
            deferred: false,
          });
        }
        throw new Error(`unexpected request ${target}`);
      }),
    );
    const persistence = fakePersistence(rows);

    const result = await releaseDevPreviewSandboxes(
      { executionId: EXECUTION_ID },
      persistence,
    );

    expect(result).toEqual({
      ok: true,
      complete: true,
      pending: false,
      found: true,
      executionId: EXECUTION_ID,
      sandboxes: [
        {
          sandboxName: `wfb-dev-preview-workflow-orchestrator-${EXECUTION_ID}`,
          service: "workflow-orchestrator",
          status: "released",
          message: null,
        },
        {
          sandboxName: `wfb-dev-preview-function-router-${EXECUTION_ID}`,
          service: "function-router",
          status: "released",
          message: null,
        },
      ],
    });
    // The fence lands after the existence probe and before any DELETE.
    expect(events.indexOf("intent")).toBeGreaterThan(-1);
    for (const event of events.filter((entry) => entry.startsWith("delete:"))) {
      expect(events.indexOf(event)).toBeGreaterThan(events.indexOf("intent"));
    }
    expect(events).toContain("restore-orphans");
    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).toHaveBeenCalledTimes(2);
  });

  it("reports found=false for an execution without dev previews and never plants the fence", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.startsWith("http://sandbox-api/internal/dev-previews?")) {
        return Response.json(inventoryBody([]));
      }
      throw new Error(`unexpected request ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await releaseDevPreviewSandboxes(
      { executionId: EXECUTION_ID },
      fakePersistence([]),
    );

    expect(result).toEqual({
      ok: true,
      complete: false,
      pending: false,
      found: false,
      executionId: EXECUTION_ID,
      sandboxes: [],
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/internal/dev-previews/teardown-intent"),
      ),
    ).toBe(false);
  });

  it("surfaces a deferred response-path restore as pending and skips the orphan sweep", async () => {
    const rows = receiverRows(["workflow-builder"]);
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.startsWith("http://sandbox-api/internal/dev-previews?")) {
          return Response.json(inventoryBody(["workflow-builder"]));
        }
        if (target.endsWith("/internal/dev-previews/teardown-intent")) {
          return Response.json({ accepted: true, executionId: EXECUTION_ID });
        }
        if (target.endsWith("/internal/dev-preview/restore-orphans")) {
          events.push("restore-orphans");
          return Response.json({ restored: [], releasedLeases: [] });
        }
        if (init?.method === "DELETE") {
          const sandboxName = decodeURIComponent(
            new URL(target).pathname.split("/").at(-1) ?? "",
          );
          return Response.json(
            { sandboxName, accepted: true, deleted: false, deferred: true },
            { status: 202 },
          );
        }
        throw new Error(`unexpected request ${target}`);
      }),
    );

    const result = await releaseDevPreviewSandboxes(
      { executionId: EXECUTION_ID },
      fakePersistence(rows),
    );

    expect(result.ok).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.sandboxes).toEqual([
      {
        sandboxName: `wfb-dev-preview-workflow-builder-${EXECUTION_ID}`,
        service: "workflow-builder",
        status: "deferred",
        message: "prod restore is deferred to the response path",
      },
    ]);
    expect(events).not.toContain("restore-orphans");
  });

  it("narrows to one service without fencing the rest of the batch", async () => {
    const rows = receiverRows(["workflow-orchestrator", "function-router"]);
    const deletes: string[] = [];
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.startsWith("http://sandbox-api/internal/dev-previews?")) {
          return Response.json(
            inventoryBody(["workflow-orchestrator", "function-router"]),
          );
        }
        if (init?.method === "DELETE") {
          const sandboxName = decodeURIComponent(
            new URL(target).pathname.split("/").at(-1) ?? "",
          );
          deletes.push(sandboxName);
          return Response.json({
            sandboxName,
            accepted: true,
            deleted: true,
            deferred: false,
          });
        }
        throw new Error(`unexpected request ${target}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await releaseDevPreviewSandboxes(
      { executionId: EXECUTION_ID, service: "workflow-orchestrator" },
      fakePersistence(rows),
    );

    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(deletes).toEqual([
      `wfb-dev-preview-workflow-orchestrator-${EXECUTION_ID}`,
    ]);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/internal/dev-previews/teardown-intent"),
      ),
    ).toBe(false);
  });

  it("reports a rejected restore as failed without the orphan sweep", async () => {
    const rows = receiverRows(["workflow-orchestrator"]);
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.startsWith("http://sandbox-api/internal/dev-previews?")) {
          return Response.json(inventoryBody(["workflow-orchestrator"]));
        }
        if (target.endsWith("/internal/dev-previews/teardown-intent")) {
          return Response.json({ accepted: true, executionId: EXECUTION_ID });
        }
        if (target.endsWith("/internal/dev-preview/restore-orphans")) {
          events.push("restore-orphans");
          return Response.json({ restored: [], releasedLeases: [] });
        }
        if (init?.method === "DELETE") {
          return Response.json(
            { accepted: false, detail: "lease is held by another owner" },
            { status: 409 },
          );
        }
        throw new Error(`unexpected request ${target}`);
      }),
    );
    const persistence = fakePersistence(rows);

    const result = await releaseDevPreviewSandboxes(
      { executionId: EXECUTION_ID },
      persistence,
    );

    expect(result.ok).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.sandboxes).toEqual([
      {
        sandboxName: `wfb-dev-preview-workflow-orchestrator-${EXECUTION_ID}`,
        service: "workflow-orchestrator",
        status: "failed",
        message: "lease is held by another owner",
      },
    ]);
    expect(events).not.toContain("restore-orphans");
    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).not.toHaveBeenCalled();
  });

  it("fails closed without the privileged sandbox API", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "");
    await expect(
      releaseDevPreviewSandboxes(
        { executionId: EXECUTION_ID },
        fakePersistence([]),
      ),
    ).rejects.toThrow("dev-preview release is unavailable");
  });
});
