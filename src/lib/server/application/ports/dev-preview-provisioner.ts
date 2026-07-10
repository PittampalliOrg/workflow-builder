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

export interface DevPreviewsResult {
  executionId: string;
  services: DevPreviewServiceResult[];
  ok: boolean;
}

export interface ReplaceDevPreviewImagesResult extends DevPreviewsResult {
  rollback: null | {
    attempted: true;
    ok: boolean;
    services: DevPreviewServiceResult[];
  };
}

export interface TeardownDevPreviewParams {
  executionId: string;
  sandboxName?: string | null;
}

export interface TeardownDevPreviewResult {
  ok: boolean;
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
