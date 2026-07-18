import type { WorkflowExecutionStatus } from "./executions";
import type { ImmutableGitSha } from "./preview-environments";

export const PREVIEW_DEVELOPMENT_WORKFLOW_ID =
	"preview-ui-development-gan" as const;
export const PREVIEW_DEVELOPMENT_WORKFLOW_NAME =
	PREVIEW_DEVELOPMENT_WORKFLOW_ID;

export type PreviewDevelopmentControlAction = "submit_preview_pr" | "discard";

/** Exact PreviewEnvironment generation. No network location crosses this port. */
export type PreviewDevelopmentTarget = Readonly<{
  previewName: string;
  environmentRequestId: string;
  platformRevision: string;
  sourceRevision: string;
  catalogDigest: `sha256:${string}`;
}>;

/** User-authored fields accepted by the preview development workflow. */
export type PreviewDevelopmentWorkflowInput = Readonly<{
  intent: string;
  services: readonly string[];
  agentSlug?: string;
  keepPreview?: boolean | string;
  /** Additive child controls: forwarded when present, never defaulted here. */
  ttlHours?: number;
  retainAfterCompletion?: boolean | string;
  interactiveHandoff?: boolean | string;
  impactReview?: boolean | string;
  diffScope?: readonly string[];
  maxIterations?: number;
}>;

export type PreviewDevelopmentWorkflowReceipt = Readonly<{
  executionId: string;
  workflowName: typeof PREVIEW_DEVELOPMENT_WORKFLOW_NAME;
  workflowSpecDigest: `sha256:${string}`;
}>;

export type PreviewDevelopmentStartResult = PreviewDevelopmentWorkflowReceipt &
  Readonly<{
    kind: "start-workflow";
    operationId: string;
    target: PreviewDevelopmentTarget;
    instanceId: string | null;
    status: "running";
    reused: boolean;
  }>;

export type PreviewDevelopmentTerminalOutcome =
  | "submitted"
  | "discarded"
  | "timed_out"
  | "invalid_control"
  | "snapshot_failed"
  | "promotion_failed";

export type PreviewDevelopmentCanonicalPromotionReceipt = Readonly<{
  ok: true;
  receiptId: string;
  previewName: string;
  requestId: string;
  executionId: string;
  services: readonly string[];
  branch: string;
  commitSha: string;
  prUrl: string;
  pullRequest: Readonly<{
    repository: "PittampalliOrg/workflow-builder";
    number: number;
    baseSha: string;
    headSha: string;
  }>;
  draft: true;
}>;

export type PreviewDevelopmentTerminalOutput = Readonly<{
  controlOutcome: PreviewDevelopmentTerminalOutcome;
  pullRequestReceipt: PreviewDevelopmentCanonicalPromotionReceipt | null;
}>;

export type PreviewDevelopmentStatusResult = PreviewDevelopmentWorkflowReceipt &
  Readonly<{
    kind: "get-workflow-status";
    operationId: string;
    target: PreviewDevelopmentTarget;
    status: WorkflowExecutionStatus;
    phase: string | null;
    progress: number | null;
    currentNodeId: string | null;
    controlReady: boolean;
    sessionId: string | null;
    sessionUrl: string | null;
    error: string | null;
    /** Bounded allowlisted terminal receipt; raw child output never crosses clusters. */
    output: PreviewDevelopmentTerminalOutput | null;
    terminal: boolean;
  }>;

export type PreviewDevelopmentSignalResult = PreviewDevelopmentWorkflowReceipt &
  Readonly<{
    kind: "signal-workflow";
    operationId: string;
    target: PreviewDevelopmentTarget;
    action: PreviewDevelopmentControlAction;
    accepted: true;
  }>;

export type PreviewDevelopmentPromotionVerificationResult = Readonly<{
  kind: "verify-promotion";
  operationId: string;
  target: PreviewDevelopmentTarget;
  executionId: string;
  verified: true;
  receipt: Readonly<{
    ok: true;
    receiptId: string;
    previewName: string;
    requestId: string;
    executionId: string;
    artifactId: string;
    services: readonly string[];
    branch: string;
    commitSha: ImmutableGitSha;
    prUrl: string;
    pullRequest: Readonly<{
      repository: "PittampalliOrg/workflow-builder";
      number: number;
      baseSha: ImmutableGitSha;
      headSha: ImmutableGitSha;
    }>;
    draft: true;
  }>;
}>;

/** Inbound application port used by the host lifecycle workflow. */
export interface PreviewTargetDevelopmentPort {
  startWorkflow(
    input: Readonly<{
      parentExecutionId: string;
      operationId: string;
      target: PreviewDevelopmentTarget;
      workflowInput: PreviewDevelopmentWorkflowInput;
    }>,
  ): Promise<PreviewDevelopmentStartResult>;

  getWorkflowStatus(
    input: Readonly<{
      parentExecutionId: string;
      operationId: string;
      target: PreviewDevelopmentTarget;
      workflow: PreviewDevelopmentWorkflowReceipt;
    }>,
  ): Promise<PreviewDevelopmentStatusResult>;

  signalWorkflow(
    input: Readonly<{
      parentExecutionId: string;
      operationId: string;
      target: PreviewDevelopmentTarget;
      workflow: PreviewDevelopmentWorkflowReceipt;
      action: PreviewDevelopmentControlAction;
    }>,
  ): Promise<PreviewDevelopmentSignalResult>;

  verifyPromotion(
    input: Readonly<{
      parentExecutionId: string;
      operationId: string;
      target: PreviewDevelopmentTarget;
      childExecutionId: string;
      receiptId: string;
      services: readonly string[];
    }>,
  ): Promise<PreviewDevelopmentPromotionVerificationResult>;
}

/** Trusted host-to-physical-broker boundary. actorUserId is resolved server-side. */
export interface PreviewTargetDevelopmentBrokerPort {
  startWorkflow(
    input: PreviewDevelopmentBrokerStartInput,
  ): Promise<PreviewDevelopmentStartResult>;
  getWorkflowStatus(
    input: PreviewDevelopmentBrokerStatusInput,
  ): Promise<PreviewDevelopmentStatusResult>;
  signalWorkflow(
    input: PreviewDevelopmentBrokerSignalInput,
  ): Promise<PreviewDevelopmentSignalResult>;
  verifyPromotion(
    input: PreviewDevelopmentBrokerVerifyPromotionInput,
  ): Promise<PreviewDevelopmentPromotionVerificationResult>;
}

/** Preview-local commands. Physical receipt verification is deliberately absent. */
export interface PreviewTargetDevelopmentLocalPort {
  startWorkflow(
    input: PreviewDevelopmentBrokerStartInput,
  ): Promise<PreviewDevelopmentStartResult>;
  getWorkflowStatus(
    input: PreviewDevelopmentBrokerStatusInput,
  ): Promise<PreviewDevelopmentStatusResult>;
  signalWorkflow(
    input: PreviewDevelopmentBrokerSignalInput,
  ): Promise<PreviewDevelopmentSignalResult>;
}

export type PreviewDevelopmentBrokerBase = Readonly<{
  parentExecutionId: string;
  actorUserId: string;
  target: PreviewDevelopmentTarget;
  workflow: PreviewDevelopmentWorkflowReceipt;
  operationId: string;
}>;

export type PreviewDevelopmentBrokerStartInput = PreviewDevelopmentBrokerBase &
  Readonly<{
    workflowInput: PreviewDevelopmentWorkflowInput;
  }>;

export type PreviewDevelopmentBrokerStatusInput = PreviewDevelopmentBrokerBase;

export type PreviewDevelopmentBrokerSignalInput = PreviewDevelopmentBrokerBase &
  Readonly<{ action: PreviewDevelopmentControlAction }>;

export type PreviewDevelopmentBrokerVerifyPromotionInput = Readonly<{
  parentExecutionId: string;
  actorUserId: string;
  operationId: string;
  target: PreviewDevelopmentTarget;
  childExecutionId: string;
  receiptId: string;
  services: readonly string[];
}>;

/** Physical-broker transport to the capability-authenticated preview-local BFF. */
export interface PreviewTargetDevelopmentLeafTransportPort {
  startWorkflow(
    input: PreviewDevelopmentBrokerStartInput &
      Readonly<{ targetUrl: string | null; capability: string }>,
  ): Promise<PreviewDevelopmentStartResult>;
  getWorkflowStatus(
    input: PreviewDevelopmentBrokerStatusInput &
      Readonly<{ targetUrl: string | null; capability: string }>,
  ): Promise<PreviewDevelopmentStatusResult>;
  signalWorkflow(
    input: PreviewDevelopmentBrokerSignalInput &
      Readonly<{ targetUrl: string | null; capability: string }>,
  ): Promise<PreviewDevelopmentSignalResult>;
}
