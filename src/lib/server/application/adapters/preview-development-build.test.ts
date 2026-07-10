import { describe, expect, it, vi } from "vitest";
import { TektonPreviewDevelopmentBuildAdapter } from "$lib/server/application/adapters/preview-development-build";
import { DEV_PREVIEW_CATALOG_DIGEST } from "$lib/server/workflows/dev-preview-registry";

const SOURCE_SHA = "a".repeat(40);

describe("TektonPreviewDevelopmentBuildAdapter", () => {
  it("submits one bounded catalog-derived PipelineRun and returns its digest", async () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const client = {
      create: vi.fn(async (_namespace, body, _options?: unknown) => ({
        created: true,
        pipelineRun: {
          ...body,
          metadata: { ...body.metadata, uid: "development-run-uid" },
        },
      })),
      get: vi.fn(async (_namespace, name, _options?: unknown) => ({
        metadata: {
          name,
          namespace: "tekton-pipelines",
          uid: "development-run-uid",
        },
        status: {
          conditions: [{ type: "Succeeded", status: "True" }],
          results: [
            {
              name: "image_ref",
              value: `ghcr.io/pittampalliorg/workflow-builder-dev:git-${SOURCE_SHA}`,
            },
            { name: "image_digest", value: digest },
          ],
        },
      })),
      listTasks: vi.fn(
        async (_namespace?: unknown, _name?: unknown, _options?: unknown) => [],
      ),
    };
    const adapter = new TektonPreviewDevelopmentBuildAdapter({
      client: client as never,
      sleep: vi.fn(async () => undefined),
    });

    await expect(
      adapter.build({
        requestId: "request-1",
        sourceRepository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_SHA as never,
        catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
        service: "workflow-builder",
      }),
    ).resolves.toEqual({
      service: "workflow-builder",
      sourceRevision: SOURCE_SHA,
      buildId: expect.stringMatching(/^preview-dev-workflow-builder-/),
      imageRef: `ghcr.io/pittampalliorg/workflow-builder-dev:git-${SOURCE_SHA}`,
      digest,
      immutableRef: `ghcr.io/pittampalliorg/workflow-builder-dev@${digest}`,
    });

    const manifest = client.create.mock.calls[0]?.[1] as {
      metadata: {
        labels: Record<string, string>;
        annotations: Record<string, string>;
      };
      spec: {
        pipelineRef: { name: string };
        timeouts: { pipeline: string };
        params: Array<{ name: string; value: string }>;
        workspaces: Array<Record<string, unknown>>;
        taskRunTemplate: {
          serviceAccountName: string;
          podTemplate: { hostUsers: boolean };
        };
      };
    };
    expect(manifest.metadata).toMatchObject({
      labels: {
        "stacks.io/build-loop": "preview-development",
        "stacks.io/image-name": "workflow-builder",
        "preview.stacks.io/source-revision": SOURCE_SHA,
      },
      annotations: {
        "preview.stacks.io/request-id": "request-1",
        "preview.stacks.io/catalog-digest": DEV_PREVIEW_CATALOG_DIGEST,
      },
    });
    expect(manifest.spec.pipelineRef).toEqual({
      name: "preview-development-build",
    });
    expect(manifest.spec.timeouts).toEqual({ pipeline: "45m0s" });
    expect(manifest.spec.params).toEqual([
      { name: "source_revision", value: SOURCE_SHA },
      { name: "service", value: "workflow-builder" },
      {
        name: "image",
        value: "ghcr.io/pittampalliorg/workflow-builder-dev",
      },
      {
        name: "dockerfile",
        value: "skaffold/dev/workflow-builder/Dockerfile.dev",
      },
      { name: "context", value: "." },
    ]);
    expect(manifest.spec.workspaces).toEqual([
      { name: "shared-workspace", emptyDir: {} },
      {
        name: "dockerconfig",
        secret: { secretName: "ghcr-push-credentials" },
      },
    ]);
    expect(manifest.spec.taskRunTemplate.serviceAccountName).toBe(
      "preview-development-build-executor",
    );
    expect(manifest.spec.taskRunTemplate.podTemplate.hostUsers).toBe(false);
    for (const call of [
      client.create.mock.calls[0],
      client.get.mock.calls[0],
      client.listTasks.mock.calls[0],
    ]) {
      expect(call?.[2]).toEqual({
        targetCluster: "hub-preview-development",
      });
    }
  });

  it("rejects repository, catalog, revision, service, and digest drift", async () => {
    const client = {
      create: vi.fn(async (_namespace, body, _options?: unknown) => ({
        created: true,
        pipelineRun: {
          ...body,
          metadata: { ...body.metadata, uid: "development-run-uid" },
        },
      })),
      get: vi.fn(async (_namespace, name, _options?: unknown) => ({
        metadata: {
          name,
          namespace: "tekton-pipelines",
          uid: "development-run-uid",
        },
        status: {
          conditions: [{ type: "Succeeded", status: "True" }],
          results: [
            {
              name: "image_ref",
              value: `ghcr.io/pittampalliorg/workflow-builder-dev:git-${SOURCE_SHA}`,
            },
            { name: "image_digest", value: "mutable" },
          ],
        },
      })),
      listTasks: vi.fn(
        async (_namespace?: unknown, _name?: unknown, _options?: unknown) => [],
      ),
    };
    const adapter = new TektonPreviewDevelopmentBuildAdapter({
      client: client as never,
      sleep: vi.fn(async () => undefined),
    });
    const valid = {
      requestId: "request-1",
      sourceRepository: "PittampalliOrg/workflow-builder",
      sourceRevision: SOURCE_SHA as never,
      catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
      service: "workflow-builder",
    };

    await expect(
      adapter.build({ ...valid, sourceRepository: "attacker/repo" }),
    ).rejects.toThrow("restricted to PittampalliOrg/workflow-builder");
    await expect(
      adapter.build({
        ...valid,
        catalogDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toThrow("catalog digest is not current");
    await expect(
      adapter.build({ ...valid, sourceRevision: "main" as never }),
    ).rejects.toThrow("full Git SHA");
    await expect(
      adapter.build({ ...valid, service: "swebench-coordinator" }),
    ).rejects.toThrow("unsupported preview-native service");
    await expect(adapter.build(valid)).rejects.toThrow(
      "returned no immutable digest",
    );
  });

  it("adopts the deterministic existing PipelineRun after a create conflict", async () => {
    const digest = `sha256:${"9".repeat(64)}`;
    const client = {
      create: vi.fn(async (_namespace, body) => ({
        created: false,
        pipelineRun: {
          ...body,
          metadata: { ...body.metadata, uid: "existing-run-uid" },
        },
      })),
      get: vi.fn(async (_namespace, name) => ({
        metadata: {
          name,
          namespace: "tekton-pipelines",
          uid: "existing-run-uid",
        },
        status: {
          conditions: [{ type: "Succeeded", status: "True" }],
          results: [
            {
              name: "image_ref",
              value: `ghcr.io/pittampalliorg/function-router-dev:git-${SOURCE_SHA}`,
            },
            { name: "image_digest", value: digest },
          ],
        },
      })),
      listTasks: vi.fn(async () => []),
    };
    const adapter = new TektonPreviewDevelopmentBuildAdapter({
      client: client as never,
      sleep: vi.fn(async () => undefined),
    });
    const request = {
      requestId: `preview-development:preview1:${SOURCE_SHA}:function-router`,
      sourceRepository: "PittampalliOrg/workflow-builder",
      sourceRevision: SOURCE_SHA as never,
      catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
      service: "function-router",
    };

    const first = await adapter.build(request);
    const second = await adapter.build(request);
    expect(first.buildId).toBe(second.buildId);
    expect(client.create).toHaveBeenCalledTimes(2);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it("rejects a hostile pre-created run returned by an injected Tekton client", async () => {
    const client = {
      create: vi.fn(async (_namespace, body) => ({
        created: false,
        pipelineRun: {
          ...body,
          metadata: { ...body.metadata, uid: "attacker-run-uid" },
          spec: {
            ...body.spec,
            pipelineRef: { name: "attacker-pipeline" },
          },
        },
      })),
      get: vi.fn(),
      listTasks: vi.fn(),
    };
    const adapter = new TektonPreviewDevelopmentBuildAdapter({
      client: client as never,
      sleep: vi.fn(async () => undefined),
    });

    await expect(
      adapter.build({
        requestId: "request-hostile",
        sourceRepository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_SHA as never,
        catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
        service: "workflow-builder",
      }),
    ).rejects.toThrow("conflicts with a different canonical request");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("ignores result-bearing TaskRuns without the exact PipelineRun owner UID", async () => {
    const digest = `sha256:${"8".repeat(64)}`;
    const client = {
      create: vi.fn(async (_namespace, body) => ({
        created: true,
        pipelineRun: {
          ...body,
          metadata: { ...body.metadata, uid: "development-run-uid" },
        },
      })),
      get: vi.fn(async (_namespace, name) => ({
        metadata: {
          name,
          namespace: "tekton-pipelines",
          uid: "development-run-uid",
        },
        status: {
          conditions: [{ type: "Succeeded", status: "True" }],
          results: [
            {
              name: "image_ref",
              value: `ghcr.io/pittampalliorg/workflow-builder-dev:git-${SOURCE_SHA}`,
            },
          ],
        },
      })),
      listTasks: vi.fn(async (_namespace, name) => [
        {
          metadata: {
            ownerReferences: [
              {
                apiVersion: "tekton.dev/v1",
                kind: "PipelineRun",
                name,
                uid: "attacker-run-uid",
                controller: true,
              },
            ],
          },
          status: { results: [{ name: "image_digest", value: digest }] },
        },
      ]),
    };
    const adapter = new TektonPreviewDevelopmentBuildAdapter({
      client: client as never,
      sleep: vi.fn(async () => undefined),
    });

    await expect(
      adapter.build({
        requestId: "request-owner-proof",
        sourceRepository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_SHA as never,
        catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
        service: "workflow-builder",
      }),
    ).rejects.toThrow("returned no immutable digest");
  });
});
