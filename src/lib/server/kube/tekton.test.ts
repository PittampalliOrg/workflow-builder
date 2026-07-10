import { afterEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  local: vi.fn(),
  remote: vi.fn(),
}));

vi.mock("./client", () => ({
  kubeApiFetch: clientMocks.local,
  kubeApiFetchFromKubeconfig: clientMocks.remote,
}));

import {
  createTektonPipelineRun,
  configuredHubTektonKubeconfig,
  hasConfiguredHubTektonKubeconfig,
  tektonTaskRunOwnedByPipelineRun,
  type TektonPipelineRun,
} from "./tekton";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const requestedRun: TektonPipelineRun = {
  apiVersion: "tekton.dev/v1",
  kind: "PipelineRun",
  metadata: {
    name: "preview-build-1",
    namespace: "tekton-pipelines",
    labels: {
      "stacks.io/build-loop": "preview-development",
      "preview.stacks.io/source-revision": "a".repeat(40),
    },
    annotations: { "preview.stacks.io/request-id": "request-1" },
  },
  spec: {
    pipelineRef: { name: "preview-development-build" },
    params: [{ name: "source_revision", value: "a".repeat(40) }],
  },
};

describe("Tekton hub credential profiles", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clientMocks.local.mockReset();
    clientMocks.remote.mockReset();
  });

  it("keeps the preview acceptance credential separate from the broad hub profile", () => {
    vi.stubEnv(
      "SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG",
      "/var/run/workflow-builder/hub-kubeconfig/kubeconfig",
    );
    vi.stubEnv(
      "PREVIEW_ACCEPTANCE_HUB_KUBECONFIG",
      "/var/run/workflow-builder/preview-acceptance-hub-kubeconfig/kubeconfig",
    );

    expect(configuredHubTektonKubeconfig("hub").path).toBe(
      "/var/run/workflow-builder/hub-kubeconfig/kubeconfig",
    );
    expect(configuredHubTektonKubeconfig("hub-preview-acceptance").path).toBe(
      "/var/run/workflow-builder/preview-acceptance-hub-kubeconfig/kubeconfig",
    );
    expect(hasConfiguredHubTektonKubeconfig()).toBe(true);
  });

  it("does not fall back to a broader hub credential for acceptance builds", () => {
    vi.stubEnv(
      "SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG",
      "/var/run/workflow-builder/hub-kubeconfig/kubeconfig",
    );
    vi.stubEnv("PREVIEW_ACCEPTANCE_HUB_KUBECONFIG", "");
    vi.stubEnv("PREVIEW_ACCEPTANCE_HUB_KUBECONFIG_PATH", "");
    vi.stubEnv("PREVIEW_ACCEPTANCE_HUB_KUBECONFIG_CONTENT", "");
    vi.stubEnv("PREVIEW_ACCEPTANCE_HUB_KUBECONFIG_YAML", "");

    expect(
      configuredHubTektonKubeconfig("hub-preview-acceptance"),
    ).toMatchObject({ path: null, content: null });
  });

  it("uses a distinct development credential profile", () => {
    vi.stubEnv(
      "PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_PATH",
      "/var/run/workflow-builder/preview-development/kubeconfig",
    );
    vi.stubEnv(
      "PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_YAML",
      "apiVersion: v1\nclusters: []",
    );
    vi.stubEnv(
      "PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_CONTEXT",
      "preview-development",
    );

    expect(configuredHubTektonKubeconfig("hub-preview-development")).toEqual({
      path: "/var/run/workflow-builder/preview-development/kubeconfig",
      content: "apiVersion: v1\nclusters: []",
      context: "preview-development",
    });
  });

  it("does not fall back to broad or acceptance credentials for development builds", () => {
    vi.stubEnv(
      "SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG",
      "/var/run/workflow-builder/broad-hub/kubeconfig",
    );
    vi.stubEnv(
      "PREVIEW_ACCEPTANCE_HUB_KUBECONFIG",
      "/var/run/workflow-builder/acceptance/kubeconfig",
    );
    for (const key of [
      "PREVIEW_DEVELOPMENT_HUB_KUBECONFIG",
      "PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_PATH",
      "PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_CONTENT",
      "PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_YAML",
      "PREVIEW_DEVELOPMENT_HUB_KUBECONFIG_CONTEXT",
    ]) {
      vi.stubEnv(key, "");
    }

    expect(configuredHubTektonKubeconfig("hub-preview-development")).toEqual({
      path: null,
      content: null,
      context: null,
    });
  });
});

describe("Tekton PipelineRun ownership", () => {
  afterEach(() => {
    clientMocks.local.mockReset();
    clientMocks.remote.mockReset();
  });

  it("fetches and adopts an exact UID-bound PipelineRun after a create conflict", async () => {
    const existing = {
      ...requestedRun,
      metadata: { ...requestedRun.metadata, uid: "pipeline-run-uid" },
    };
    clientMocks.local
      .mockResolvedValueOnce(jsonResponse({}, 409))
      .mockResolvedValueOnce(jsonResponse(existing));

    await expect(
      createTektonPipelineRun("tekton-pipelines", requestedRun),
    ).resolves.toEqual({ created: false, pipelineRun: existing });
    expect(clientMocks.local.mock.calls.map((call) => call[0])).toEqual([
      "/apis/tekton.dev/v1/namespaces/tekton-pipelines/pipelineruns",
      "/apis/tekton.dev/v1/namespaces/tekton-pipelines/pipelineruns/preview-build-1",
    ]);
  });

  it.each([
    [
      "spec",
      {
        ...requestedRun,
        metadata: { ...requestedRun.metadata, uid: "attacker-uid" },
        spec: {
          ...requestedRun.spec,
          params: [{ name: "source_revision", value: "b".repeat(40) }],
        },
      },
    ],
    [
      "metadata",
      {
        ...requestedRun,
        metadata: {
          ...requestedRun.metadata,
          uid: "attacker-uid",
          annotations: { "preview.stacks.io/request-id": "attacker" },
        },
      },
    ],
  ])(
    "rejects a hostile pre-created PipelineRun with changed %s",
    async (_field, existing) => {
      clientMocks.local
        .mockResolvedValueOnce(jsonResponse({}, 409))
        .mockResolvedValueOnce(jsonResponse(existing));

      await expect(
        createTektonPipelineRun("tekton-pipelines", requestedRun),
      ).rejects.toThrow("conflicts with a different canonical request");
    },
  );

  it("accepts TaskRun results only from the controller owner UID", () => {
    const pipelineRun = {
      ...requestedRun,
      metadata: { ...requestedRun.metadata, uid: "pipeline-run-uid" },
    };
    const taskRun = {
      metadata: {
        ownerReferences: [
          {
            apiVersion: "tekton.dev/v1",
            kind: "PipelineRun",
            name: "preview-build-1",
            uid: "pipeline-run-uid",
            controller: true,
          },
        ],
      },
    };

    expect(tektonTaskRunOwnedByPipelineRun(taskRun, pipelineRun)).toBe(true);
    expect(
      tektonTaskRunOwnedByPipelineRun(
        {
          metadata: {
            ...taskRun.metadata,
            ownerReferences: [
              { ...taskRun.metadata.ownerReferences[0], uid: "attacker-uid" },
            ],
          },
        },
        pipelineRun,
      ),
    ).toBe(false);
  });
});
