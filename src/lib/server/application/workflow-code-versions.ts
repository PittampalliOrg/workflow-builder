import type {
  SourceBundlePromotionGatePort,
  WorkflowArtifactRecord,
  WorkflowDataService,
} from "$lib/server/application/ports";
import {
  compareWorkflowArtifactChronology,
  latestWorkflowArtifact,
} from "$lib/server/application/workflow-code-version-order";

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
  acceptance: unknown;
  createdAt: string;
};

export type WorkflowCodeVersionListResult =
  | {
      status: "ok";
      body: {
        versions: WorkflowCodeVersionReadModel[];
        outstanding: boolean;
        unpromotedCount: number;
        canManageStrictCheckpoints: boolean;
        latestStrictArtifactId: string | null;
      };
    }
  | { status: "error"; httpStatus: number; message: string };

const SOURCE_BUNDLE_KIND = "source-bundle";

export class ApplicationWorkflowCodeVersionService {
  constructor(
    private readonly deps: {
      workflowData: Pick<
        WorkflowDataService,
        | "getScopedExecutionById"
        | "listWorkflowArtifactsByExecutionId"
        | "isPlatformAdmin"
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

    const [artifacts, canManageStrictCheckpoints] = await Promise.all([
      this.deps.workflowData.listWorkflowArtifactsByExecutionId(
        input.executionId,
      ),
      this.deps.workflowData.isPlatformAdmin(input.userId),
    ]);
    const sourceArtifacts = artifacts
      .filter((artifact) => artifact.kind === SOURCE_BUNDLE_KIND)
      .sort(compareWorkflowArtifactChronology);
    const latestStrictArtifactId =
      latestWorkflowArtifact(sourceArtifacts, (artifact) =>
        isStrictAtomicSnapshot(artifact.inlinePayload),
      )?.id ?? null;
    const versions = sourceArtifacts.map((artifact) =>
      this.toReadModel(artifact, execution.output, execution.summaryOutput),
    );

    const unpromotedCount = countUnpromotedVersions(
      versions,
      latestStrictArtifactId,
    );

    return {
      status: "ok",
      body: {
        versions,
        outstanding: unpromotedCount > 0,
        unpromotedCount,
        canManageStrictCheckpoints,
        latestStrictArtifactId,
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
      acceptance: artifact.metadata?.acceptance ?? null,
      createdAt: artifact.createdAt.toISOString(),
    };
  }
}

/** Strict atomic captures are whole-state snapshots; only the newest can be debt. */
function countUnpromotedVersions(
  versions: readonly WorkflowCodeVersionReadModel[],
  latestStrictArtifactId: string | null,
): number {
  let unpromotedCount = 0;

  for (const version of versions) {
    if (isStrictAtomicSnapshot(version.payload)) {
      if (
        version.artifactId === latestStrictArtifactId &&
        !hasPullRequest(version.promotion)
      ) {
        unpromotedCount += 1;
      }
    } else if (!hasPullRequest(version.promotion)) {
      unpromotedCount += 1;
    }
  }
  return unpromotedCount;
}

function isStrictAtomicSnapshot(value: unknown): boolean {
  const payload = asRecord(value);
  return (
    payload.tier === "tar-overlay-set" &&
    (payload.captureProtocol === "atomic-generation-v2" ||
      payload.acceptanceEligible === true)
  );
}

function hasPullRequest(value: unknown): boolean {
  const promotion = asRecord(value);
  if (typeof promotion.prUrl === "string" && promotion.prUrl.trim()) return true;
  const pullRequest = asRecord(promotion.pullRequest);
  const repository =
    typeof promotion.repository === "string"
      ? promotion.repository
      : pullRequest.repository;
  const number =
    typeof promotion.pullRequestNumber === "number"
      ? promotion.pullRequestNumber
      : pullRequest.number;
  return (
    typeof repository === "string" &&
    Boolean(repository.trim()) &&
    typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number > 0
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
