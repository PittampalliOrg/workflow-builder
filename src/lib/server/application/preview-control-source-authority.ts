import type {
  PreviewControlAdminAuthorizationPort,
  PreviewControlEnvironmentInspectionPort,
  PreviewControlSourceAuthorityInput,
  PreviewControlSourceAuthorityPort,
  PreviewControlEnvironmentRecord,
  PreviewControlIdentity,
  PreviewEnvironmentAcceptanceCatalogPort,
  PreviewEnvironmentVersionedServiceCatalogPort,
} from "$lib/server/application/ports";

const FULL_SHA = /^[0-9a-f]{40}$/;

export type PreviewControlSourceAuthorityErrorCode =
  | "not-found"
  | "not-ready"
  | "contract-mismatch"
  | "owner-not-admin";

export class PreviewControlSourceAuthorityError extends Error {
  constructor(
    public readonly code: PreviewControlSourceAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewControlSourceAuthorityError";
  }
}

type PreviewControlSourceAuthorityDeps = Readonly<{
  environments: PreviewControlEnvironmentInspectionPort;
  admins: PreviewControlAdminAuthorizationPort;
  catalog: PreviewEnvironmentVersionedServiceCatalogPort &
    PreviewEnvironmentAcceptanceCatalogPort;
  expectedPlatformRepository: string;
  expectedSourceRepository: string;
}>;

/** Physical-dev policy gate shared by development and acceptance brokers. */
export class ApplicationPreviewControlSourceAuthorityService implements PreviewControlSourceAuthorityPort {
  constructor(private readonly deps: PreviewControlSourceAuthorityDeps) {}

  async authorize(input: PreviewControlSourceAuthorityInput) {
    if (
      !FULL_SHA.test(input.environmentPlatformRevision) ||
      !FULL_SHA.test(input.environmentSourceRevision)
    ) {
      throw new PreviewControlSourceAuthorityError(
        "contract-mismatch",
        "preview source authority requires full baseline Git SHAs",
      );
    }
    const currentCatalogDigest = this.deps.catalog.currentDigest();
    if (input.catalogDigest !== currentCatalogDigest) {
      throw new PreviewControlSourceAuthorityError(
        "contract-mismatch",
        "preview source catalog digest is not current",
      );
    }

    return this.authorizeEnvironment({
      previewName: input.previewName,
      requiredServices: input.requiredServices,
      expectedRequestId: input.environmentRequestId,
      expectedPlatformRevision: input.environmentPlatformRevision,
      expectedSourceRevision: input.environmentSourceRevision,
      acceptanceReplay: true,
    });
  }

  async authorizeCurrent(input: {
    previewName: string;
    requiredServices: readonly string[];
  }) {
    return this.authorizeEnvironment(input);
  }

  /** Runtime egress accepts both mutable app-live and immutable replay state. */
  async authorizeRuntime(input: PreviewControlSourceAuthorityInput) {
    if (
      !FULL_SHA.test(input.environmentPlatformRevision) ||
      !FULL_SHA.test(input.environmentSourceRevision) ||
      input.catalogDigest !== this.deps.catalog.currentDigest()
    ) {
      throw new PreviewControlSourceAuthorityError(
        "contract-mismatch",
        "preview runtime authority requires the current exact source tuple",
      );
    }
    return this.authorizeEnvironment({
      previewName: input.previewName,
      requiredServices: input.requiredServices,
      expectedRequestId: input.environmentRequestId,
      expectedPlatformRevision: input.environmentPlatformRevision,
      expectedSourceRevision: input.environmentSourceRevision,
      allowedModes: ["live", "reconciled"],
    });
  }

  /** Re-authorize an environment-level capability against its actual service subset. */
  async authorizeRuntimeTuple(input: {
    previewName: string;
    environmentRequestId: string;
    environmentPlatformRevision: string;
    environmentSourceRevision: string;
    catalogDigest: `sha256:${string}`;
  }) {
    this.assertRuntimeTuple(input);
    return this.authorizeEnvironment({
      previewName: input.previewName,
      expectedRequestId: input.environmentRequestId,
      expectedPlatformRevision: input.environmentPlatformRevision,
      expectedSourceRevision: input.environmentSourceRevision,
      allowedModes: ["live", "reconciled"],
    });
  }

  /**
   * Read-only access remains bound to the environment's immutable catalog
   * generation. A later catalog rollout must not make a retained preview's
   * execution history unreadable.
   */
  async authorizeReadTuple(input: PreviewControlIdentity) {
    if (
      !FULL_SHA.test(input.environmentPlatformRevision) ||
      !FULL_SHA.test(input.environmentSourceRevision)
    ) {
      throw new PreviewControlSourceAuthorityError(
        "contract-mismatch",
        "preview read authority requires full baseline Git SHAs",
      );
    }
    return this.authorizeEnvironment({
      previewName: input.previewName,
      expectedRequestId: input.environmentRequestId,
      expectedPlatformRevision: input.environmentPlatformRevision,
      expectedSourceRevision: input.environmentSourceRevision,
      expectedCatalogDigest: input.catalogDigest,
      allowedModes: ["live", "reconciled"],
      validateServices: false,
    });
  }

  /**
   * Read-only telemetry authority. Unlike runtime egress, an exact preview
   * generation remains observable while provisioning or after a failed
   * reconcile, and manifest candidates are valid trace producers.
   */
  async authorizeTraceTuple(input: PreviewControlIdentity) {
    if (
      !FULL_SHA.test(input.environmentPlatformRevision) ||
      !FULL_SHA.test(input.environmentSourceRevision)
    ) {
      throw new PreviewControlSourceAuthorityError(
        "contract-mismatch",
        "preview trace authority requires full baseline Git SHAs",
      );
    }
    return this.authorizeEnvironment({
      previewName: input.previewName,
      expectedRequestId: input.environmentRequestId,
      expectedPlatformRevision: input.environmentPlatformRevision,
      expectedSourceRevision: input.environmentSourceRevision,
      expectedCatalogDigest: input.catalogDigest,
      allowedModes: ["live", "reconciled"],
      allowedProfiles: ["app-live", "manifest-candidate"],
      requireReady: false,
      requireTrustedCode: false,
      validateServices: false,
    });
  }

  /**
   * Apply the same source policy to a record that a physical adapter already
   * fenced to the exact namespace UID and immutable tuple. This method performs
   * no environment read, so callers cannot accidentally turn one observation
   * into a serial pre/read/post sequence.
   */
  async authorizeObservedRuntimeTuple(
    input: PreviewControlIdentity,
    environment: PreviewControlEnvironmentRecord,
  ) {
    this.assertRuntimeTuple(input);
    return this.authorizeEnvironmentRecord(
      {
        previewName: input.previewName,
        expectedRequestId: input.environmentRequestId,
        expectedPlatformRevision: input.environmentPlatformRevision,
        expectedSourceRevision: input.environmentSourceRevision,
        allowedModes: ["live", "reconciled"],
      },
      environment,
    );
  }

  private assertRuntimeTuple(input: PreviewControlIdentity): void {
    if (
      !FULL_SHA.test(input.environmentPlatformRevision) ||
      !FULL_SHA.test(input.environmentSourceRevision) ||
      input.catalogDigest !== this.deps.catalog.currentDigest()
    ) {
      throw new PreviewControlSourceAuthorityError(
        "contract-mismatch",
        "preview runtime authority requires the current exact source tuple",
      );
    }
  }

  private async authorizeEnvironment(input: {
    previewName: string;
    requiredServices?: readonly string[];
    expectedPlatformRevision?: string;
    expectedSourceRevision?: string;
    expectedRequestId?: string;
    expectedCatalogDigest?: `sha256:${string}`;
    allowedModes?: readonly ("live" | "reconciled")[];
    allowedProfiles?: readonly ("app-live" | "manifest-candidate")[];
    requireReady?: boolean;
    requireTrustedCode?: boolean;
    validateServices?: boolean;
    acceptanceReplay?: boolean;
  }) {
    const environment = await this.deps.environments.inspect(input.previewName);
    return this.authorizeEnvironmentRecord(input, environment);
  }

  private async authorizeEnvironmentRecord(
    input: {
      previewName: string;
      requiredServices?: readonly string[];
      expectedPlatformRevision?: string;
      expectedSourceRevision?: string;
      expectedRequestId?: string;
      expectedCatalogDigest?: `sha256:${string}`;
      allowedModes?: readonly ("live" | "reconciled")[];
      allowedProfiles?: readonly ("app-live" | "manifest-candidate")[];
      requireReady?: boolean;
      requireTrustedCode?: boolean;
      validateServices?: boolean;
      acceptanceReplay?: boolean;
    },
    environment: PreviewControlEnvironmentRecord,
  ) {
    const requiredServices = input.requiredServices
      ? input.acceptanceReplay
        ? this.deps.catalog.assertAcceptanceReplayServices(
            input.requiredServices,
          )
        : this.deps.catalog.assertPreviewNativeServices(input.requiredServices)
      : null;
    const environmentBoundServices = input.acceptanceReplay
      ? (requiredServices ?? []).filter((service) => {
          try {
            this.deps.catalog.assertPreviewNativeServices([service]);
            return true;
          } catch {
            return false;
          }
        })
      : requiredServices;
    const currentCatalogDigest = this.deps.catalog.currentDigest();
    if (!environment.exists || environment.name !== input.previewName) {
      throw new PreviewControlSourceAuthorityError(
        "not-found",
        "preview environment was not found on physical dev",
      );
    }
    if (input.requireReady !== false && !environment.ready) {
      throw new PreviewControlSourceAuthorityError(
        "not-ready",
        "preview environment is not Ready on physical dev",
      );
    }
    let environmentServices: readonly string[] = environment.services;
    if (input.validateServices !== false) {
      try {
        environmentServices =
          environment.mode === "reconciled"
            ? this.deps.catalog.assertAcceptanceReplayServices(
                environment.services,
              )
            : this.deps.catalog.assertPreviewNativeServices(
                environment.services,
              );
      } catch {
        throw new PreviewControlSourceAuthorityError(
          "contract-mismatch",
          "physical preview contract mismatch: services",
        );
      }
    }
    const allowedModes = input.allowedModes ?? ["live"];
    const allowedProfiles = input.allowedProfiles ?? ["app-live"];
    const expectedCatalogDigest =
      input.expectedCatalogDigest ?? currentCatalogDigest;
    const mismatches = [
      environment.profile &&
      allowedProfiles.some((profile) => profile === environment.profile)
        ? null
        : "profile",
      environment.mode && allowedModes.includes(environment.mode)
        ? null
        : "mode",
      input.requireTrustedCode === false || environment.trustedCode
        ? null
        : "trustedCode",
      FULL_SHA.test(environment.platformRevision ?? "")
        ? null
        : "platformRevision",
      FULL_SHA.test(environment.sourceRevision ?? "") ? null : "sourceRevision",
      input.expectedPlatformRevision === undefined ||
      environment.platformRevision === input.expectedPlatformRevision
        ? null
        : "platformRevision",
      input.expectedSourceRevision === undefined ||
      environment.sourceRevision === input.expectedSourceRevision
        ? null
        : "sourceRevision",
      environment.catalogDigest === expectedCatalogDigest
        ? null
        : "catalogDigest",
      environment.provenance?.platformRepository ===
      this.deps.expectedPlatformRepository
        ? null
        : "platformRepository",
      environment.provenance?.sourceRepository ===
      this.deps.expectedSourceRepository
        ? null
        : "sourceRepository",
      input.expectedRequestId === undefined ||
      environment.provenance?.requestId === input.expectedRequestId
        ? null
        : "requestId",
      environmentBoundServices === null ||
      environmentBoundServices.every((service) =>
        environmentServices.includes(service),
      )
        ? null
        : "services",
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) {
      throw new PreviewControlSourceAuthorityError(
        "contract-mismatch",
        `physical preview contract mismatch: ${mismatches.join(",")}`,
      );
    }
    const owner = environment.owner?.trim() ?? "";
    if (!owner || !(await this.deps.admins.isPlatformAdmin(owner))) {
      throw new PreviewControlSourceAuthorityError(
        "owner-not-admin",
        "physical preview owner is not a central platform admin",
      );
    }

    return Object.freeze({
      previewName: environment.name,
      requestId: environment.provenance!.requestId,
      owner,
      platformRevision: environment.platformRevision as never,
      sourceRevision: environment.sourceRevision as never,
      catalogDigest: expectedCatalogDigest,
      services: Object.freeze(requiredServices ?? environmentServices),
    });
  }
}
