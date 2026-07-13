import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PreviewEnvironmentDeletionIntent,
} from "$lib/server/application/ports/preview-environments";
import {
  claimVclusterPreview,
  getVclusterPreviewCleanup,
  getVclusterPreviewRuntime,
  launchVclusterPreview,
  listVclusterPreviewsWithCounts,
  provisionVclusterPreview,
  teardownVclusterPreview,
  touchVclusterPreview,
} from "./vcluster-preview";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String((init as RequestInit).body));
}

describe("vcluster-preview A3 claim-first client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses only the dedicated sandbox execution token", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubEnv("SANDBOX_EXECUTION_API_TOKEN", "sandbox-token");
    vi.stubEnv("INTERNAL_API_TOKEN", "broad-token");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer sandbox-token",
      );
      return jsonResponse({ name: "secure", status: "provisioning" }, 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    await provisionVclusterPreview({ name: "secure" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not fall back to the broad internal API token", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubEnv("INTERNAL_API_TOKEN", "broad-token");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(
        (init?.headers as Record<string, string>).Authorization,
      ).toBeUndefined();
      return jsonResponse({ name: "secure", status: "provisioning" }, 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    await provisionVclusterPreview({ name: "secure" });
  });

  it("claims a warm-pool member first and does not cold-provision", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/touch"))
        return jsonResponse({
          name: "my-feature",
          state: "hot",
          resuming: false,
        });
      expect(url).toBe("http://sandbox-api/internal/vcluster-preview/claim");
      return jsonResponse(
        {
          name: "my-feature",
          pool: "pool-abcd",
          pooled: true,
          status: "claiming",
          tailnetHost: "wfb-my-feature",
          url: "https://wfb-my-feature.tail286401.ts.net",
        },
        202,
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const preview = await launchVclusterPreview({
      name: "My Feature",
      user: "u1",
    });

    expect(preview.pool).toBe("pool-abcd");
    expect(preview.name).toBe("my-feature");
    expect(preview.phase).toBe("claiming");
    // The claim endpoint + the A4 activity touch — no cold /internal/vcluster-preview call.
    expect(calls).toEqual([
      "http://sandbox-api/internal/vcluster-preview/claim",
      "http://sandbox-api/internal/vcluster-preview/my-feature/touch",
    ]);
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      name: "my-feature",
      user: "u1",
    });
  });

  it("launch succeeds even when the post-claim touch fails", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/touch")) return jsonResponse({ detail: "boom" }, 500);
      return jsonResponse(
        { name: "my-feature", pool: "pool-abcd", status: "claiming" },
        202,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const preview = await launchVclusterPreview({ name: "my-feature" });
    expect(preview.pool).toBe("pool-abcd");
  });

  it("falls back to a cold provision when the pool has no free member (claim 404)", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/claim"))
        return jsonResponse({ detail: "no free member" }, 404);
      return jsonResponse({
        name: "my-feature",
        job: "vcpreview-up-my-feature",
        status: "provisioning",
        tailnetHost: "wfb-my-feature",
        url: "https://wfb-my-feature.tail286401.ts.net",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const preview = await launchVclusterPreview({ name: "my-feature" });

    expect(calls).toEqual([
      "http://sandbox-api/internal/vcluster-preview/claim",
      "http://sandbox-api/internal/vcluster-preview",
    ]);
    expect(preview.pool).toBeNull();
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({
      name: "my-feature",
      action: "up",
    });
  });

  it("claimVclusterPreview returns null on 404", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({ detail: "empty" }, 404),
      ),
    );
    expect(await claimVclusterPreview({ name: "x" })).toBeNull();
  });

  it("claimVclusterPreview throws on a non-404 error", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({ detail: "boom" }, 500),
      ),
    );
    await expect(claimVclusterPreview({ name: "x" })).rejects.toThrow("boom");
  });

  it("passes immutable profile fields through the legacy claim client", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "x", pool: "pool-1", status: "claiming" }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);
    await claimVclusterPreview({
      name: "x",
      platformRevision: "a".repeat(40),
      sourceRevision: "b".repeat(40),
      delivery: "reconciler",
      enrollMode: "agent",
      profile: "app-live",
      mode: "live",
      allocation: { kind: "cold" },
      owner: { kind: "user", id: "user-42" },
      services: ["workflow-builder"],
      provenance: { requestId: "request-1" },
      trustedCode: true,
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      platformRevision: "a".repeat(40),
      sourceRevision: "b".repeat(40),
      delivery: "reconciler",
      enrollMode: "agent",
      profile: "app-live",
      mode: "live",
      allocation: { kind: "cold" },
      owner: { kind: "user", id: "user-42" },
      services: ["workflow-builder"],
      provenance: { requestId: "request-1" },
      trustedCode: true,
    });
  });

  it("provisionVclusterPreview posts action=up", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "x", status: "provisioning" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await provisionVclusterPreview({ name: "x" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://sandbox-api/internal/vcluster-preview",
      expect.objectContaining({ method: "POST" }),
    );
    expect(bodyOf(fetchMock.mock.calls[0]?.[1]).action).toBe("up");
  });

  it("sends both owned teardown guards to SEA", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubEnv("PREVIEW_ARCHIVE_TEARDOWN_TOKEN", "archive-proof-token");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "acceptance-one", status: "terminating" }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);

    await teardownVclusterPreview("acceptance-one", {
      mode: "owned",
      requestId: "acceptance-request-1",
      sourceRevision: "b".repeat(40),
      archiveConfirmed: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://sandbox-api/internal/vcluster-preview/acceptance-one",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      expectedRequestId: "acceptance-request-1",
      expectedSourceRevision: "b".repeat(40),
    });
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        "x-preview-archive-teardown-token",
      ),
    ).toBe("archive-proof-token");
  });

  it("threads the complete controller deletion intent to SEA", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "failed-cold", status: "terminating" }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);
    const deletionIntent = {
      id: `sha256:${"d".repeat(64)}`,
      name: "failed-cold",
      environmentUid: "12345678-1234-1234-1234-123456789abc",
      requestId: "request-failed-cold",
      platformRevision: "a".repeat(40),
      sourceRevision: "b".repeat(40),
      catalogDigest: `sha256:${"c".repeat(64)}`,
      deletionTimestamp: "2026-07-12T12:00:00.000Z",
    } as PreviewEnvironmentDeletionIntent;

    await teardownVclusterPreview(deletionIntent.name, {
      mode: "owned",
      requestId: deletionIntent.requestId,
      sourceRevision: deletionIntent.sourceRevision,
      archiveConfirmed: true,
      deletionIntent,
    });

    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({
      expectedRequestId: deletionIntent.requestId,
      expectedSourceRevision: deletionIntent.sourceRevision,
      environmentUid: deletionIntent.environmentUid,
      deletionIntentId: deletionIntent.id,
      platformRevision: deletionIntent.platformRevision,
      catalogDigest: deletionIntent.catalogDigest,
      deletionTimestamp: deletionIntent.deletionTimestamp,
    });
  });

  it("does not send archive proof before the application confirms durability", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubEnv("PREVIEW_ARCHIVE_TEARDOWN_TOKEN", "archive-proof-token");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "reconciled-one", status: "terminating" }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);

    await teardownVclusterPreview("reconciled-one", {
      mode: "owned",
      requestId: "acceptance-request-2",
      sourceRevision: "c".repeat(40),
    });

    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        "x-preview-archive-teardown-token",
      ),
    ).toBeNull();
  });

  it("threads the immutable profiled contract to SEA without downgrade retry", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "feature-x", status: "provisioning" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await provisionVclusterPreview({
      name: "feature-x",
      platformRevision: "a".repeat(40),
      sourceRevision: "b".repeat(40),
      delivery: "reconciler",
      enrollMode: "agent",
      profile: "app-live",
      mode: "live",
      allocation: { kind: "cold" },
      owner: { kind: "user", id: "user-42" },
      services: ["workflow-builder", "workflow-orchestrator"],
      provenance: { requestId: "server-request-1" },
      trustedCode: true,
      createOnly: true,
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      name: "feature-x",
      action: "up",
      platformRevision: "a".repeat(40),
      sourceRevision: "b".repeat(40),
      delivery: "reconciler",
      enrollMode: "agent",
      profile: "app-live",
      mode: "live",
      allocation: { kind: "cold" },
      owner: { kind: "user", id: "user-42" },
      services: ["workflow-builder", "workflow-orchestrator"],
      provenance: { requestId: "server-request-1" },
      trustedCode: true,
      createOnly: true,
    });
  });

  it("parses runtime image and cleanup convergence observations", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const digest = `sha256:${"c".repeat(64)}`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/runtime")) {
        return jsonResponse({
          name: "feature-x",
          resourceName: "feature-x",
          reconciliationSucceeded: true,
          upJob: {
            name: "vcpreview-up-feature-x",
            found: true,
            active: false,
            succeeded: true,
            failed: false,
          },
          services: [
            {
              service: "workflow-builder",
              containers: [
                {
                  pod: "workflow-builder-abc",
                  image: `ghcr.io/pittampalliorg/workflow-builder@${digest}`,
                  imageId: `ghcr.io/pittampalliorg/workflow-builder@${digest}`,
                  ready: true,
                },
              ],
            },
          ],
        });
      }
      return jsonResponse({
        name: "feature-x",
        resourceName: "feature-x",
        complete: true,
        phase: "complete",
        checks: {
          runnerSucceeded: true,
          previewEnvironmentAbsent: true,
          applicationAbsent: true,
          agentRegistrationAbsent: true,
          agentNamespacesAbsent: true,
          databaseAbsent: true,
          natsStreamAbsent: true,
          headlampRegistrationAbsent: true,
          tailnetEgressAbsent: true,
          hostNamespaceAbsent: true,
          storageScopeAbsent: true,
          runnerIdentityAbsent: true,
        },
        message: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getVclusterPreviewRuntime("feature-x")).resolves.toMatchObject(
      {
        services: [
          {
            service: "workflow-builder",
            containers: [
              { ready: true, imageId: expect.stringContaining(digest) },
            ],
          },
        ],
      },
    );
    await expect(getVclusterPreviewRuntime("feature-x")).resolves.toMatchObject(
      {
        name: "feature-x",
        resourceName: "feature-x",
        upJob: {
          name: "vcpreview-up-feature-x",
          found: true,
          succeeded: true,
        },
      },
    );
    await expect(getVclusterPreviewCleanup("feature-x")).resolves.toMatchObject(
      {
        complete: true,
        phase: "complete",
        checks: {
          hostNamespaceAbsent: true,
          runnerIdentityAbsent: true,
        },
      },
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://sandbox-api/internal/vcluster-preview/feature-x/runtime",
      "http://sandbox-api/internal/vcluster-preview/feature-x/runtime",
      "http://sandbox-api/internal/vcluster-preview/feature-x/cleanup",
    ]);
  });

  it.each([
    [
      "missing name",
      {
        resourceName: "feature-x",
        reconciliationSucceeded: false,
        upJob: {
          name: "vcpreview-up-feature-x",
          found: false,
          active: false,
          succeeded: false,
          failed: false,
        },
        services: [],
      },
    ],
    [
      "empty resource identity",
      {
        name: "feature-x",
        resourceName: "",
        reconciliationSucceeded: false,
        upJob: {
          name: "vcpreview-up-feature-x",
          found: false,
          active: false,
          succeeded: false,
          failed: false,
        },
        services: [],
      },
    ],
    [
      "wrong up job identity",
      {
        name: "feature-x",
        resourceName: "feature-x",
        reconciliationSucceeded: false,
        upJob: {
          name: "vcpreview-up-another",
          found: false,
          active: false,
          succeeded: false,
          failed: false,
        },
        services: [],
      },
    ],
  ])("rejects runtime proof with %s", async (_label, body) => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body)),
    );

    await expect(getVclusterPreviewRuntime("feature-x")).rejects.toThrow(
      "SEA returned an invalid preview runtime snapshot",
    );
  });

  it("listVclusterPreviewsWithCounts parses previews and capacity counts", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({
          previews: [
            {
              name: "my-feature",
              phase: "ready",
              ready: true,
              pool: "pool-9",
              platformRevision: "a".repeat(40),
              sourceRevision: "b".repeat(40),
              profile: "app-live",
              mode: "reconciled",
              owner: { kind: "session", id: "session:42" },
              services: ["workflow-builder"],
              provenance: { requestId: "request-1" },
              trustedCode: true,
              allocation: { kind: "cold" },
              images: { "workflow-builder": "immutable" },
              catalogDigest: `sha256:${"c".repeat(64)}`,
            },
          ],
          counts: {
            awake: 3,
            free: 1,
            claimed: 1,
            recycling: 0,
            max: 6,
            poolSize: 2,
          },
        }),
      ),
    );
    const { previews, counts } = await listVclusterPreviewsWithCounts();
    expect(previews[0].pool).toBe("pool-9");
    expect(previews[0]).toMatchObject({
      platformRevision: "a".repeat(40),
      sourceRevision: "b".repeat(40),
      profile: "app-live",
      mode: "reconciled",
      owner: { kind: "session", id: "session:42" },
      services: ["workflow-builder"],
      provenance: { requestId: "request-1" },
      trustedCode: true,
      allocation: { kind: "cold" },
      images: { "workflow-builder": "immutable" },
      catalogDigest: `sha256:${"c".repeat(64)}`,
    });
    expect(counts).toMatchObject({
      awake: 3,
      free: 1,
      claimed: 1,
      max: 6,
      poolSize: 2,
    });
  });

  it("tolerates an older SEA that omits counts", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({ previews: [{ name: "x", phase: "ready" }] }),
      ),
    );
    const { previews, counts } = await listVclusterPreviewsWithCounts();
    expect(previews).toHaveLength(1);
    expect(counts).toBeNull();
  });

  // ---- A4/D1 lifecycle contract ------------------------------------------------

  it("touchVclusterPreview posts to the touch endpoint and parses the response", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "http://sandbox-api/internal/vcluster-preview/my-feature/touch",
      );
      expect((init as RequestInit).method).toBe("POST");
      return jsonResponse({
        name: "my-feature",
        state: "resuming",
        resuming: true,
        lastActive: "2026-07-04T12:00:00+00:00",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await touchVclusterPreview("My Feature");
    expect(result.resuming).toBe(true);
    expect(result.state).toBe("resuming");
    expect(result.lastActive).toBe("2026-07-04T12:00:00+00:00");
  });

  it("passes the D1 origin/prNumber/ttlHours through claim and cold provision", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/claim")) return jsonResponse({ detail: "empty" }, 404);
      return jsonResponse({ name: "pr-341", status: "provisioning" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await launchVclusterPreview({
      name: "pr-341",
      lifecycle: "ephemeral",
      owner: { kind: "automation", id: "pr-preview:341" },
      origin: { kind: "pull-request", reference: "341" },
      prNumber: 341,
      ttlHours: 24,
    });
    // Claim body carries the lifecycle fields…
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      lifecycle: "ephemeral",
      owner: { kind: "automation", id: "pr-preview:341" },
      origin: { kind: "pull-request", reference: "341" },
      prNumber: 341,
      ttlHours: 24,
    });
    // …and so does the cold-provision fallback body.
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({
      action: "up",
      lifecycle: "ephemeral",
      owner: { kind: "automation", id: "pr-preview:341" },
      origin: { kind: "pull-request", reference: "341" },
      prNumber: 341,
      ttlHours: 24,
    });
  });

  it("omits lifecycle fields from bodies when not given", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "x", status: "provisioning" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await provisionVclusterPreview({ name: "x" });
    const body = bodyOf(fetchMock.mock.calls[0]?.[1]);
    expect("origin" in body).toBe(false);
    expect("prNumber" in body).toBe(false);
    expect("ttlHours" in body).toBe(false);
  });

  it("parses the A4 state/origin/expiry fields off previews and counts", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({
          previews: [
            {
              name: "pr-341",
              phase: "slept",
              ready: false,
              state: "slept",
              origin: { kind: "pull-request", reference: "341" },
              legacyOrigin: "pr",
              prNumber: 341,
              expiresAt: "2026-07-05T12:00:00+00:00",
              lastActive: "2026-07-04T09:00:00+00:00",
            },
            { name: "legacy", phase: "ready", ready: true },
          ],
          counts: {
            awake: 2,
            slept: 1,
            total: 3,
            free: 1,
            claimed: 1,
            recycling: 0,
            max: 6,
            totalMax: 8,
            poolSize: 2,
          },
        }),
      ),
    );
    const { previews, counts } = await listVclusterPreviewsWithCounts();
    const pr = previews.find((p) => p.name === "pr-341");
    expect(pr).toMatchObject({
      state: "slept",
      origin: { kind: "pull-request", reference: "341" },
      legacyOrigin: "pr",
      prNumber: 341,
      expiresAt: "2026-07-05T12:00:00+00:00",
      lastActive: "2026-07-04T09:00:00+00:00",
    });
    const legacy = previews.find((p) => p.name === "legacy");
    expect(legacy).toMatchObject({
      state: null,
      origin: null,
      prNumber: null,
      expiresAt: null,
      lastActive: null,
      platformRevision: null,
      sourceRevision: null,
      profile: null,
      mode: null,
      services: null,
      trustedCode: null,
      allocation: null,
      images: null,
      catalogDigest: null,
    });
    expect(counts).toMatchObject({
      awake: 2,
      slept: 1,
      total: 3,
      totalMax: 8,
    });
  });
});
