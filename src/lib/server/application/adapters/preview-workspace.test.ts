import { createHash } from "node:crypto";
import http from "node:http";
import { gzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { describe, expect, it, vi } from "vitest";
import { sessionHostAppId } from "$lib/server/sessions/agent-workflow-host";
import {
  HttpPreviewWorkspaceSourceBundleAdapter,
  OneShotPreviewWorkspaceGateway,
  OneShotPreviewWorkspaceGitBundleGateway,
  PREVIEW_WORKSPACE_HELPER_CLEANUP_TIMEOUT_MS,
  runOneShotPreviewWorkspaceHelper,
  validatePreviewWorkspaceArchive,
} from "./preview-workspace";

const SOURCE_REVISION = "b".repeat(40);
const IDENTITY = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: SOURCE_REVISION,
  catalogDigest: `sha256:${"c".repeat(64)}` as const,
};

type HelperRequest = Readonly<{
  executionId: string;
  workspaceKey: string | null;
  purpose: "seed" | "sync" | "source";
  secretEnv: Record<string, string> | null;
}>;

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function withHttpServer<T>(
  handler: http.RequestListener,
  use: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test HTTP server has no TCP address");
    }
    return await use(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause ? reject(cause) : resolve())),
    );
  }
}

async function archive(
  entries: Array<{
    name: string;
    type?: "file" | "directory" | "symlink";
    body?: string;
    linkname?: string;
  }>,
): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    pack.entry(
      {
        name: entry.name,
        type: entry.type ?? "file",
        size: entry.type === "directory" ? 0 : body.byteLength,
        linkname: entry.linkname,
      },
      entry.type === "directory" ? undefined : body,
    );
  }
  const ended = new Promise<void>((resolve, reject) => {
    pack.on("end", resolve);
    pack.on("error", reject);
  });
  pack.finalize();
  await ended;
  return gzipSync(Buffer.concat(chunks));
}

describe("validatePreviewWorkspaceArchive", () => {
  it("accepts current SvelteKit route path syntax", async () => {
    const bytes = await archive([
      {
        name: "src/routes/(admin)/executions/[executionId]/+page.svelte",
        body: "page",
      },
    ]);
    await expect(validatePreviewWorkspaceArchive(bytes)).resolves.toEqual({
      fileCount: 1,
      memberCount: 1,
      expandedBytes: 4,
    });
  });

  it.each([
    { entries: [{ name: "src\\escape.ts", body: "bad" }] },
    { entries: [{ name: "../escape.ts", body: "bad" }] },
    {
      entries: [
        {
          name: "src/link",
          type: "symlink" as const,
          linkname: "/tmp/target",
        },
      ],
    },
    {
      entries: [
        { name: "src/duplicate.ts", body: "one" },
        { name: "src/duplicate.ts", body: "two" },
      ],
    },
  ])("rejects unsafe archive entries", async ({ entries }) => {
    await expect(
      validatePreviewWorkspaceArchive(await archive(entries)),
    ).rejects.toThrow("unsafe entry");
  });
});

describe("runOneShotPreviewWorkspaceHelper", () => {
  const request = {
    executionId: "exec-1",
    workspaceKey: "ws_script_exec-1",
    purpose: "source" as const,
    secretEnv: { GITHUB_TOKEN: "not-logged" },
  };

  it("keeps its cleanup deadline outside SEA's absolute server deadline", () => {
    expect(PREVIEW_WORKSPACE_HELPER_CLEANUP_TIMEOUT_MS).toBe(45_000);
    expect(PREVIEW_WORKSPACE_HELPER_CLEANUP_TIMEOUT_MS).toBeGreaterThan(40_000);
  });

  it("uses the ready target returned by provision", async () => {
    const baseUrl = "http://10.244.1.20:8002";
    let expectedSandboxName = "";
    const provision = vi.fn(
      async (params: {
        sessionId: string;
        provisioningStartedAt?: Date | null;
      }) => {
        const agentAppId = sessionHostAppId(
          params.sessionId,
          params.provisioningStartedAt,
        );
        expectedSandboxName = `agent-host-${agentAppId}`;
        return {
          agentAppId,
          sandboxName: expectedSandboxName,
          status: "ready",
          baseUrl,
          podIP: "10.244.1.20",
        };
      },
    );
    const destroy = vi.fn(async (name: string) => ({
      name,
      kind: "runtime" as const,
      status: "deleted" as const,
    }));
    const use = vi.fn(async (target: string) => `used ${target}`);

    await expect(
      runOneShotPreviewWorkspaceHelper(request, use, {
        provision,
        destroy,
      }),
    ).resolves.toBe(`used ${baseUrl}`);

    expect(use).toHaveBeenCalledOnce();
    expect(use).toHaveBeenCalledWith(baseUrl);
    expect(destroy).toHaveBeenCalledWith(expectedSandboxName);
  });

  it.each([
    { label: "queued", status: "queued", baseUrl: undefined },
    { label: "starting", status: "starting", baseUrl: undefined },
    {
      label: "starting with an unusable target",
      status: "starting",
      baseUrl: "http://10.244.1.21:8002",
    },
    {
      label: "ready without a validated target",
      status: "ready",
      baseUrl: undefined,
    },
  ])("fails fast when provision returns $label", async ({ status, baseUrl }) => {
    let expectedSandboxName = "";
    const provision = vi.fn(
      async (params: {
        sessionId: string;
        provisioningStartedAt?: Date | null;
      }) => {
        const agentAppId = sessionHostAppId(
          params.sessionId,
          params.provisioningStartedAt,
        );
        expectedSandboxName = `agent-host-${agentAppId}`;
        return {
          agentAppId,
          sandboxName: expectedSandboxName,
          status,
          ...(baseUrl ? { baseUrl, podIP: "10.244.1.21" } : {}),
        };
      },
    );
    const destroy = vi.fn(async (name: string) => ({
      name,
      kind: "runtime" as const,
      status: "deleted" as const,
    }));
    const use = vi.fn(async () => "unused");

    await expect(
      runOneShotPreviewWorkspaceHelper(request, use, {
        provision,
        destroy,
      }),
    ).rejects.toMatchObject({
      code: "helper-unavailable",
      status: 503,
      message: "preview workspace helper did not return a ready target",
    });

    expect(use).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(expectedSandboxName);
  });

  it("cleans the expected generation when provisioning throws ambiguously", async () => {
    const destroy = vi.fn(async (name: string) => ({
      name,
      kind: "runtime" as const,
      status: "missing" as const,
    }));
    await expect(
      runOneShotPreviewWorkspaceHelper(request, async () => "unused", {
        provision: vi.fn(async () => {
          throw new Error("provision response was lost");
        }),
        destroy,
      }),
    ).rejects.toThrow("provision response was lost");
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(
      expect.stringMatching(/^agent-host-agent-session-/),
    );
  });

  it("rejects a mismatched provision receipt and never cleans its claimed name", async () => {
    const destroy = vi.fn(async (name: string) => ({
      name,
      kind: "runtime" as const,
      status: "deleted" as const,
    }));
    const use = vi.fn(async () => "unused");
    await expect(
      runOneShotPreviewWorkspaceHelper(request, use, {
        provision: vi.fn(async () => ({
          agentAppId: "agent-attacker",
          sandboxName: "agent-host-agent-attacker",
          status: "ready",
          baseUrl: "http://10.244.1.99:8002",
          podIP: "10.244.1.99",
        })),
        destroy,
      }),
    ).rejects.toThrow("mismatched identity");
    expect(use).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalledWith("agent-host-agent-attacker");
  });
});

describe("HttpPreviewWorkspaceSourceBundleAdapter", () => {
  it("sends only the exact identity and service under the tuple capability", async () => {
    const bundle = new Uint8Array([1, 2, 3, 4]);
    const bundleSha256 = `sha256:${createHash("sha256")
      .update(bundle)
      .digest("hex")}`;
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => {
        return new Response(bundle, {
          status: 200,
          headers: {
            "content-type": "application/vnd.git.bundle",
            "content-length": String(bundle.byteLength),
            "x-wfb-preview-source-repository":
              "PittampalliOrg/workflow-builder",
            "x-wfb-preview-source-revision": SOURCE_REVISION,
            "x-wfb-preview-source-sha256": bundleSha256,
            "x-wfb-preview-source-file-count": "42",
          },
        });
      },
    );
    const adapter = new HttpPreviewWorkspaceSourceBundleAdapter({
      baseUrl: () => "https://physical-broker.example/",
      token: () => "tuple-capability",
      fetch,
    });

    await expect(
      adapter.fetchExact({
        identity: IDENTITY,
        service: "workflow-builder",
      }),
    ).resolves.toEqual({
      repository: "PittampalliOrg/workflow-builder",
      sourceRevision: SOURCE_REVISION,
      bundle,
      bundleSha256,
      fileCount: 42,
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://physical-broker.example/api/internal/preview-control/environment/workspace-source",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Preview-Control-Capability": "tuple-capability",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      ...IDENTITY,
      service: "workflow-builder",
    });
    expect(String(init?.body)).not.toMatch(
      /repository|github|token|workspaceKey/i,
    );
  });

  it.each([
    {
      label: "digest",
      headers: {
        "x-wfb-preview-source-sha256": `sha256:${"f".repeat(64)}`,
      },
    },
    {
      label: "revision",
      headers: {
        "x-wfb-preview-source-revision": "e".repeat(40),
      },
    },
    {
      label: "content type",
      headers: {
        "content-type": "application/json",
      },
    },
    {
      label: "file count",
      headers: {
        "x-wfb-preview-source-file-count": "0",
      },
    },
  ])(
    "rejects a broker receipt with a mismatched $label",
    async ({ headers }) => {
      const bundle = new Uint8Array([1, 2, 3, 4]);
      const fetch = vi.fn(async () => {
        return new Response(bundle, {
          status: 200,
          headers: {
            "content-type": "application/vnd.git.bundle",
            "x-wfb-preview-source-repository":
              "PittampalliOrg/workflow-builder",
            "x-wfb-preview-source-revision": SOURCE_REVISION,
            "x-wfb-preview-source-sha256": `sha256:${createHash("sha256")
              .update(bundle)
              .digest("hex")}`,
            "x-wfb-preview-source-file-count": "42",
            ...headers,
          },
        });
      });
      const adapter = new HttpPreviewWorkspaceSourceBundleAdapter({
        baseUrl: () => "https://physical-broker.example",
        token: () => "tuple-capability",
        fetch,
      });

      await expect(
        adapter.fetchExact({
          identity: IDENTITY,
          service: "workflow-builder",
        }),
      ).rejects.toMatchObject({
        code: "helper-invalid-receipt",
        status: 502,
      });
    },
  );

  it("bounds the broker body before reading it", async () => {
    const fetch = vi.fn(async () => {
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-length": String(64 * 1024 * 1024 + 1),
        },
      });
    });
    const adapter = new HttpPreviewWorkspaceSourceBundleAdapter({
      baseUrl: () => "https://physical-broker.example",
      token: () => "tuple-capability",
      fetch,
    });

    await expect(
      adapter.fetchExact({
        identity: IDENTITY,
        service: "workflow-builder",
      }),
    ).rejects.toMatchObject({
      code: "source-rejected",
      status: 413,
    });
  });
});

describe("OneShotPreviewWorkspaceGitBundleGateway", () => {
  it("keeps the GitHub credential in the physical helper and validates its exact bundle receipt", async () => {
    const helperRequests: HelperRequest[] = [];
    const requests: Array<{
      path: string;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }> = [];
    const bundle = new Uint8Array([4, 3, 2, 1]);
    const bundleSha256 = `sha256:${createHash("sha256")
      .update(bundle)
      .digest("hex")}`;
    const runHelper = async <T>(
      request: HelperRequest,
      use: (baseUrl: string) => Promise<T>,
    ) => {
      helperRequests.push(request);
      return await withHttpServer(async (incoming, response) => {
        const body = await readBody(incoming);
        requests.push({
          path: incoming.url ?? "",
          headers: incoming.headers,
          body,
        });
        if (incoming.url === "/internal/preview-workspace/seed") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ reused: false, fileCount: 42 }));
          return;
        }
        response.writeHead(200, {
          "content-type": "application/vnd.git.bundle",
          "x-wfb-preview-source-repository": "PittampalliOrg/workflow-builder",
          "x-wfb-preview-source-revision": SOURCE_REVISION,
          "x-wfb-preview-source-sha256": bundleSha256,
          "x-wfb-preview-source-file-count": "42",
        });
        response.end(Buffer.from(bundle));
      }, use);
    };
    const token = vi.fn(async () => "github-installation-token");
    const gateway = new OneShotPreviewWorkspaceGitBundleGateway(
      { token },
      runHelper,
    );

    await expect(
      gateway.fetchExact({
        repository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_REVISION,
      }),
    ).resolves.toEqual({
      repository: "PittampalliOrg/workflow-builder",
      sourceRevision: SOURCE_REVISION,
      bundle,
      bundleSha256,
      fileCount: 42,
    });

    expect(token).toHaveBeenCalledOnce();
    expect(helperRequests).toHaveLength(1);
    expect(helperRequests[0]).toMatchObject({
      workspaceKey: null,
      purpose: "source",
      secretEnv: { GITHUB_TOKEN: "github-installation-token" },
    });
    expect(helperRequests[0]?.executionId).toMatch(
      /^preview-source-[0-9a-f]{32}$/,
    );
    expect(requests.map((request) => request.path)).toEqual([
      "/internal/preview-workspace/seed",
      "/internal/preview-workspace/source-bundle",
    ]);
    expect(JSON.parse(requests[0]!.body.toString("utf8"))).toEqual({
      repository: "PittampalliOrg/workflow-builder",
      sourceRevision: SOURCE_REVISION,
      repoSubdir: ".",
    });
    expect(requests[1]!.body.toString("utf8")).not.toContain(
      "github-installation-token",
    );
  });

  it("rejects invalid source coordinates before requesting a credential or helper", async () => {
    const token = vi.fn(async () => "github-installation-token");
    const runHelper = vi.fn();
    const gateway = new OneShotPreviewWorkspaceGitBundleGateway(
      { token },
      runHelper as never,
    );

    await expect(
      gateway.fetchExact({
        repository: "https://github.com/attacker/repo",
        sourceRevision: "main",
      }),
    ).rejects.toMatchObject({
      code: "source-rejected",
      status: 409,
    });
    expect(token).not.toHaveBeenCalled();
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("fails closed when the physical credential is unavailable", async () => {
    const runHelper = vi.fn();
    const gateway = new OneShotPreviewWorkspaceGitBundleGateway(
      { token: vi.fn(async () => "") },
      runHelper as never,
    );

    await expect(
      gateway.fetchExact({
        repository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_REVISION,
      }),
    ).rejects.toMatchObject({
      code: "source-unavailable",
      status: 503,
    });
    expect(runHelper).not.toHaveBeenCalled();
  });
});

describe("OneShotPreviewWorkspaceGateway seed", () => {
  it("imports an exact bundle into the preview helper without any credential", async () => {
    const helperRequests: HelperRequest[] = [];
    const requests: Array<{
      path: string;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }> = [];
    const bundle = new Uint8Array([9, 8, 7, 6]);
    const bundleSha256 = `sha256:${createHash("sha256")
      .update(bundle)
      .digest("hex")}` as const;
    const runHelper = async <T>(
      request: HelperRequest,
      use: (baseUrl: string) => Promise<T>,
    ) => {
      helperRequests.push(request);
      return await withHttpServer(async (incoming, response) => {
        const body = await readBody(incoming);
        requests.push({
          path: incoming.url ?? "",
          headers: incoming.headers,
          body,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ reused: false, fileCount: 42 }));
      }, use);
    };
    const gateway = new OneShotPreviewWorkspaceGateway(runHelper);

    await expect(
      gateway.seed({
        executionId: "exec-1",
        workspaceKey: "ws_script_exec-1",
        repository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_REVISION,
        repoSubdir: ".",
        sourceBundle: bundle,
        sourceBundleSha256: bundleSha256,
        sourceFileCount: 42,
      }),
    ).resolves.toEqual({ reused: false, fileCount: 42 });

    expect(helperRequests).toEqual([
      {
        executionId: "exec-1",
        workspaceKey: "ws_script_exec-1",
        purpose: "seed",
        secretEnv: null,
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/internal/preview-workspace/import");
    expect(requests[0]?.headers["content-type"]).toBe(
      "application/vnd.git.bundle",
    );
    expect(requests[0]?.headers["x-wfb-preview-source-repository"]).toBe(
      "PittampalliOrg/workflow-builder",
    );
    expect(requests[0]?.headers["x-wfb-preview-source-revision"]).toBe(
      SOURCE_REVISION,
    );
    expect(requests[0]?.headers["x-wfb-preview-source-sha256"]).toBe(
      bundleSha256,
    );
    expect(requests[0]?.headers["x-wfb-preview-source-file-count"]).toBe("42");
    expect(requests[0]?.body).toEqual(Buffer.from(bundle));
  });

  it("rejects a tampered bundle before provisioning a preview helper", async () => {
    const runHelper = vi.fn();
    const gateway = new OneShotPreviewWorkspaceGateway(runHelper as never);

    await expect(
      gateway.seed({
        executionId: "exec-1",
        workspaceKey: "ws_script_exec-1",
        repository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_REVISION,
        repoSubdir: ".",
        sourceBundle: new Uint8Array([1, 2, 3]),
        sourceBundleSha256: `sha256:${"f".repeat(64)}`,
        sourceFileCount: 42,
      }),
    ).rejects.toMatchObject({
      code: "source-rejected",
      status: 409,
    });
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("sanitizes a helper receipt whose file count differs from the physical receipt", async () => {
    const bundle = new Uint8Array([1, 2, 3]);
    const bundleSha256 = `sha256:${createHash("sha256")
      .update(bundle)
      .digest("hex")}` as const;
    const runHelper = async <T>(
      _request: HelperRequest,
      use: (baseUrl: string) => Promise<T>,
    ) =>
      await withHttpServer(async (incoming, response) => {
        await readBody(incoming);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ reused: false, fileCount: 41 }));
      }, use);
    const gateway = new OneShotPreviewWorkspaceGateway(runHelper);

    await expect(
      gateway.seed({
        executionId: "exec-1",
        workspaceKey: "ws_script_exec-1",
        repository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_REVISION,
        repoSubdir: ".",
        sourceBundle: bundle,
        sourceBundleSha256: bundleSha256,
        sourceFileCount: 42,
      }),
    ).rejects.toMatchObject({
      code: "helper-unavailable",
      status: 502,
      message: "preview workspace exact-revision seed failed",
      cause: expect.objectContaining({
        message: "preview workspace seed returned an invalid receipt",
      }),
    });
  });
});
