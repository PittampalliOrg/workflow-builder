import { createHash } from "node:crypto";
import {
  type PreviewAcceptanceArtifactPort,
  type PreviewAcceptanceArtifactSnapshot,
  type PreviewImportedArtifactLookup,
  type WorkflowArtifactRecord,
  type WorkflowFileRecord,
} from "$lib/server/application/ports";

type PreviewAcceptanceWorkflowData = {
  getWorkflowArtifactForExecution(input: {
    executionId: string;
    artifactId: string;
  }): Promise<WorkflowArtifactRecord | null>;
  getWorkflowFileContent(
    fileId: string,
  ): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null>;
};

function snapshot(
  artifact: WorkflowArtifactRecord,
): PreviewAcceptanceArtifactSnapshot {
  return {
    id: artifact.id,
    executionId: artifact.workflowExecutionId,
    kind: artifact.kind,
    fileId: artifact.fileId,
    inlinePayload: artifact.inlinePayload,
    metadata: artifact.metadata,
  };
}

export class WorkflowDataPreviewAcceptanceArtifactAdapter implements PreviewAcceptanceArtifactPort {
  constructor(
    private readonly workflowData: () => PreviewAcceptanceWorkflowData,
  ) {}

  async get(
    input: PreviewImportedArtifactLookup,
  ): Promise<PreviewAcceptanceArtifactSnapshot | null> {
    if (input.artifactId !== input.identity.sourceArtifactId) return null;
    const artifact = await this.workflowData().getWorkflowArtifactForExecution({
      executionId: input.identity.executionId,
      artifactId: input.identity.sourceArtifactId,
    });
    if (
      !artifact ||
      artifact.id !== input.identity.sourceArtifactId ||
      artifact.workflowExecutionId !== input.identity.executionId
    ) {
      return null;
    }
    return { ...snapshot(artifact), importIdentity: input.identity };
  }

  async fileDigest(
    input: PreviewImportedArtifactLookup & Readonly<{ fileId: string }>,
  ): Promise<`sha256:${string}` | null> {
    const artifact = await this.get(input);
    if (!artifact || artifact.fileId !== input.fileId) return null;
    const file = await this.workflowData().getWorkflowFileContent(input.fileId);
    if (!file) return null;
    return `sha256:${createHash("sha256").update(file.bytes).digest("hex")}`;
  }
}
