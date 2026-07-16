import type { PreviewDevelopmentTarget } from "./preview-target-development";
import type {
  VclusterPreviewCleanupSnapshot,
  VclusterPreviewRecord,
  VclusterPreviewTeardownTicket,
} from "$lib/types/dev-previews";

export type PreviewDevelopmentEnvironmentLaunchInput = Readonly<{
  environmentName: string;
  services: readonly string[];
  ttlHours: number;
  retainAfterCompletion: boolean;
}>;

export type PreviewDevelopmentEnvironmentLaunchResult = Readonly<{
  kind: "launch-environment";
  operationId: string;
  target: PreviewDevelopmentTarget;
  phase: string;
  ready: boolean;
  url: string | null;
  reused: boolean;
}>;

export type PreviewDevelopmentEnvironmentStatusResult = Readonly<{
  kind: "get-environment-status";
  operationId: string;
  target: PreviewDevelopmentTarget;
  phase: string;
  ready: boolean;
  url: string | null;
}>;

export type PreviewDevelopmentEnvironmentTeardownResult = Readonly<{
  kind: "teardown-environment";
  operationId: string;
  target: PreviewDevelopmentTarget;
  phase: string;
  ticket: VclusterPreviewTeardownTicket | null;
  complete: boolean;
}>;

export type PreviewDevelopmentEnvironmentTeardownStatusResult = Readonly<{
  kind: "get-environment-teardown-status";
  operationId: string;
  target: PreviewDevelopmentTarget;
  ticket: VclusterPreviewTeardownTicket;
  cleanup: VclusterPreviewCleanupSnapshot;
  complete: boolean;
}>;

/** Narrow application-to-application teardown seam; cluster access stays behind it. */
export interface PreviewDevelopmentEnvironmentTeardownPort {
  teardown(
    input: Readonly<{
      name: string;
      actorUserId: string;
      expectedRequestId: string;
      expectedSourceRevision: string;
      projectId?: string | null;
      discardUnarchived?: boolean;
    }>,
  ): Promise<
    Readonly<{
      preview: VclusterPreviewRecord;
      ticket: VclusterPreviewTeardownTicket | null;
    }>
  >;
}

/** Host-side lifecycle boundary used only by the durable parent workflow. */
export interface PreviewDevelopmentEnvironmentPort {
  launchEnvironment(
    input: Readonly<{
      parentExecutionId: string;
      operationId: string;
      launch: PreviewDevelopmentEnvironmentLaunchInput;
    }>,
  ): Promise<PreviewDevelopmentEnvironmentLaunchResult>;

  getEnvironmentStatus(
    input: Readonly<{
      parentExecutionId: string;
      operationId: string;
      target: PreviewDevelopmentTarget;
    }>,
  ): Promise<PreviewDevelopmentEnvironmentStatusResult>;

  teardownEnvironment(
    input: Readonly<{
      parentExecutionId: string;
      operationId: string;
      target: PreviewDevelopmentTarget;
    }>,
  ): Promise<PreviewDevelopmentEnvironmentTeardownResult>;

  getEnvironmentTeardownStatus(
    input: Readonly<{
      parentExecutionId: string;
      operationId: string;
      target: PreviewDevelopmentTarget;
      ticket: VclusterPreviewTeardownTicket;
    }>,
  ): Promise<PreviewDevelopmentEnvironmentTeardownStatusResult>;
}
