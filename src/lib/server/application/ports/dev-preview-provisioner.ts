/** Source tree staged into a service's synchronized work directory. */
export type DevPreviewExtraSync = Readonly<{
  from: string;
  to: string;
}>;

/** Application-owned result for one provisioned development service. */
export interface DevPreviewInfo {
  sandboxName: string;
  executionId: string;
  service: string;
  image: string;
  podIP: string | null;
  port: number;
  syncPort: number;
  url: string | null;
  /** Catalog-owned application health route, relative to `url`. */
  healthPath: string;
  syncUrl: string | null;
  syncCapability: string;
  browseUrl: string | null;
  repoUrl: string;
  repoSubdir: string;
  syncPaths: string[];
  extraSync: DevPreviewExtraSync[];
  captureOnly: DevPreviewExtraSync[];
  ready: boolean;
  status: string;
  needsDapr: boolean;
  daprAppId: string | null;
}

export interface ProvisionDevPreviewParams {
  executionId: string;
  service?: string | null;
  timeoutSeconds?: number | null;
  waitReadySeconds?: number;
  image?: string | null;
  executionClass?: string;
  mode?: "host-throwaway" | "preview-native";
  adopt?: boolean;
  origin?: string;
}

export interface ProvisionDevPreviewsParams extends Omit<
  ProvisionDevPreviewParams,
  "service"
> {
  services: string[];
}

export interface ReplaceDevPreviewImagesParams extends Omit<
  ProvisionDevPreviewParams,
  "service" | "image" | "mode"
> {
  services: Array<{ service: string; image: string }>;
  mode: "preview-native";
}

export interface DevPreviewServiceResult {
  service: string;
  ok: boolean;
  info?: DevPreviewInfo;
  error?: string;
}

export type DevPreviewActivationPhase =
  | "not-required"
  | "scheduled"
  | "activating"
  | "active"
  | "failed";

/**
 * The activation request may have committed in SEA, but its durable receipt was
 * not observed. Adapters must preserve the staged batch and retry the exact input.
 */
export class RetryableDevPreviewActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableDevPreviewActivationError";
  }
}

type DevPreviewsResultBase = {
  executionId: string;
  services: DevPreviewServiceResult[];
};

export type DevPreviewsResult = DevPreviewsResultBase &
  (
    | {
        ok: true;
        complete: true;
        pending: false;
        activationPhase: "not-required";
        batchId?: never;
      }
    | {
        ok: true;
        complete: false;
        pending: true;
        activationPhase: "scheduled" | "activating";
        /** Stable SEA activation identity for staged preview-native adoption. */
        batchId: string;
      }
    | {
        ok: true;
        complete: true;
        pending: false;
        activationPhase: "active";
        /** Stable SEA activation identity for staged preview-native adoption. */
        batchId: string;
      }
    | {
        ok: false;
        complete: false;
        pending: false;
        activationPhase: "failed";
        batchId?: string;
      }
  );

export type ReplaceDevPreviewImagesResult = DevPreviewsResult & {
  rollback: null | {
    attempted: true;
    ok: boolean;
    services: DevPreviewServiceResult[];
  };
};

export interface TeardownDevPreviewParams {
  executionId: string;
  sandboxName?: string | null;
}

export interface TeardownDevPreviewResult {
  /** Every teardown request was accepted by the infrastructure adapter. */
  ok: boolean;
  /** All requested preview resources were deleted before this call returned. */
  complete: boolean;
  /** At least one accepted teardown is still converging asynchronously. */
  pending: boolean;
  sandboxName: string | null;
}

/**
 * Compatibility port for the existing per-service dev-preview implementation.
 * It remains available from the application ports barrel while callers migrate
 * to the aggregate PreviewEnvironment launch contract.
 */
export interface PreviewEnvironmentProvisioner {
  provision(input: ProvisionDevPreviewParams): Promise<DevPreviewInfo>;
  /** Fan-out provision of N services into one execution (multi-service adopt). */
  provisionMany(input: ProvisionDevPreviewsParams): Promise<DevPreviewsResult>;
  replaceMany(
    input: ReplaceDevPreviewImagesParams,
  ): Promise<ReplaceDevPreviewImagesResult>;
  teardown(input: TeardownDevPreviewParams): Promise<TeardownDevPreviewResult>;
}
