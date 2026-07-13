import type { PreviewControlIdentity } from "./preview-control";

export type PreviewHeadlampCredential = Readonly<{
  bearerToken: string;
  caData: string;
  serverName: string;
}>;

export type PreviewHeadlampRegistrationCommand = Readonly<{
  identity: PreviewControlIdentity;
  credential: PreviewHeadlampCredential;
}>;

export type PreviewHeadlampRegistration = Readonly<{
  previewName: string;
  contextName: string;
  environmentUid: string;
  secretName: string;
  serviceName: string;
}>;

export type PreviewHeadlampRegistrationErrorCode =
  | "invalid-input"
  | "environment-not-found"
  | "generation-mismatch"
  | "resource-ownership"
  | "hub-unavailable";

export class PreviewHeadlampRegistrationError extends Error {
  constructor(
    readonly code: PreviewHeadlampRegistrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PreviewHeadlampRegistrationError";
  }
}

/** Hub resource boundary for one tuple-fenced preview dashboard context. */
export interface PreviewHeadlampRegistrationPort {
  register(
    command: PreviewHeadlampRegistrationCommand,
  ): Promise<PreviewHeadlampRegistration>;
}
