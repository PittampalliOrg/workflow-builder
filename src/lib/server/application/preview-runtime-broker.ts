import type {
  PreviewEnvironmentVersionedServiceCatalogPort,
  PreviewControlSourceAuthorityPort,
  PreviewRuntimeBrokerPort,
  PreviewRuntimeCapabilityVerificationPort,
  PreviewRuntimeCompletionRequest,
  PreviewRuntimeUpstreamPort,
} from "$lib/server/application/ports";

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type PreviewRuntimeBrokerErrorCode =
  | "unauthorized"
  | "invalid-request"
  | "model-forbidden"
  | "capacity";

export class PreviewRuntimeBrokerError extends Error {
  constructor(
    public readonly code: PreviewRuntimeBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewRuntimeBrokerError";
  }
}

/** Adapter-facing failure taxonomy; no upstream response body crosses the port. */
export class PreviewRuntimeUpstreamError extends Error {
  constructor(
    public readonly code: "configuration" | "timeout" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PreviewRuntimeUpstreamError";
  }
}

export type PreviewRuntimeAuditRecord = Readonly<{
  previewName: string;
  requestId: string;
  platformRevision: string;
  sourceRevision: string;
  catalogDigest: string;
  model: string;
  status: "accepted" | "completed" | "failed";
  upstreamStatus?: number;
}>;

type PreviewRuntimeBrokerDeps = Readonly<{
  authority: Pick<PreviewControlSourceAuthorityPort, "authorizeRuntime">;
  capabilities: PreviewRuntimeCapabilityVerificationPort;
  catalog: PreviewEnvironmentVersionedServiceCatalogPort;
  upstream: PreviewRuntimeUpstreamPort;
  allowedModels: readonly string[];
  maxConcurrency: number;
  audit?: (record: PreviewRuntimeAuditRecord) => void;
}>;

/**
 * Tuple-authorized runtime egress for preview agents. Provider credentials and
 * HTTP routing remain behind outbound ports; this service owns only policy.
 */
export class ApplicationPreviewRuntimeBrokerService implements PreviewRuntimeBrokerPort {
  private readonly allowedModels: ReadonlySet<string>;
  private readonly maxConcurrency: number;
  private active = 0;

  constructor(private readonly deps: PreviewRuntimeBrokerDeps) {
    this.allowedModels = new Set(
      deps.allowedModels.map((model) => model.trim()).filter(Boolean),
    );
    this.maxConcurrency = Math.max(1, Math.floor(deps.maxConcurrency));
  }

  async complete(input: PreviewRuntimeCompletionRequest) {
    if (!this.deps.capabilities.verify(input)) {
      throw new PreviewRuntimeBrokerError(
        "unauthorized",
        "preview runtime capability is invalid or mismatched",
      );
    }

    const model = this.validatePayload(input.payload);
    if (!this.allowedModels.has(model)) {
      throw new PreviewRuntimeBrokerError(
        "model-forbidden",
        "preview runtime model is not allowlisted",
      );
    }
    if (this.active >= this.maxConcurrency) {
      throw new PreviewRuntimeBrokerError(
        "capacity",
        "preview runtime concurrency limit reached",
      );
    }
    const auditBase = {
      previewName: input.identity.previewName,
      requestId: input.identity.environmentRequestId,
      platformRevision: input.identity.environmentPlatformRevision,
      sourceRevision: input.identity.environmentSourceRevision,
      catalogDigest: input.identity.catalogDigest,
      model,
    } as const;
    this.active += 1;
    try {
      await this.deps.authority.authorizeRuntime({
        previewName: input.identity.previewName,
        environmentRequestId: input.identity.environmentRequestId,
        environmentPlatformRevision: input.identity.environmentPlatformRevision,
        environmentSourceRevision: input.identity.environmentSourceRevision,
        catalogDigest: input.identity.catalogDigest,
        requiredServices: this.deps.catalog.listPreviewNativeServices(),
      });
      this.deps.audit?.({ ...auditBase, status: "accepted" });
      const response = await this.deps.upstream.complete({
        identity: input.identity,
        payload: input.payload,
      });
      this.deps.audit?.({
        ...auditBase,
        status: "completed",
        upstreamStatus: response.status,
      });
      return response;
    } catch (cause) {
      this.deps.audit?.({ ...auditBase, status: "failed" });
      throw cause;
    } finally {
      this.active -= 1;
    }
  }

  private validatePayload(payload: Readonly<Record<string, unknown>>): string {
    const model = typeof payload.model === "string" ? payload.model.trim() : "";
    if (!MODEL.test(model)) {
      throw new PreviewRuntimeBrokerError(
        "invalid-request",
        "preview runtime request requires a valid model",
      );
    }
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      throw new PreviewRuntimeBrokerError(
        "invalid-request",
        "preview runtime request requires messages",
      );
    }
    if (payload.messages.length > 256) {
      throw new PreviewRuntimeBrokerError(
        "invalid-request",
        "preview runtime request has too many messages",
      );
    }
    if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
      throw new PreviewRuntimeBrokerError(
        "invalid-request",
        "preview runtime stream must be boolean",
      );
    }
    return model;
  }
}
