/**
 * Public, user-session continuation commands for an already-running dev
 * PreviewEnvironment. The application service parses `action` at the boundary
 * so callers cannot add control-plane identity or broker authority.
 */
export type PreviewSessionContinuationInput = Readonly<{
  executionId: string;
  userId: string;
  projectId?: string | null;
  action: unknown;
}>;

export type PreviewSessionContinuationCaptureBody = Readonly<{
  action: "capture";
  ok: boolean;
  artifactId?: string;
  services: readonly Readonly<{
    service: string | null;
    ok: boolean;
  }>[];
}>;

export type PreviewSessionContinuationPromotionBody = Readonly<{
  action: "promote";
  ok: true;
  artifactId: string;
  services: readonly string[];
  pullRequest: Readonly<{
    repository: string;
    number: number;
  }>;
  draft: boolean;
}>;

export type PreviewSessionContinuationAcceptanceBody = Readonly<{
  action: "acceptance";
  ok: boolean;
  services: readonly string[];
  pullRequest: Readonly<{
    repository: string;
    number: number;
  }>;
}>;

export type PreviewSessionContinuationBody =
  | PreviewSessionContinuationCaptureBody
  | PreviewSessionContinuationPromotionBody
  | PreviewSessionContinuationAcceptanceBody;

export type PreviewSessionContinuationResult =
  | Readonly<{
      status: "ok";
      httpStatus?: 200 | 422;
      body: PreviewSessionContinuationBody;
    }>
  | Readonly<{
      status: "error";
      httpStatus: 400 | 403 | 404 | 502;
      message: string;
    }>;

/** Inbound port for authenticated preview-session continuation commands. */
export interface PreviewSessionContinuationPort {
  continue(
    input: PreviewSessionContinuationInput,
  ): Promise<PreviewSessionContinuationResult>;
}
