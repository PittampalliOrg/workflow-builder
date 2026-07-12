import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableDevPreviewActivationError } from "$lib/server/application/ports/dev-preview-provisioner";
import type { PreviewDatabaseProvisioner } from "$lib/server/application/ports";
import {
  captureAllDevPreviewSources,
  provisionDevPreview,
  provisionDevPreviews,
  replaceDevPreviewImages,
  type DevPreviewPersistence,
} from "./dev-preview";
import {
  devPreviewCaptureMappings,
  DEV_PREVIEW_CATALOG_DIGEST,
  resolveDevPreviewDescriptor,
} from "./dev-preview-registry";

function fakePersistence(
  rows: Array<{
    workspaceRef: string;
    sandboxState: Record<string, unknown> | null;
  }> = [],
): DevPreviewPersistence {
  return {
    upsertWorkflowWorkspaceSession: vi.fn(async (input) => ({
      workspaceRef: input.workspaceRef,
    })),
    listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => rows),
    markWorkflowWorkspaceSessionCleaned: vi.fn(async () => true),
    getExecutionById: vi.fn(async () => ({
      id: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    })),
    persistSourceBundleArtifact: vi.fn(async () => ({
      id: "artifact-1",
      fileId: "file-1",
      bytes: 12,
    })),
  };
}

function fakePreviewDatabases(): PreviewDatabaseProvisioner {
  return {
    provision: vi.fn(async () => ({
      databaseUrl: "postgres://preview-db",
      sourceUrl: "postgres://source-db",
      dbName: "preview_exec1",
    })),
    drop: vi.fn(async () => undefined),
  };
}

type TestFetch = (url: any, init?: RequestInit) => Promise<Response>;

function stubDevPreviewFetch(fetchImpl: TestFetch): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (
        String(url).startsWith(
          "http://sandbox-api/internal/dev-previews/teardown-intent?executionId=",
        )
      ) {
        return Response.json({
          executionId: new URL(String(url)).searchParams.get("executionId"),
          teardownIntent: false,
        });
      }
      return fetchImpl(url, init);
    }),
  );
}

function teardownRequestIdentity(target: string): {
  sandboxName: string;
  executionId: string | null;
  service: string | null;
} {
  const url = new URL(target);
  return {
    sandboxName: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
    executionId: url.searchParams.get("executionId"),
    service: url.searchParams.get("service"),
  };
}

describe("dev-preview portability boundary", () => {
  beforeEach(() => {
    const sha = "a".repeat(40);
    vi.stubEnv(
      "WORKFLOW_BUILDER_DEV_IMAGE",
      `ghcr.io/pittampalliorg/workflow-builder-dev:git-${sha}`,
    );
    vi.stubEnv(
      "WORKFLOW_ORCHESTRATOR_DEV_IMAGE",
      `ghcr.io/pittampalliorg/workflow-orchestrator-dev:git-${sha}`,
    );
    vi.stubEnv(
      "FUNCTION_ROUTER_DEV_IMAGE",
      `ghcr.io/pittampalliorg/function-router-dev:git-${sha}`,
    );
    vi.stubEnv("PREVIEW_DEV_SYNC_MINT_TOKEN", "");
    vi.stubEnv("WFB_DEV_SYNC_TOKEN", "1".repeat(64));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps dev-preview persistence behind an injected port", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "dev-preview.ts"),
      "utf8",
    );

    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("$lib/server/db/schema");
    expect(source).not.toContain("drizzle-orm");
    expect(source).not.toContain('from "postgres"');
    expect(source).not.toContain("workflows/preview-database");
    expect(source).not.toContain("$lib/server/files/registry");
    expect(source).not.toContain("persistSourceBundle(");
  });

  it("persists provisioned preview sessions through the injected port", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            sandboxName: "wfb-dev-preview-function-router-exec-1",
            podIP: "10.0.0.12",
            port: 8080,
            syncPort: 8001,
            url: "http://10.0.0.12:8080",
            syncUrl: "http://10.0.0.12:8001/__sync",
            ready: true,
            status: "running",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    stubDevPreviewFetch(fetchMock);
    const persistence = fakePersistence();

    const info = await provisionDevPreview(
      {
        executionId: "exec-1",
        service: "function-router",
      },
      persistence,
    );

    expect(info.sandboxName).toBe("wfb-dev-preview-function-router-exec-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sandbox-api/internal/dev-preview",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestBody = JSON.parse(String(request.body));
    expect(requestBody.syncToken).toMatch(/^[a-f0-9]{64}$/);
    expect(requestBody.syncAgentToken).toMatch(/^[a-f0-9]{64}$/);
    expect(requestBody.syncToken).not.toBe(requestBody.syncAgentToken);
    expect(info.syncCapability).toBe(requestBody.syncAgentToken);
    expect(requestBody.devSyncAllowedRoots).toEqual([
      ".preview-capture/development.Dockerfile",
      ".preview-capture/production.Dockerfile",
      "config",
      "package.json",
      "pnpm-lock.yaml",
      "src",
    ]);
    expect(persistence.upsertWorkflowWorkspaceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRef: "wfb-dev-preview-function-router-exec-1",
        workflowExecutionId: "exec-1",
        name: "dev-preview",
        backend: "juicefs",
        status: "active",
      }),
    );
  });

  it("compensates and fails when the injected teardown tombstone cannot persist", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const persistence = fakePersistence();
    vi.mocked(persistence.upsertWorkflowWorkspaceSession).mockRejectedValue(
      new Error("persistence unavailable"),
    );
    const deletes: string[] = [];
    stubDevPreviewFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (init?.method === "DELETE") {
          deletes.push(target);
          return Response.json({
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            accepted: true,
            deleted: true,
            deferred: false,
          });
        }
        return Response.json({
          sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
          podIP: "10.0.0.8",
          syncUrl: "http://10.0.0.8:8001/__sync",
          ready: true,
          status: "running",
        });
      }),
    );

    await expect(
      provisionDevPreview(
        {
          executionId: "exec-1",
          service: "workflow-orchestrator",
          mode: "preview-native",
          adopt: false,
        },
        persistence,
      ),
    ).rejects.toThrow("persistence unavailable");
    expect(deletes).toEqual([
      "http://sandbox-api/internal/dev-preview/wfb-dev-preview-workflow-orchestrator-exec-1?executionId=exec-1&service=workflow-orchestrator",
    ]);
  });

  it("fails closed before provisioning when the server sync token is absent", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubEnv("WFB_DEV_SYNC_TOKEN", "");
    const fetchMock = vi.fn();
    stubDevPreviewFetch(fetchMock);

    await expect(
      provisionDevPreview(
        { executionId: "exec-1", service: "function-router" },
        fakePersistence(),
      ),
    ).rejects.toThrow("Dev-sync credential authority is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forces applyDaprShadowDefaults:false for a preview-native provision", async () => {
    // The workflow-orchestrator descriptor does NOT set applyDaprShadowDefaults,
    // so pre-fix the request omitted it and the SEA default (true) injected
    // PUBSUB_NAME=pubsub-dev into a vcluster whose component is named `pubsub`.
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            podIP: "10.0.0.13",
            port: 8080,
            syncPort: 8001,
            ready: true,
            status: "running",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    stubDevPreviewFetch(fetchMock);

    await provisionDevPreview(
      {
        executionId: "exec-1",
        service: "workflow-orchestrator",
        mode: "preview-native",
      },
      fakePersistence(),
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.previewNative).toBe(true);
    expect(body.applyDaprShadowDefaults).toBe(false);
    expect(body.envFrom).toEqual([
      { configMapRef: { name: "workflow-orchestrator-config" } },
      { configMapRef: { name: "workflow-orchestrator-otel-config" } },
      { configMapRef: { name: "workflow-orchestrator-dapr-config" } },
      {
        secretRef: {
          name: "workflow-orchestrator-secrets",
          optional: true,
        },
      },
    ]);
    // The host-only shadow pubsub name must NOT leak into a preview-native pod.
    expect(body.env?.PUBSUB_NAME).toBeUndefined();
  });

  it("touches the vcluster preview on a preview-native provision with an origin", async () => {
    // A4: a dev pod landing INSIDE a vcluster preview is activity on that preview —
    // the provision pings SEA's touch endpoint (alias derived from the wfb-<name>
    // origin host) so the lifecycle reaper never sleeps a preview mid-session.
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/touch"))
        return new Response(
          JSON.stringify({
            name: "myprev",
            state: "hot",
            resuming: false,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      return new Response(
        JSON.stringify({
          sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
          podIP: "10.0.0.13",
          port: 3000,
          syncPort: 3000,
          syncUrl: "http://10.0.0.5:3000/__sync",
          ready: true,
          status: "running",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    stubDevPreviewFetch(fetchMock);

    await provisionDevPreview(
      {
        executionId: "exec-1",
        service: "workflow-builder",
        mode: "preview-native",
        adopt: false,
        origin: "https://wfb-myprev.tail286401.ts.net",
      },
      fakePersistence(),
    );

    expect(calls).toContain(
      "http://sandbox-api/internal/vcluster-preview/myprev/touch",
    );
  });

  it.each(["workflow-builder", "function-router"])(
    "rejects single-service preview-native adoption of response-path service %s",
    async (service) => {
      vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
      const fetchMock = vi.fn();
      stubDevPreviewFetch(fetchMock);

      await expect(
        provisionDevPreview({
          executionId: "exec-1",
          service,
          mode: "preview-native",
          adopt: true,
        }),
      ).rejects.toThrow("requires provisionMany");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("fails and cleans the persisted row when teardown wins after SEA creation", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const events: string[] = [];
    const persistence = fakePersistence();
    vi.mocked(persistence.upsertWorkflowWorkspaceSession).mockImplementation(
      async (input) => {
        events.push("persist");
        return { workspaceRef: input.workspaceRef };
      },
    );
    vi.mocked(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).mockImplementation(async () => {
      events.push("clean");
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.includes("/teardown-intent?")) {
          events.push("confirm-intent");
          return Response.json({
            executionId: "exec-1",
            teardownIntent: true,
          });
        }
        if (init?.method === "DELETE") {
          expect(teardownRequestIdentity(target)).toEqual({
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            executionId: "exec-1",
            service: "workflow-orchestrator",
          });
          events.push("delete");
          return Response.json({
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            accepted: true,
            deleted: true,
            deferred: false,
          });
        }
        events.push("create");
        return Response.json({
          sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
          podIP: "10.0.0.8",
          syncUrl: "http://10.0.0.8:8001/__sync",
          ready: true,
          status: "running",
        });
      }),
    );

    await expect(
      provisionDevPreview(
        {
          executionId: "exec-1",
          service: "workflow-orchestrator",
          mode: "preview-native",
          adopt: false,
        },
        persistence,
      ),
    ).rejects.toThrow("teardown is already in progress");
    expect(events).toEqual([
      "create",
      "persist",
      "confirm-intent",
      "delete",
      "clean",
    ]);
  });

  it("preserves the persisted row when unconfirmed provision cleanup is deferred", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const persistence = fakePersistence();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.includes("/teardown-intent?")) {
          return Response.json({
            executionId: "exec-1",
            teardownIntent: true,
          });
        }
        if (init?.method === "DELETE") {
          expect(teardownRequestIdentity(target)).toEqual({
            sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
            executionId: "exec-1",
            service: "workflow-builder",
          });
          return Response.json(
            {
              sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
              accepted: true,
              deleted: false,
              deferred: true,
            },
            { status: 202 },
          );
        }
        return Response.json({
          sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
          podIP: "10.0.0.8",
          syncUrl: "http://10.0.0.8:3000/__sync",
          ready: true,
          status: "running",
        });
      }),
    );

    await expect(
      provisionDevPreview(
        {
          executionId: "exec-1",
          service: "workflow-builder",
          mode: "preview-native",
          adopt: false,
        },
        persistence,
      ),
    ).rejects.toThrow("teardown is already in progress");
    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", () => Response.json({ detail: "down" }, { status: 503 })],
    ["malformed", () => Response.json({ executionId: "exec-1" })],
  ])(
    "fails closed and cleans an unconfirmed provision when intent status is %s",
    async (_case, intentResponse) => {
      vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
      const persistence = fakePersistence();
      let deleted = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          const target = String(url);
          if (target.includes("/teardown-intent?")) return intentResponse();
          if (init?.method === "DELETE") {
            expect(teardownRequestIdentity(target)).toEqual({
              sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
              executionId: "exec-1",
              service: "workflow-orchestrator",
            });
            deleted = true;
            return Response.json({
              sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
              accepted: true,
              deleted: true,
              deferred: false,
            });
          }
          return Response.json({
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            podIP: "10.0.0.8",
            syncUrl: "http://10.0.0.8:8001/__sync",
            ready: true,
            status: "running",
          });
        }),
      );

      await expect(
        provisionDevPreview(
          {
            executionId: "exec-1",
            service: "workflow-orchestrator",
            mode: "preview-native",
            adopt: false,
          },
          persistence,
        ),
      ).rejects.toThrow("intent confirmation was not proven");
      expect(deleted).toBe(true);
      expect(
        persistence.markWorkflowWorkspaceSessionCleaned,
      ).toHaveBeenCalledWith({
        workspaceRef: "wfb-dev-preview-workflow-orchestrator-exec-1",
      });
    },
  );

  it("does not touch on a host-throwaway provision or without an origin", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
          ready: true,
          status: "running",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    stubDevPreviewFetch(fetchMock);

    // preview-native but NO origin -> no alias to touch.
    await provisionDevPreview(
      {
        executionId: "exec-1",
        service: "workflow-orchestrator",
        mode: "preview-native",
      },
      fakePersistence(),
    );
    expect(calls.some((u) => u.endsWith("/touch"))).toBe(false);
  });

  it("omits applyDaprShadowDefaults for a shadow-default host provision", async () => {
    // A host-throwaway orchestrator preview keeps the SEA default (the shadow env
    // IS the host-isolation mechanism there), so the BFF sends no override.
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            ready: true,
            status: "running",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    stubDevPreviewFetch(fetchMock);

    await provisionDevPreview(
      { executionId: "exec-1", service: "workflow-orchestrator" },
      fakePersistence(),
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.previewNative).toBeUndefined();
    expect(body.envFrom).toBeUndefined();
    expect("applyDaprShadowDefaults" in body).toBe(false);
  });

  it("skips both response-path stages when an ordinary peer fails readiness", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const started: string[] = [];
    const fetchMock = vi.fn(async (url, init) => {
      const target = String(url);
      if (target.includes("/internal/dev-previews?")) {
        return Response.json({
          executionId: "exec-1",
          complete: true,
          services: [],
        });
      }
      if (target.endsWith("/internal/dev-previews/activate")) {
        throw new Error("activation must not run after a peer failure");
      }
      const body = JSON.parse(String((init as RequestInit).body));
      started.push(body.service);
      expect(body.stageAdoption).toBe(true);
      if (body.service === "workflow-orchestrator") {
        return Response.json({ detail: "boom" }, { status: 503 });
      }
      throw new Error(`unexpected provision for ${body.service}`);
    });
    stubDevPreviewFetch(fetchMock);
    const persistence = fakePersistence();

    const result = await provisionDevPreviews(
      {
        executionId: "exec-1",
        services: [
          "workflow-builder",
          "function-router",
          "workflow-orchestrator",
        ],
        mode: "preview-native",
      },
      persistence,
    );

    expect(result.ok).toBe(false);
    const bySvc = Object.fromEntries(
      result.services.map((s) => [s.service, s]),
    );
    expect(bySvc["workflow-builder"]).toMatchObject({
      ok: false,
      error: expect.stringContaining("cutover skipped"),
    });
    expect(bySvc["function-router"]).toMatchObject({
      ok: false,
      error: expect.stringContaining("cutover skipped"),
    });
    expect(bySvc["workflow-orchestrator"]).toMatchObject({
      ok: false,
      error: expect.stringContaining("boom"),
    });
    expect(started).toEqual(["workflow-orchestrator"]);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/internal/dev-previews/activate"),
      ),
    ).toBe(false);
    expect(persistence.upsertWorkflowWorkspaceSession).not.toHaveBeenCalled();
    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).not.toHaveBeenCalled();
  });

  it("treats fulfilled but non-ready services as failed system members", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    let live = true;
    stubDevPreviewFetch(
      vi.fn(async (url, init) => {
        const target = String(url);
        if (target.includes("/internal/dev-previews?")) {
          return Response.json({
            executionId: "exec-1",
            complete: true,
            services: live
              ? [
                  {
                    service: "workflow-orchestrator",
                    sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
                  },
                ]
              : [],
          });
        }
        if (target.endsWith("/internal/dev-preview/restore-orphans")) {
          return Response.json({ restored: [], releasedLeases: [] });
        }
        if (init?.method === "DELETE") {
          expect(teardownRequestIdentity(target)).toEqual({
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            executionId: "exec-1",
            service: "workflow-orchestrator",
          });
          live = false;
          return Response.json({
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            accepted: true,
            deleted: true,
            deferred: false,
          });
        }
        return Response.json(
          {
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            ready: false,
            status: "queued",
            podIP: null,
            syncUrl: null,
          },
          { status: 202 },
        );
      }),
    );

    const result = await provisionDevPreviews(
      {
        executionId: "exec-1",
        services: ["workflow-orchestrator"],
        mode: "preview-native",
        adopt: false,
      },
      fakePersistence(),
    );

    expect(result).toMatchObject({
      ok: false,
      services: [
        {
          service: "workflow-orchestrator",
          ok: false,
          error:
            "multi-service provision failed; compensating teardown completed",
          info: { ready: false, syncUrl: null },
        },
      ],
    });
    expect(live).toBe(false);
  });

  it("stages every service before one exact batch activation and performs no later I/O", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const started: string[] = [];
    const events: string[] = [];
    const activationBodies: Array<Record<string, unknown>> = [];
    let finishPeer: ((response: Response) => void) | undefined;
    const persistence = fakePersistence();
    vi.mocked(persistence.upsertWorkflowWorkspaceSession).mockImplementation(
      async (input) => {
        const details = input.sandboxState?.details as
          | Record<string, unknown>
          | undefined;
        events.push(`persist:${String(details?.service)}`);
        return { workspaceRef: input.workspaceRef };
      },
    );
    const fetchMock = vi.fn(async (url, init) => {
      const target = String(url);
      const body = JSON.parse(String((init as RequestInit).body));
      if (target.endsWith("/internal/dev-previews/activate")) {
        activationBodies.push(body);
        events.push("activate");
        return Response.json(
          {
            accepted: true,
            complete: false,
            pending: true,
            activated: false,
            activationPhase: "scheduled",
            batchId: "batch-exec-1",
            executionId: body.executionId,
            sandboxNames: body.sandboxNames,
          },
          { status: 202 },
        );
      }
      started.push(body.service);
      events.push(`stage:${body.service}`);
      expect(body.stageAdoption).toBe(true);
      if (body.service === "workflow-orchestrator") {
        return new Promise<Response>((resolve) => {
          finishPeer = resolve;
        });
      }
      return Response.json({
        sandboxName: `wfb-dev-preview-${body.service}-exec-1`,
        staged: true,
        podIP: "10.0.0.9",
        syncUrl: "http://10.0.0.9:3000/__sync",
        ready: true,
        status: "running",
      });
    });
    stubDevPreviewFetch(fetchMock);

    const pending = provisionDevPreviews(
      {
        executionId: "exec-1",
        services: [
          "workflow-builder",
          "function-router",
          "workflow-orchestrator",
        ],
        mode: "preview-native",
        adopt: true,
      },
      persistence,
    );
    await vi.waitFor(() => expect(started).toEqual(["workflow-orchestrator"]));
    expect(activationBodies).toHaveLength(0);
    finishPeer?.(
      Response.json({
        sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
        staged: true,
        podIP: "10.0.0.8",
        syncUrl: "http://10.0.0.8:8001/__sync",
        ready: true,
        status: "running",
      }),
    );
    await expect(pending).resolves.toMatchObject({
      ok: true,
      complete: false,
      pending: true,
      activationPhase: "scheduled",
      batchId: "batch-exec-1",
    });
    expect(started[0]).toBe("workflow-orchestrator");
    expect(started.slice(1).sort()).toEqual([
      "function-router",
      "workflow-builder",
    ]);
    expect(activationBodies).toEqual([
      {
        executionId: "exec-1",
        sandboxNames: [
          "wfb-dev-preview-function-router-exec-1",
          "wfb-dev-preview-workflow-builder-exec-1",
          "wfb-dev-preview-workflow-orchestrator-exec-1",
        ],
      },
    ]);
    expect(events.at(-1)).toBe("activate");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      "http://sandbox-api/internal/dev-previews/activate",
    );
  });

  it("resumes a pending five-service activation from persistence without reprovision or compensation", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubEnv(
      "MCP_GATEWAY_DEV_IMAGE",
      `ghcr.io/pittampalliorg/mcp-gateway-dev:git-${"a".repeat(40)}`,
    );
    vi.stubEnv(
      "WORKFLOW_MCP_SERVER_DEV_IMAGE",
      `ghcr.io/pittampalliorg/workflow-mcp-server-dev:git-${"a".repeat(40)}`,
    );
    const rows: Array<{
      workspaceRef: string;
      status: string;
      sandboxState: Record<string, unknown> | null;
    }> = [];
    const persistence = fakePersistence(rows);
    vi.mocked(persistence.upsertWorkflowWorkspaceSession).mockImplementation(
      async (input) => {
        const next = {
          workspaceRef: input.workspaceRef,
          status: input.status ?? "active",
          sandboxState: input.sandboxState ?? null,
        };
        const index = rows.findIndex(
          ({ workspaceRef }) => workspaceRef === input.workspaceRef,
        );
        if (index === -1) rows.push(next);
        else rows[index] = next;
        return { workspaceRef: input.workspaceRef };
      },
    );
    const stageCalls: string[] = [];
    const activationBodies: Array<Record<string, unknown>> = [];
    const deletes: string[] = [];
    const fetchMock = vi.fn(async (url, init) => {
      const target = String(url);
      if (init?.method === "DELETE") {
        deletes.push(target);
        throw new Error("pending replay must not compensate");
      }
      const body = JSON.parse(String((init as RequestInit).body));
      if (target.endsWith("/internal/dev-previews/activate")) {
        activationBodies.push(body);
        const activationPhase =
          activationBodies.length === 1 ? "scheduled" : "activating";
        return Response.json(
          {
            accepted: true,
            complete: false,
            pending: true,
            activated: false,
            activationPhase,
            batchId: "batch-exec-1",
            executionId: body.executionId,
            sandboxNames: body.sandboxNames,
          },
          { status: 202 },
        );
      }
      if (!target.endsWith("/internal/dev-preview")) {
        throw new Error(`unexpected request ${target}`);
      }
      const service = String(body.service);
      if (stageCalls.includes(service)) {
        throw new Error(`reprovisioned ${service}`);
      }
      stageCalls.push(service);
      const descriptor = resolveDevPreviewDescriptor(service);
      const podIP = `10.0.0.${stageCalls.length + 10}`;
      return Response.json({
        sandboxName: `wfb-dev-preview-${service}-exec-1`,
        executionId: "exec-1",
        service,
        staged: true,
        podIP,
        port: descriptor.port,
        syncPort: descriptor.syncPort,
        url: `http://${podIP}:${descriptor.port}`,
        syncUrl: `http://${podIP}:${descriptor.syncPort}/__sync`,
        ready: true,
        status: "running",
        needsDapr: body.needsDapr === true,
        daprAppId: typeof body.daprAppId === "string" ? body.daprAppId : null,
      });
    });
    stubDevPreviewFetch(fetchMock);
    const input = {
      executionId: "exec-1",
      services: [
        "workflow-builder",
        "workflow-orchestrator",
        "function-router",
        "mcp-gateway",
        "workflow-mcp-server",
      ],
      mode: "preview-native" as const,
      adopt: true,
      origin: "https://wfb-preview.tailnet.example",
    };

    await expect(
      provisionDevPreviews(input, persistence),
    ).resolves.toMatchObject({
      ok: true,
      complete: false,
      pending: true,
      activationPhase: "scheduled",
      batchId: "batch-exec-1",
    });
    const firstCallCount = fetchMock.mock.calls.length;
    await expect(
      provisionDevPreviews(input, persistence),
    ).resolves.toMatchObject({
      ok: true,
      complete: false,
      pending: true,
      activationPhase: "activating",
      batchId: "batch-exec-1",
      services: input.services.map((service) => ({ service, ok: true })),
    });

    expect(stageCalls).toHaveLength(5);
    expect(new Set(stageCalls)).toEqual(new Set(input.services));
    expect(activationBodies).toHaveLength(2);
    expect(activationBodies[1]).toEqual(activationBodies[0]);
    expect(deletes).toEqual([]);
    expect(persistence.upsertWorkflowWorkspaceSession).toHaveBeenCalledTimes(5);
    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.slice(firstCallCount).map(([url]) => String(url)),
    ).toEqual(["http://sandbox-api/internal/dev-previews/activate"]);
  });

  it("terminally fails and compensates a contradictory persisted batch", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const rows: Array<{
      workspaceRef: string;
      status: string;
      sandboxState: Record<string, unknown> | null;
    }> = [];
    const persistence = fakePersistence(rows);
    vi.mocked(persistence.upsertWorkflowWorkspaceSession).mockImplementation(
      async (input) => {
        rows.push({
          workspaceRef: input.workspaceRef,
          status: input.status ?? "active",
          sandboxState: input.sandboxState ?? null,
        });
        return { workspaceRef: input.workspaceRef };
      },
    );
    const sandboxName = "wfb-dev-preview-workflow-orchestrator-exec-1";
    let live = true;
    let stageCalls = 0;
    let activationCalls = 0;
    let deleteCalls = 0;
    stubDevPreviewFetch(
      vi.fn(async (url, init) => {
        const target = String(url);
        if (target.includes("/internal/dev-previews?")) {
          return Response.json({
            executionId: "exec-1",
            complete: true,
            services: live
              ? [{ service: "workflow-orchestrator", sandboxName }]
              : [],
          });
        }
        if (target.endsWith("/internal/dev-preview/restore-orphans")) {
          return Response.json({ restored: [], releasedLeases: [] });
        }
        if (init?.method === "DELETE") {
          deleteCalls += 1;
          live = false;
          return Response.json({
            sandboxName,
            accepted: true,
            deleted: true,
            deferred: false,
          });
        }
        const body = JSON.parse(String((init as RequestInit).body));
        if (target.endsWith("/internal/dev-previews/activate")) {
          activationCalls += 1;
          return Response.json(
            {
              accepted: true,
              complete: false,
              pending: true,
              activated: false,
              activationPhase: "scheduled",
              batchId: "batch-exec-1",
              executionId: body.executionId,
              sandboxNames: body.sandboxNames,
            },
            { status: 202 },
          );
        }
        stageCalls += 1;
        const descriptor = resolveDevPreviewDescriptor("workflow-orchestrator");
        return Response.json({
          sandboxName,
          executionId: "exec-1",
          service: "workflow-orchestrator",
          staged: true,
          podIP: "10.0.0.12",
          port: descriptor.port,
          syncPort: descriptor.syncPort,
          url: `http://10.0.0.12:${descriptor.port}`,
          syncUrl: `http://10.0.0.12:${descriptor.syncPort}/__sync`,
          ready: true,
          status: "running",
          needsDapr: body.needsDapr === true,
          daprAppId: typeof body.daprAppId === "string" ? body.daprAppId : null,
        });
      }),
    );
    const input = {
      executionId: "exec-1",
      services: ["workflow-orchestrator"],
      mode: "preview-native" as const,
      adopt: true,
    };

    await expect(
      provisionDevPreviews(input, persistence),
    ).resolves.toMatchObject({
      ok: true,
      complete: false,
      pending: true,
      activationPhase: "scheduled",
    });
    const state = rows[0]?.sandboxState;
    const details = state?.details;
    expect(details).toBeTypeOf("object");
    (details as Record<string, unknown>).image =
      `ghcr.io/pittampalliorg/not-workflow-orchestrator:git-${"b".repeat(40)}`;

    await expect(
      provisionDevPreviews(input, persistence),
    ).resolves.toMatchObject({
      ok: false,
      complete: false,
      pending: false,
      activationPhase: "failed",
      services: [
        {
          service: "workflow-orchestrator",
          ok: false,
          error: expect.stringContaining("persisted batch activation rejected"),
        },
      ],
    });
    expect(stageCalls).toBe(1);
    expect(activationCalls).toBe(1);
    expect(deleteCalls).toBe(1);
    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).toHaveBeenCalledWith({ workspaceRef: sandboxName });
  });

  it("reports terminal activation only after an idempotent call observes the active batch", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    let activationCalls = 0;
    const fetchMock = vi.fn(async (url, init) => {
      const target = String(url);
      const body = JSON.parse(String((init as RequestInit).body));
      if (target.endsWith("/internal/dev-previews/activate")) {
        activationCalls += 1;
        const active = activationCalls === 2;
        return Response.json(
          {
            accepted: true,
            complete: active,
            pending: !active,
            activated: active,
            activationPhase: active ? "active" : "activating",
            batchId: "batch-exec-1",
            executionId: body.executionId,
            sandboxNames: body.sandboxNames,
          },
          { status: active ? 200 : 202 },
        );
      }
      return Response.json({
        sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
        staged: true,
        podIP: "10.0.0.9",
        syncUrl: "http://10.0.0.9:3000/__sync",
        ready: true,
        status: "running",
      });
    });
    stubDevPreviewFetch(fetchMock);
    const input = {
      executionId: "exec-1",
      services: ["workflow-builder"],
      mode: "preview-native" as const,
      adopt: true,
    };
    const persistence = fakePersistence();

    await expect(
      provisionDevPreviews(input, persistence),
    ).resolves.toMatchObject({
      ok: true,
      complete: false,
      pending: true,
      activationPhase: "activating",
      batchId: "batch-exec-1",
    });
    await expect(
      provisionDevPreviews(input, persistence),
    ).resolves.toMatchObject({
      ok: true,
      complete: true,
      pending: false,
      activationPhase: "active",
      batchId: "batch-exec-1",
    });
    expect(activationCalls).toBe(2);
  });

  it.each([
    [
      "lost response",
      async () => {
        throw new Error("connection reset after activation commit");
      },
      "batch activation response was not observed",
    ],
    [
      "HTTP 503",
      async () =>
        Response.json(
          { detail: "activation worker unavailable" },
          { status: 503 },
        ),
      "activation worker unavailable",
    ],
    [
      "malformed HTTP 202",
      async () => Response.json({ accepted: true }, { status: 202 }),
      "batch activation was not accepted",
    ],
  ])(
    "preserves a stable batch after an uncertain activation %s",
    async (_case, uncertainResponse, expectedError) => {
      vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
      const activationBodies: Array<Record<string, unknown>> = [];
      const deletes: string[] = [];
      let activationCalls = 0;
      stubDevPreviewFetch(
        vi.fn(async (url, init) => {
          const target = String(url);
          if (init?.method === "DELETE") {
            deletes.push(target);
            throw new Error("uncertain activation must not compensate");
          }
          const body = JSON.parse(String((init as RequestInit).body));
          if (target.endsWith("/internal/dev-previews/activate")) {
            activationCalls += 1;
            activationBodies.push(body);
            if (activationCalls === 1) return uncertainResponse();
            return Response.json({
              accepted: true,
              complete: true,
              pending: false,
              activated: true,
              activationPhase: "active",
              batchId: "batch-exec-1",
              executionId: body.executionId,
              sandboxNames: body.sandboxNames,
            });
          }
          return Response.json({
            sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
            staged: true,
            podIP: "10.0.0.9",
            syncUrl: "http://10.0.0.9:3000/__sync",
            ready: true,
            status: "running",
          });
        }),
      );
      const input = {
        executionId: "exec-1",
        services: ["workflow-builder"],
        mode: "preview-native" as const,
        adopt: true,
      };
      const persistence = fakePersistence();

      let uncertainty: unknown;
      try {
        await provisionDevPreviews(input, persistence);
      } catch (cause) {
        uncertainty = cause;
      }
      expect(uncertainty).toBeInstanceOf(RetryableDevPreviewActivationError);
      expect((uncertainty as Error).message).toContain(expectedError);
      expect(deletes).toEqual([]);
      await expect(
        provisionDevPreviews(input, persistence),
      ).resolves.toMatchObject({
        ok: true,
        complete: true,
        pending: false,
        activationPhase: "active",
        batchId: "batch-exec-1",
      });
      expect(activationBodies).toEqual([
        {
          executionId: "exec-1",
          sandboxNames: ["wfb-dev-preview-workflow-builder-exec-1"],
        },
        {
          executionId: "exec-1",
          sandboxNames: ["wfb-dev-preview-workflow-builder-exec-1"],
        },
      ]);
      expect(deletes).toEqual([]);
    },
  );

  it("compensates staged peers when batch activation is not accepted", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const live = new Map<string, string>();
    const events: string[] = [];
    const fetchMock = vi.fn(async (url, init) => {
      const target = String(url);
      if (target.includes("/internal/dev-previews?")) {
        events.push("inventory");
        return Response.json({
          executionId: "exec-1",
          complete: true,
          services: [...live].map(([service, sandboxName]) => ({
            service,
            sandboxName,
          })),
        });
      }
      if (target.endsWith("/internal/dev-preview/restore-orphans")) {
        events.push("restore-orphans");
        return Response.json({ restored: [], releasedLeases: [] });
      }
      if (target.endsWith("/internal/dev-previews/activate")) {
        events.push("activate");
        const request = JSON.parse(String((init as RequestInit).body));
        return Response.json({
          accepted: false,
          complete: false,
          pending: false,
          activated: false,
          activationPhase: "failed",
          batchId: "batch-exec-1",
          executionId: request.executionId,
          sandboxNames: request.sandboxNames,
          detail: "activation denied",
        });
      }
      if (init?.method === "DELETE") {
        const request = teardownRequestIdentity(target);
        const sandboxName = request.sandboxName;
        const service = [...live].find(([, name]) => name === sandboxName)?.[0];
        expect(request).toMatchObject({ executionId: "exec-1", service });
        events.push(`delete:${service}`);
        if (service === "workflow-builder") {
          return Response.json(
            {
              sandboxName,
              accepted: true,
              deleted: false,
              deferred: true,
            },
            { status: 202 },
          );
        }
        if (service) live.delete(service);
        return Response.json({
          sandboxName,
          accepted: true,
          deleted: true,
          deferred: false,
        });
      }
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.stageAdoption).toBe(true);
      const sandboxName = `wfb-dev-preview-${body.service}-exec-1`;
      live.set(body.service, sandboxName);
      events.push(`stage:${body.service}`);
      return Response.json({
        sandboxName,
        staged: true,
        podIP: "10.0.0.9",
        syncUrl: "http://10.0.0.9:3000/__sync",
        ready: true,
        status: "running",
      });
    });
    stubDevPreviewFetch(fetchMock);
    const persistence = fakePersistence();

    const result = await provisionDevPreviews(
      {
        executionId: "exec-1",
        services: ["workflow-builder", "workflow-orchestrator"],
        mode: "preview-native",
        adopt: true,
      },
      persistence,
    );

    expect(result.ok).toBe(false);
    expect(result.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: "workflow-orchestrator",
          error: expect.stringContaining(
            "batch activation failed: activation denied; compensating teardown completed",
          ),
        }),
        expect.objectContaining({
          service: "workflow-builder",
          error: expect.stringContaining(
            "batch activation failed: activation denied; compensating teardown accepted",
          ),
        }),
      ]),
    );
    expect(events).toEqual([
      "stage:workflow-orchestrator",
      "stage:workflow-builder",
      "activate",
      "inventory",
      "delete:workflow-orchestrator",
      "restore-orphans",
      "inventory",
      "delete:workflow-builder",
    ]);
    expect(events.at(-1)).toBe("delete:workflow-builder");
    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).toHaveBeenCalledOnce();
    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).toHaveBeenCalledWith({
      workspaceRef: "wfb-dev-preview-workflow-orchestrator-exec-1",
    });
  });

  it("does not tear down the response path when ordinary compensation is unproven", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const live = new Map<string, string>();
    const deletes: string[] = [];
    const fetchMock = vi.fn(async (url, init) => {
      const target = String(url);
      if (target.includes("/teardown-intent?")) {
        return Response.json({ executionId: "exec-1", teardownIntent: false });
      }
      if (target.includes("/internal/dev-previews?")) {
        return Response.json({
          executionId: "exec-1",
          complete: true,
          services: [...live].map(([service, sandboxName]) => ({
            service,
            sandboxName,
          })),
        });
      }
      if (target.endsWith("/internal/dev-preview/restore-orphans")) {
        return Response.json({ restored: [], releasedLeases: [] });
      }
      if (target.endsWith("/internal/dev-previews/activate")) {
        return Response.json({
          accepted: false,
          complete: false,
          pending: false,
          activated: false,
          activationPhase: "failed",
          batchId: "batch-exec-1",
          executionId: "exec-1",
          sandboxNames: [...live.values()].sort(),
          detail: "activation denied",
        });
      }
      if (init?.method === "DELETE") {
        const request = teardownRequestIdentity(target);
        const name = request.sandboxName;
        const service = [...live].find(([, value]) => value === name)?.[0];
        expect(request).toMatchObject({ executionId: "exec-1", service });
        deletes.push(name);
        return Response.json({ detail: "restore failed" }, { status: 409 });
      }
      const body = JSON.parse(String((init as RequestInit).body));
      const sandboxName = `wfb-dev-preview-${body.service}-exec-1`;
      live.set(body.service, sandboxName);
      return Response.json({
        sandboxName,
        staged: true,
        podIP: "10.0.0.9",
        syncUrl: "http://10.0.0.9:8001/__sync",
        ready: true,
        status: "running",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provisionDevPreviews(
      {
        executionId: "exec-1",
        services: ["workflow-builder", "workflow-orchestrator"],
        mode: "preview-native",
        adopt: true,
      },
      fakePersistence(),
    );

    expect(result).toMatchObject({
      ok: false,
      complete: false,
      pending: false,
      activationPhase: "failed",
    });
    expect(deletes).toEqual(["wfb-dev-preview-workflow-orchestrator-exec-1"]);
    expect(deletes).not.toContain("wfb-dev-preview-workflow-builder-exec-1");
  });

  it("fails closed when SEA does not acknowledge the private staged-adoption contract", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    let activationCalls = 0;
    stubDevPreviewFetch(
      vi.fn(async (url, init) => {
        const target = String(url);
        if (target.includes("/internal/dev-previews?")) {
          return Response.json({
            executionId: "exec-1",
            complete: true,
            services: [],
          });
        }
        if (target.endsWith("/internal/dev-previews/activate")) {
          activationCalls += 1;
          return Response.json({});
        }
        const body = JSON.parse(String((init as RequestInit).body));
        expect(body.stageAdoption).toBe(true);
        // Simulates a pre-handshake SEA that ignores the additive request field.
        return Response.json({
          sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
          podIP: "10.0.0.9",
          syncUrl: "http://10.0.0.9:3000/__sync",
          ready: true,
          status: "running",
        });
      }),
    );
    const persistence = fakePersistence();

    const result = await provisionDevPreviews(
      {
        executionId: "exec-1",
        services: ["workflow-builder"],
        mode: "preview-native",
        adopt: true,
      },
      persistence,
    );

    expect(result).toMatchObject({
      ok: false,
      services: [
        {
          service: "workflow-builder",
          ok: false,
          error: expect.stringContaining("did not acknowledge staged adoption"),
        },
      ],
    });
    expect(activationCalls).toBe(0);
    expect(persistence.upsertWorkflowWorkspaceSession).not.toHaveBeenCalled();
  });

  it("restores every prior image when one coherent replacement fails", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const oldGateway = `ghcr.io/pittampalliorg/mcp-gateway-dev@sha256:${"1".repeat(64)}`;
    const oldOrchestrator = `ghcr.io/pittampalliorg/workflow-orchestrator-dev@sha256:${"2".repeat(64)}`;
    const newGateway = `ghcr.io/pittampalliorg/mcp-gateway-dev@sha256:${"3".repeat(64)}`;
    const newOrchestrator = `ghcr.io/pittampalliorg/workflow-orchestrator-dev@sha256:${"4".repeat(64)}`;
    const rows = [
      {
        workspaceRef: "sandbox-router",
        sandboxState: {
          details: { service: "mcp-gateway", image: oldGateway },
        },
      },
      {
        workspaceRef: "sandbox-orchestrator",
        sandboxState: {
          details: {
            service: "workflow-orchestrator",
            image: oldOrchestrator,
          },
        },
      },
    ];
    const requestedImages: string[] = [];
    stubDevPreviewFetch(
      vi.fn(async (_url, init) => {
        const body = JSON.parse(String((init as RequestInit).body));
        requestedImages.push(body.image);
        if (body.image === newOrchestrator) {
          return new Response(
            JSON.stringify({ detail: "replacement failed" }),
            {
              status: 503,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            sandboxName: `wfb-dev-preview-${body.service}-exec-1`,
            podIP: "10.0.0.5",
            port: body.service === "workflow-builder" ? 3000 : 8080,
            syncPort: body.service === "workflow-builder" ? 3000 : 8001,
            syncUrl: `http://10.0.0.5:${body.service === "workflow-builder" ? 3000 : 8001}/__sync`,
            ready: true,
            status: "running",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const result = await replaceDevPreviewImages(
      {
        executionId: "exec-1",
        services: [
          { service: "mcp-gateway", image: newGateway },
          { service: "workflow-orchestrator", image: newOrchestrator },
        ],
        mode: "preview-native",
        adopt: true,
      },
      fakePersistence(rows),
    );

    expect(result).toMatchObject({
      ok: false,
      rollback: {
        attempted: true,
        ok: true,
        services: [
          { service: "mcp-gateway", ok: true },
          { service: "workflow-orchestrator", ok: true },
        ],
      },
    });
    expect(requestedImages).toEqual([
      newGateway,
      newOrchestrator,
      oldGateway,
      oldOrchestrator,
    ]);
  });

  it.each(["workflow-builder", "function-router"])(
    "fails closed before replacing the adopted %s image in place",
    async (service) => {
      vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
      const fetchMock = vi.fn();
      stubDevPreviewFetch(fetchMock);

      await expect(
        replaceDevPreviewImages(
          {
            executionId: "exec-1",
            services: [
              {
                service,
                image: `ghcr.io/pittampalliorg/${service}-dev@sha256:${"3".repeat(64)}`,
              },
            ],
            mode: "preview-native",
            adopt: true,
          },
          fakePersistence(),
        ),
      ).rejects.toThrow("fresh acceptance preview");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("forwards the sidecar /__run command allowlist + extraSync to SEA", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            sandboxName: "wfb-dev-preview-workflow-orchestrator-exec-1",
            podIP: "10.0.0.13",
            port: 8080,
            syncPort: 8001,
            ready: true,
            status: "running",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    stubDevPreviewFetch(fetchMock);

    const info = await provisionDevPreview(
      { executionId: "exec-1", service: "workflow-orchestrator" },
      fakePersistence(),
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    // deps + the contract test lane travel to SEA (→ DEV_SYNC_COMMANDS_JSON).
    expect(body.devSyncCommands).toEqual({
      deps: "pip install -r requirements.txt && touch /app/app.py",
      contract:
        "python -m pytest tests/test_workflow_data_activity_migration.py -q",
    });
    // The returned info carries the extraSync sources the sync client stages.
    expect(info.extraSync).toEqual([
      {
        from: "../shared/workflow-data-contract",
        to: ".contract-fixtures",
      },
    ]);
  });

  it("provisions functional preview databases through the injected port", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      return new Response(
        JSON.stringify({
          sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
          podIP: "10.0.0.12",
          port: 3000,
          syncPort: 3000,
          url: "http://10.0.0.12:3000",
          syncUrl: "http://10.0.0.12:3000/__sync",
          ready: true,
          status: "running",
          serviceSecretEnv: body.serviceSecretEnv,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    stubDevPreviewFetch(fetchMock);
    const persistence = fakePersistence();
    const previewDatabases = fakePreviewDatabases();

    await provisionDevPreview(
      {
        executionId: "exec-1",
        service: "workflow-builder",
      },
      persistence,
      previewDatabases,
    );

    expect(previewDatabases.provision).toHaveBeenCalledWith({
      executionId: "exec-1",
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.serviceSecretEnv).toMatchObject({
      DATABASE_URL: "postgres://preview-db",
      PREVIEW_SOURCE_DATABASE_URL: "postgres://source-db",
    });
  });

  it("cleans an exact malformed provision tuple before marking state and dropping its new database", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const events: string[] = [];
    const persistence = fakePersistence();
    vi.mocked(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).mockImplementation(async () => {
      events.push("mark-cleaned");
      return true;
    });
    const previewDatabases = fakePreviewDatabases();
    vi.mocked(previewDatabases.drop).mockImplementation(async () => {
      events.push("drop-database");
    });
    stubDevPreviewFetch(
      vi.fn(async (url, init) => {
        const target = String(url);
        if (init?.method === "DELETE") {
          expect(teardownRequestIdentity(target)).toEqual({
            sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
            executionId: "exec-1",
            service: "workflow-builder",
          });
          events.push("delete-sandbox");
          return Response.json({
            sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
            accepted: true,
            deleted: true,
            deferred: false,
          });
        }
        events.push("provision-response");
        return Response.json({
          sandboxName: "wrong-sandbox",
          ready: true,
        });
      }),
    );

    await expect(
      provisionDevPreview(
        { executionId: "exec-1", service: "workflow-builder" },
        persistence,
        previewDatabases,
      ),
    ).rejects.toThrow("invalid dev-preview identity");

    expect(events).toEqual([
      "provision-response",
      "delete-sandbox",
      "mark-cleaned",
      "drop-database",
    ]);
    expect(persistence.upsertWorkflowWorkspaceSession).not.toHaveBeenCalled();
    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).toHaveBeenCalledWith({
      workspaceRef: "wfb-dev-preview-workflow-builder-exec-1",
    });
    expect(previewDatabases.drop).toHaveBeenCalledWith({
      executionId: "exec-1",
    });
  });

  it("does not mark state or drop a database when malformed provision cleanup is deferred", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const persistence = fakePersistence();
    const previewDatabases = fakePreviewDatabases();
    stubDevPreviewFetch(
      vi.fn(async (url, init) => {
        const target = String(url);
        if (init?.method === "DELETE") {
          expect(teardownRequestIdentity(target)).toEqual({
            sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
            executionId: "exec-1",
            service: "workflow-builder",
          });
          return Response.json(
            {
              sandboxName: "wfb-dev-preview-workflow-builder-exec-1",
              accepted: true,
              deleted: false,
              deferred: true,
            },
            { status: 202 },
          );
        }
        return Response.json({ sandboxName: "wrong-sandbox", ready: true });
      }),
    );

    await expect(
      provisionDevPreview(
        { executionId: "exec-1", service: "workflow-builder" },
        persistence,
        previewDatabases,
      ),
    ).rejects.toThrow(
      "unconfirmed provision cleanup was not proven: deterministic provision cleanup was deferred",
    );

    expect(
      persistence.markWorkflowWorkspaceSessionCleaned,
    ).not.toHaveBeenCalled();
    expect(previewDatabases.drop).not.toHaveBeenCalled();
  });

  it("persists the resolved image and reuses it over a newer pin on re-entry", async () => {
    // function-router is a non-functional (no-DB) preview, so it needs no DB provisioner.
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            sandboxName: "wfb-dev-preview-function-router-exec-1",
            podIP: "10.0.0.14",
            port: 8080,
            syncPort: 8001,
            ready: true,
            status: "running",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    stubDevPreviewFetch(fetchMock);

    // First provision: no persisted row, env pins the image → resolver used + persisted.
    const imageV1 = `ghcr.io/pittampalliorg/function-router-dev:git-${"1".repeat(40)}`;
    const imageV2 = `ghcr.io/pittampalliorg/function-router-dev:git-${"2".repeat(40)}`;
    vi.stubEnv("FUNCTION_ROUTER_DEV_IMAGE", imageV1);
    const persistence = fakePersistence();
    const first = await provisionDevPreview(
      { executionId: "exec-1", service: "function-router" },
      persistence,
    );
    expect(first.image).toBe(imageV1);
    expect(persistence.upsertWorkflowWorkspaceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxState: {
          details: expect.objectContaining({ image: imageV1 }),
        },
      }),
    );

    // Re-entry: a persisted row exists AND the env pin moved to a newer image. The
    // persisted image must WIN over the fresh resolution (run stability).
    vi.stubEnv("FUNCTION_ROUTER_DEV_IMAGE", imageV2);
    const reentry = fakePersistence();
    reentry.listWorkflowWorkspaceSessionsByExecutionId = vi.fn(async () => [
      {
        workspaceRef: "wfb-dev-preview-function-router-exec-1",
        sandboxState: {
          details: { service: "function-router", image: imageV1 },
        },
      },
    ]);
    const second = await provisionDevPreview(
      { executionId: "exec-1", service: "function-router" },
      reentry,
    );
    expect(second.image).toBe(imageV1);
    const body = JSON.parse(
      String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body),
    );
    expect(body.image).toBe(imageV1);
  });
});

describe("atomic multi-service dev-preview capture", () => {
  beforeEach(() => {
    vi.stubEnv("PREVIEW_DEV_SYNC_MINT_TOKEN", "");
    vi.stubEnv("WFB_DEV_SYNC_TOKEN", "1".repeat(64));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function rows() {
    return [
      {
        workspaceRef: "dev-builder",
        sandboxState: {
          details: {
            service: "workflow-builder",
            podIP: "10.0.0.11",
            syncPort: 3000,
          },
        },
      },
      {
        workspaceRef: "dev-orchestrator",
        sandboxState: {
          details: {
            service: "workflow-orchestrator",
            podIP: "10.0.0.12",
            syncPort: 8001,
          },
        },
      },
    ];
  }

  function atomicExport(
    service: string,
    body: Buffer,
    generation = "generation-1",
    rootContractService = service,
  ): Response {
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "x-sync-generation": generation,
        "x-sync-service": service,
        "x-sync-roots": JSON.stringify(
          [
            ...new Set(
              devPreviewCaptureMappings(
                resolveDevPreviewDescriptor(rootContractService),
              ).map((mapping) => mapping.from),
            ),
          ].sort(),
        ),
        "x-content-sha256": `sha256:${createHash("sha256").update(body).digest("hex")}`,
      },
    });
  }

  it("fetches a complete set before persisting one versioned artifact", async () => {
    const builderTar = gzipSync(Buffer.from("builder-overlay"));
    const orchestratorTar = gzipSync(Buffer.from("orchestrator-overlay"));
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        const body = String(url).includes("10.0.0.11")
          ? builderTar
          : orchestratorTar;
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
    const persistence = fakePersistence(rows());

    const result = await captureAllDevPreviewSources(
      "exec-1",
      { nodeId: "snapshot", iteration: 4 },
      persistence,
    );

    expect(result).toMatchObject({ ok: true, artifactId: "artifact-1" });
    expect(maxInFlight).toBe(2);
    const persist = vi.mocked(persistence.persistSourceBundleArtifact);
    expect(persist).toHaveBeenCalledTimes(1);
    const input = persist.mock.calls[0]?.[0];
    expect(input?.meta).toMatchObject({
      tier: "tar-overlay-set",
      manifestVersion: 1,
      serviceCount: 2,
      services: ["workflow-builder", "workflow-orchestrator"],
      repoUrl: "PittampalliOrg/workflow-builder",
      base: "main",
      iteration: 4,
    });
    const manifest = JSON.parse(
      gunzipSync(input?.bytes ?? Buffer.alloc(0)).toString(),
    );
    expect(manifest).toMatchObject({
      version: 1,
      tier: "tar-overlay-set",
      captureProtocol: "legacy",
      acceptanceEligible: false,
      generation: null,
      repoUrl: "PittampalliOrg/workflow-builder",
      base: "main",
    });
    expect(manifest.captureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(manifest.capturedAt).toISOString()).toBe(
      manifest.capturedAt,
    );
    expect(
      manifest.services.map((entry: { service: string }) => entry.service),
    ).toEqual(["workflow-builder", "workflow-orchestrator"]);
    expect(manifest.services[0]).toMatchObject({
      repoSubdir: ".",
      syncPaths: expect.arrayContaining([
        "src",
        "services/shared/workflow-data-contract",
        "package.json",
        "pnpm-lock.yaml",
      ]),
      captureMappings: expect.arrayContaining([
        {
          from: "services/shared/workflow-data-contract",
          to: "services/shared/workflow-data-contract",
        },
      ]),
    });
    expect(Buffer.from(manifest.services[0].tarGzipBase64, "base64")).toEqual(
      builderTar,
    );
    expect(manifest.services[1]).toMatchObject({
      repoSubdir: "services/workflow-orchestrator",
      captureMappings: expect.arrayContaining([
        {
          from: ".contract-fixtures",
          to: "services/shared/workflow-data-contract",
        },
      ]),
    });
    const exportedUrls = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => decodeURIComponent(String(url)));
    expect(exportedUrls).toContainEqual(
      expect.stringContaining(".contract-fixtures"),
    );
    expect(Buffer.from(manifest.services[1].tarGzipBase64, "base64")).toEqual(
      orchestratorTar,
    );
  });

  it("persists a strict v2 capture only for one complete immutable generation", async () => {
    const builderTar = gzipSync(Buffer.from("builder-v2"));
    const orchestratorTar = gzipSync(Buffer.from("orchestrator-v2"));
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("10.0.0.11")
          ? atomicExport("workflow-builder", builderTar)
          : atomicExport("workflow-orchestrator", orchestratorTar),
      ),
    );
    const persistence = fakePersistence(rows());
    const platformRevision = "a".repeat(40);
    const sourceRevision = "b".repeat(40);

    const result = await captureAllDevPreviewSources(
      "exec-1",
      {
        nodeId: "snapshot",
        iteration: 7,
        expectedServices: ["workflow-orchestrator", "workflow-builder"],
        requireImmutableProvenance: true,
        platformRevision,
        sourceRevision,
        catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
      },
      persistence,
    );

    expect(result).toMatchObject({ ok: true, generation: "generation-1" });
    const input = vi.mocked(persistence.persistSourceBundleArtifact).mock
      .calls[0]?.[0];
    expect(input?.fileName).toContain(result.captureId);
    expect(input?.meta).toMatchObject({
      manifestVersion: 2,
      captureProtocol: "atomic-generation-v2",
      acceptanceEligible: true,
      generation: "generation-1",
      catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
      platformRevision,
      sourceRevision,
    });
    const manifest = JSON.parse(
      gunzipSync(input?.bytes ?? Buffer.alloc(0)).toString(),
    );
    expect(manifest).toMatchObject({
      version: 2,
      captureProtocol: "atomic-generation-v2",
      acceptanceEligible: true,
      generation: "generation-1",
      catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
      platformRevision,
      sourceRevision,
    });
    expect(manifest.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: "workflow-builder",
          contentSha256: `sha256:${createHash("sha256").update(builderTar).digest("hex")}`,
        }),
        expect.objectContaining({
          service: "workflow-orchestrator",
          contentSha256: `sha256:${createHash("sha256").update(orchestratorTar).digest("hex")}`,
        }),
      ]),
    );
  });

  it("persists nothing when strict exports report different generations", async () => {
    const tar = gzipSync(Buffer.from("overlay"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("10.0.0.11")
          ? atomicExport("workflow-builder", tar, "generation-1")
          : atomicExport("workflow-orchestrator", tar, "generation-2"),
      ),
    );
    const persistence = fakePersistence(rows());
    const result = await captureAllDevPreviewSources(
      "exec-1",
      {
        expectedServices: ["workflow-builder", "workflow-orchestrator"],
        requireImmutableProvenance: true,
        platformRevision: "a".repeat(40),
        sourceRevision: "b".repeat(40),
      },
      persistence,
    );
    expect(result).toMatchObject({
      ok: false,
      skipped: "generation_mismatch",
    });
    expect(persistence.persistSourceBundleArtifact).not.toHaveBeenCalled();
  });

  it("strict capture rejects caller service subsets and supersets of persisted sessions", async () => {
    const persistence = fakePersistence(rows());
    const fetchMock = vi.fn();
    stubDevPreviewFetch(fetchMock);
    for (const expectedServices of [
      ["workflow-builder"],
      ["workflow-builder", "workflow-orchestrator", "function-router"],
    ]) {
      expect(
        await captureAllDevPreviewSources(
          "exec-1",
          { requireImmutableProvenance: true, expectedServices },
          persistence,
        ),
      ).toMatchObject({
        ok: false,
        skipped: "persisted_service_set_mismatch",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persistence.persistSourceBundleArtifact).not.toHaveBeenCalled();
  });

  it("strict mode rejects missing provenance, catalog drift, and invalid services", async () => {
    const persistence = fakePersistence(rows());
    expect(
      await captureAllDevPreviewSources(
        "exec-1",
        { requireImmutableProvenance: true },
        persistence,
      ),
    ).toMatchObject({ ok: false, skipped: "missing_expected_services" });
    expect(
      await captureAllDevPreviewSources(
        "exec-1",
        {
          requireImmutableProvenance: true,
          expectedServices: ["not-in-catalog"],
        },
        persistence,
      ),
    ).toMatchObject({ ok: false, skipped: "invalid_expected_services" });

    const tar = gzipSync(Buffer.from("overlay"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("10.0.0.11")
          ? atomicExport("workflow-builder", tar)
          : atomicExport("workflow-orchestrator", tar),
      ),
    );
    expect(
      await captureAllDevPreviewSources(
        "exec-1",
        {
          requireImmutableProvenance: true,
          expectedServices: ["workflow-builder", "workflow-orchestrator"],
          platformRevision: "a".repeat(40),
          sourceRevision: "b".repeat(40),
          catalogDigest: `sha256:${"0".repeat(64)}`,
        },
        persistence,
      ),
    ).toMatchObject({ ok: false, skipped: "catalog_digest_mismatch" });
  });

  it("strict mode rejects a digest or service header that does not describe the bytes", async () => {
    const tar = gzipSync(Buffer.from("overlay"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const service = String(url).includes("10.0.0.11")
          ? "wrong-service"
          : "workflow-orchestrator";
        return atomicExport(
          service,
          tar,
          "generation-1",
          String(url).includes("10.0.0.11")
            ? "workflow-builder"
            : "workflow-orchestrator",
        );
      }),
    );
    const persistence = fakePersistence(rows());
    const result = await captureAllDevPreviewSources(
      "exec-1",
      {
        requireImmutableProvenance: true,
        expectedServices: ["workflow-builder", "workflow-orchestrator"],
        platformRevision: "a".repeat(40),
        sourceRevision: "b".repeat(40),
      },
      persistence,
    );
    expect(result).toMatchObject({
      ok: false,
      skipped: "incomplete_export_set",
    });
    expect(result.services).toContainEqual({
      service: "workflow-builder",
      ok: false,
      skipped: "export_service_mismatch",
    });
    expect(persistence.persistSourceBundleArtifact).not.toHaveBeenCalled();
  });

  it("persists nothing when one required service export fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const goodTar = gzipSync(Buffer.from("builder-overlay"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).includes("10.0.0.12")
          ? new Response("unavailable", { status: 503 })
          : new Response(goodTar, { status: 200 }),
      ),
    );
    const persistence = fakePersistence(rows());

    const result = await captureAllDevPreviewSources(
      "exec-1",
      { nodeId: "snapshot", iteration: 5 },
      persistence,
    );

    expect(result).toMatchObject({
      ok: false,
      skipped: "incomplete_export_set",
      services: expect.arrayContaining([
        { service: "workflow-builder", ok: true },
        {
          service: "workflow-orchestrator",
          ok: false,
          skipped: "export_http_503",
        },
      ]),
    });
    expect(persistence.persistSourceBundleArtifact).not.toHaveBeenCalled();
  });
});
