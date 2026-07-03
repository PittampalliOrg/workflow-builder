import type {
  SourceBundlePromotionGatePort,
  WorkflowArtifactRecord,
  WorkflowDataService,
} from "$lib/server/application/ports";

export type WorkflowCodeVersionListInput = {
  executionId: string;
  userId: string;
  projectId?: string | null;
};

export type WorkflowCodeVersionReadModel = {
  artifactId: string;
  executionId: string;
  nodeId: string | null;
  fileId: string | null;
  sizeBytes: number | null;
  title: string;
  payload: unknown;
  promotionGate: ReturnType<
    SourceBundlePromotionGatePort["evaluatePromotionGate"]
  >;
  promotion: unknown;
  createdAt: string;
};

export type WorkflowCodeVersionListResult =
  | {
      status: "ok";
      body: {
        versions: WorkflowCodeVersionReadModel[];
        outstanding: boolean;
      };
    }
  | { status: "error"; httpStatus: number; message: string };

const SOURCE_BUNDLE_KIND = "source-bundle";

export class ApplicationWorkflowCodeVersionService {
  constructor(
    private readonly deps: {
      workflowData: Pick<
        WorkflowDataService,
        "getScopedExecutionById" | "listWorkflowArtifactsByExecutionId"
      >;
      promotionGate: SourceBundlePromotionGatePort;
    },
  ) {}

  async listVersions(
    input: WorkflowCodeVersionListInput,
  ): Promise<WorkflowCodeVersionListResult> {
    const execution = await this.deps.workflowData.getScopedExecutionById({
      executionId: input.executionId,
      userId: input.userId,
      projectId: input.projectId ?? null,
    });
    if (!execution) {
      return {
        status: "error",
        httpStatus: 404,
        message: "Execution not found",
      };
    }

    const versions = (
      await this.deps.workflowData.listWorkflowArtifactsByExecutionId(
        input.executionId,
      )
    )
      .filter((artifact) => artifact.kind === SOURCE_BUNDLE_KIND)
      .map((artifact) =>
        this.toReadModel(artifact, execution.output, execution.summaryOutput),
      );

    return {
      status: "ok",
      body: {
        versions,
        outstanding:
          versions.length > 0 &&
          versions.every((version) => !version.promotion),
      },
    };
  }

  private toReadModel(
    artifact: WorkflowArtifactRecord,
    executionOutput: unknown,
    summaryOutput: Record<string, unknown> | null,
  ): WorkflowCodeVersionReadModel {
    return {
      artifactId: artifact.id,
      executionId: artifact.workflowExecutionId,
      nodeId: artifact.nodeId,
      fileId: artifact.fileId,
      sizeBytes: artifact.sizeBytes,
      title: artifact.title,
      payload: artifact.inlinePayload,
      promotionGate: this.deps.promotionGate.evaluatePromotionGate({
        mode: "pr",
        artifactPayload: asRecord(artifact.inlinePayload),
        executionOutput,
        summaryOutput,
      }),
      promotion: artifact.metadata?.promotion ?? null,
      createdAt: artifact.createdAt.toISOString(),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
