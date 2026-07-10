import { describe, expect, it, vi } from "vitest";
import { WorkflowDataPreviewAcceptanceArtifactAdapter } from "$lib/server/application/adapters/preview-acceptance-trust";

describe("WorkflowDataPreviewAcceptanceArtifactAdapter", () => {
  it("reads one execution-bound artifact and computes its immutable byte digest", async () => {
    const artifact = {
      id: "artifact-1",
      workflowExecutionId: "exec-1",
      nodeId: "dev-preview",
      slot: "aux" as const,
      kind: "source-bundle",
      title: "Source bundle",
      description: null,
      inlinePayload: { captureProtocol: "atomic-generation-v2" },
      fileId: "file-1",
      contentType: "application/gzip",
      sizeBytes: 7,
      metadata: null,
      createdAt: new Date("2026-07-09T20:00:00.000Z"),
    };
    const workflowData = {
      getWorkflowArtifactForExecution: vi.fn(async () => artifact),
      getWorkflowFileContent: vi.fn(async () => ({
        summary: {
          id: "file-1",
          name: "capture.gz",
          purpose: "output" as const,
          scopeId: "exec-1",
          contentType: "application/gzip",
          sizeBytes: 7,
          sha1: null,
          createdAt: "2026-07-09T20:00:00.000Z",
          archivedAt: null,
        },
        bytes: Buffer.from("capture"),
      })),
    };
    const adapter = new WorkflowDataPreviewAcceptanceArtifactAdapter(
      () => workflowData,
    );
    const lookup = {
      artifactId: "artifact-1",
      identity: {
        previewName: "preview-one",
        requestId: "launch-1",
        executionId: "exec-1",
        sourceArtifactId: "artifact-1",
        platformRevision: "a".repeat(40),
        sourceRevision: "b".repeat(40),
        catalogDigest: `sha256:${"c".repeat(64)}` as const,
        services: ["workflow-builder"],
        captureId: "capture-1",
        generation: "generation-1",
        fileDigest: `sha256:${"d".repeat(64)}` as const,
      },
    };

    await expect(adapter.get(lookup)).resolves.toMatchObject({
      id: "artifact-1",
      executionId: "exec-1",
      fileId: "file-1",
    });
    await expect(
      adapter.fileDigest({ ...lookup, fileId: "file-1" }),
    ).resolves.toBe(
      "sha256:460ee6aa3a80359181b794cc31a7185addba77626e9f719c10e3c8efb8668a1d",
    );
    await expect(
      adapter.fileDigest({
        ...lookup,
        identity: { ...lookup.identity, executionId: "exec-other" },
        fileId: "file-1",
      }),
    ).resolves.toBeNull();
    expect(workflowData.getWorkflowFileContent).toHaveBeenCalledOnce();
  });
});
