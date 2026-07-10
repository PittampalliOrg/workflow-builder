import type { PreviewControlIdentity } from "./preview-control";
import type {
  PreviewArtifactSummary,
  PreviewExecutionSummary,
  PreviewReadResult,
  PreviewRunTarget,
} from "./observability";

export type PreviewReadBrokerCommand =
  | Readonly<{ kind: "list-executions"; limit: number; status: string | null }>
  | Readonly<{ kind: "get-execution"; executionId: string }>
  | Readonly<{
      kind: "list-artifacts";
      executionId: string;
      artifactKind: string | null;
    }>
  | Readonly<{ kind: "fetch-file"; fileId: string; maxBytes: number }>;

export type PreviewReadBrokerResult =
  | Readonly<{
      kind: "list-executions";
      result: PreviewReadResult<{
        executions: PreviewExecutionSummary[];
        total: number;
      }>;
    }>
  | Readonly<{
      kind: "get-execution";
      result: PreviewReadResult<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: "list-artifacts";
      result: PreviewReadResult<PreviewArtifactSummary[]>;
    }>
  | Readonly<{
      kind: "fetch-file";
      result: PreviewReadResult<{ bytes: Buffer; contentType: string | null }>;
    }>;

export interface PreviewControlCapabilityMintPort {
  mintControl(identity: PreviewControlIdentity): string;
}

export interface PreviewCapabilityReadTransportPort {
  execute(
    input: Readonly<{
      target: PreviewRunTarget;
      capability: string;
      command: PreviewReadBrokerCommand;
    }>,
  ): Promise<PreviewReadBrokerResult>;
}

export interface PreviewReadBrokerPort {
  execute(
    input: Readonly<{
      previewName: string;
      identity: PreviewControlIdentity;
      command: PreviewReadBrokerCommand;
    }>,
  ): Promise<PreviewReadBrokerResult>;
}
