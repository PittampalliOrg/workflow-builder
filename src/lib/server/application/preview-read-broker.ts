import type {
  PreviewCapabilityReadTransportPort,
  PreviewControlCapabilityMintPort,
  PreviewControlSourceAuthorityPort,
  PreviewReadBrokerCommand,
  PreviewReadBrokerPort,
  VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_FILTER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export class PreviewReadBrokerError extends Error {
  constructor(
    public readonly code: "invalid-request" | "not-ready" | "contract-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "PreviewReadBrokerError";
  }
}

type PreviewReadBrokerDeps = Readonly<{
  previews: Pick<VclusterPreviewGatewayPort, "get">;
  authority: Pick<PreviewControlSourceAuthorityPort, "authorizeRuntimeTuple">;
  capabilities: PreviewControlCapabilityMintPort;
  transport: PreviewCapabilityReadTransportPort;
}>;

/** Central broker for read-only access to an exact, currently Ready preview. */
export class ApplicationPreviewReadBrokerService implements PreviewReadBrokerPort {
  constructor(private readonly deps: PreviewReadBrokerDeps) {}

  async execute(input: {
    previewName: string;
    identity: Readonly<{
      previewName: string;
      environmentRequestId: string;
      environmentPlatformRevision: string;
      environmentSourceRevision: string;
      catalogDigest: `sha256:${string}`;
    }>;
    command: PreviewReadBrokerCommand;
  }) {
    this.validateCommand(input.command);
    const preview = await this.deps.previews.get(input.previewName);
    if (!preview.ready || preview.phase !== "ready") {
      throw new PreviewReadBrokerError("not-ready", "preview is not Ready");
    }
    if (
      preview.profile !== "app-live" ||
      (preview.mode !== "live" && preview.mode !== "reconciled") ||
      preview.trustedCode !== true ||
      preview.pool !== null
    ) {
      throw new PreviewReadBrokerError(
        "contract-mismatch",
        "preview read target is outside the cold app-live boundary",
      );
    }
    const requestId =
      typeof preview.provenance?.requestId === "string"
        ? preview.provenance.requestId
        : "";
    let observedIdentity;
    try {
      observedIdentity = Object.freeze({
        previewName: preview.name,
        environmentRequestId: requestId,
        environmentPlatformRevision: preview.platformRevision ?? "",
        environmentSourceRevision: preview.sourceRevision ?? "",
        catalogDigest: (preview.catalogDigest ?? "") as `sha256:${string}`,
      });
      if (
        !PREVIEW_NAME.test(observedIdentity.previewName) ||
        !SAFE_ID.test(observedIdentity.environmentRequestId) ||
        !FULL_SHA.test(observedIdentity.environmentPlatformRevision) ||
        !FULL_SHA.test(observedIdentity.environmentSourceRevision) ||
        !SHA256.test(observedIdentity.catalogDigest) ||
        !PREVIEW_NAME.test(input.identity.previewName) ||
        !SAFE_ID.test(input.identity.environmentRequestId) ||
        !FULL_SHA.test(input.identity.environmentPlatformRevision) ||
        !FULL_SHA.test(input.identity.environmentSourceRevision) ||
        !SHA256.test(input.identity.catalogDigest)
      ) {
        throw new Error("invalid identity");
      }
    } catch {
      throw new PreviewReadBrokerError(
        "contract-mismatch",
        "preview read target has an incomplete immutable tuple",
      );
    }
    if (
      input.previewName !== input.identity.previewName ||
      input.identity.previewName !== observedIdentity.previewName ||
      input.identity.environmentRequestId !==
        observedIdentity.environmentRequestId ||
      input.identity.environmentPlatformRevision !==
        observedIdentity.environmentPlatformRevision ||
      input.identity.environmentSourceRevision !==
        observedIdentity.environmentSourceRevision ||
      input.identity.catalogDigest !== observedIdentity.catalogDigest
    ) {
      throw new PreviewReadBrokerError(
        "contract-mismatch",
        "preview read generation changed",
      );
    }
    await this.deps.authority.authorizeRuntimeTuple(input.identity);
    const capability = this.deps.capabilities.mintControl(input.identity);
    const result = await this.deps.transport.execute({
      target: { name: preview.name, url: preview.url, pool: null },
      capability,
      command: input.command,
    });
    if (result.kind !== input.command.kind) {
      throw new PreviewReadBrokerError(
        "contract-mismatch",
        "preview read transport returned the wrong operation",
      );
    }
    return result;
  }

  private validateCommand(command: PreviewReadBrokerCommand): void {
    switch (command.kind) {
      case "list-executions":
        if (
          !Number.isInteger(command.limit) ||
          command.limit < 1 ||
          command.limit > 500 ||
          (command.status !== null && !SAFE_FILTER.test(command.status))
        ) {
          throw new PreviewReadBrokerError(
            "invalid-request",
            "invalid execution filter",
          );
        }
        return;
      case "get-execution":
        if (!SAFE_ID.test(command.executionId)) {
          throw new PreviewReadBrokerError(
            "invalid-request",
            "invalid execution id",
          );
        }
        return;
      case "list-artifacts":
        if (
          !SAFE_ID.test(command.executionId) ||
          (command.artifactKind !== null &&
            !SAFE_FILTER.test(command.artifactKind))
        ) {
          throw new PreviewReadBrokerError(
            "invalid-request",
            "invalid artifact filter",
          );
        }
        return;
      case "fetch-file":
        if (
          !SAFE_ID.test(command.fileId) ||
          !Number.isInteger(command.maxBytes) ||
          command.maxBytes < 1 ||
          command.maxBytes > MAX_FILE_BYTES
        ) {
          throw new PreviewReadBrokerError(
            "invalid-request",
            "invalid file request",
          );
        }
    }
  }
}
