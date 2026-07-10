import type {
  PreviewEnvironment,
  PreviewEnvironmentAcceptanceCatalogPort,
  PreviewEnvironmentImageBuildPort,
  PreviewEnvironmentInventoryPort,
  PreviewEnvironmentLaunchPort,
  PreviewEnvironmentOrigin,
  PreviewEnvironmentOwner,
  PreviewEnvironmentProvenance,
  PreviewEnvironmentReadinessPort,
  PreviewEnvironmentRuntimeInspectionPort,
  PreviewEnvironmentCleanupProof,
  PreviewEnvironmentTeardownPort,
  PreviewEnvironmentVerificationPort,
  PreviewEnvironmentVerificationResult,
  PreviewProductionImage,
} from "$lib/server/application/ports";
import { validatePreviewEnvironmentLaunchSpec } from "$lib/server/application/preview-environments";

const PLACEHOLDER_DIGEST = "0".repeat(64);

export type PreviewEnvironmentAcceptanceInput = Readonly<{
  name: string;
  platformRevision: string;
  sourceRevision: string;
  services: readonly string[];
  owner: PreviewEnvironmentOwner;
  origin: PreviewEnvironmentOrigin;
  ttlHours: number;
  lifecycle: "ephemeral" | "retained";
  provenance: PreviewEnvironmentProvenance;
  timeoutMs?: number;
}>;

export type PreviewEnvironmentAcceptanceOutcome =
  | Readonly<{
      ok: true;
      environment: PreviewEnvironment;
      images: readonly PreviewProductionImage[];
      verification: PreviewEnvironmentVerificationResult;
      retained: boolean;
      cleanup: PreviewEnvironmentCleanupProof | null;
    }>
  | Readonly<{
      ok: false;
      stage:
        | "freshness"
        | "build"
        | "capacity"
        | "readiness"
        | "runtime"
        | "verification"
        | "cleanup";
      message: string;
      environment?: PreviewEnvironment;
      images?: readonly PreviewProductionImage[];
      verification?: PreviewEnvironmentVerificationResult;
      cleanup?: PreviewEnvironmentCleanupProof;
    }>;

export class PreviewEnvironmentAcceptanceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewEnvironmentAcceptanceContractError";
  }
}

export class ApplicationPreviewEnvironmentAcceptanceService {
  constructor(
    private readonly deps: Readonly<{
      catalog: PreviewEnvironmentAcceptanceCatalogPort;
      inventory: PreviewEnvironmentInventoryPort;
      images: PreviewEnvironmentImageBuildPort;
      launch: PreviewEnvironmentLaunchPort;
      readiness: PreviewEnvironmentReadinessPort;
      runtime: PreviewEnvironmentRuntimeInspectionPort;
      verification: PreviewEnvironmentVerificationPort;
      teardown: PreviewEnvironmentTeardownPort;
    }>,
  ) {}

  async replay(
    input: PreviewEnvironmentAcceptanceInput,
  ): Promise<PreviewEnvironmentAcceptanceOutcome> {
    const requestedServices = this.deps.catalog.assertAcceptanceReplayServices(
      input.services,
    );
    const catalogDigest = this.deps.catalog.currentDigest();
    const preflight = validatePreviewEnvironmentLaunchSpec(
      {
        ...input,
        services: requestedServices,
        profile: "app-live",
        capabilities: ["immutable-image-replay"],
        mode: "reconciled",
        allocation: { kind: "cold" },
        imageOverrides: Object.fromEntries(
          requestedServices.map((service) => [
            service,
            `ghcr.io/pittampalliorg/${service}@sha256:${PLACEHOLDER_DIGEST}`,
          ]),
        ),
      },
      catalogDigest,
    );

    let existing;
    try {
      existing = await this.deps.inventory.inspect(preflight.name);
    } catch (cause) {
      return {
        ok: false,
        stage: "freshness",
        message: `acceptance freshness check failed closed: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    if (existing.exists) {
      return {
        ok: false,
        stage: "freshness",
        message: `acceptance environment ${preflight.name} already exists (${existing.phase})`,
      };
    }

    let images: readonly PreviewProductionImage[];
    try {
      images = await this.deps.images.build({
        requestId: preflight.provenance.requestId,
        sourceRepository: preflight.provenance.sourceRepository,
        sourceRevision: preflight.sourceRevision,
        services: preflight.services,
      });
    } catch (cause) {
      if (cause instanceof PreviewEnvironmentAcceptanceContractError)
        throw cause;
      return {
        ok: false,
        stage: "build",
        message: `selective production image build failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    const imageOverrides = validateBuildSet(
      preflight.services,
      images,
      preflight.sourceRevision,
    );
    const command = validatePreviewEnvironmentLaunchSpec(
      {
        ...preflight,
        imageOverrides,
      },
      catalogDigest,
    );

    const launched = await this.deps.launch.launch(command);
    if (!launched.ok) {
      return {
        ok: false,
        stage: launched.reason === "conflict" ? "freshness" : "capacity",
        message: launched.message,
        images,
      };
    }

    const timeoutMs = input.timeoutMs ?? 15 * 60_000;
    let replayResult: PreviewEnvironmentAcceptanceOutcome;
    let environment = launched.environment;
    try {
      const readiness = await this.deps.readiness.waitReady({
        name: command.name,
        platformRevision: command.platformRevision,
        sourceRevision: command.sourceRevision,
        profile: command.profile,
        lane: command.lane,
        mode: command.mode,
        services: command.services,
        owner: command.owner,
        origin: command.origin,
        lifecycle: command.lifecycle,
        allocation: command.allocation,
        provenance: command.provenance,
        images: command.imageOverrides,
        catalogDigest: command.catalogDigest,
        timeoutMs,
      });
      environment = {
        ...launched.environment,
        lifecycleState: readiness.ready ? "ready" : "failed",
        runtime: {
          ...launched.environment.runtime,
          phase: readiness.phase,
          ready: readiness.ready,
          url: readiness.url,
        },
      };
      if (!readiness.ready) {
        replayResult = {
          ok: false,
          stage: "readiness",
          message: `acceptance environment did not become ready (${readiness.phase})`,
          environment,
          images,
        };
      } else {
        const runtime = await this.deps.runtime.waitForImages({
          name: command.name,
          images: command.imageOverrides,
          timeoutMs,
        });
        if (!runtime.ok) {
          replayResult = {
            ok: false,
            stage: "runtime",
            message:
              "acceptance workloads did not run the requested immutable images",
            environment,
            images,
            verification: {
              ok: false,
              checks: runtime.checks.map((check) => ({
                name: `runtime-image:${check.service}`,
                ok: check.ok,
                detail:
                  check.detail ??
                  `expected ${check.expectedImage}; observed ${check.observedImages.join(", ") || "none"}`,
              })),
            },
          };
        } else {
          let verification: PreviewEnvironmentVerificationResult;
          try {
            verification = await this.deps.verification.verify({
              environment,
              images,
            });
          } catch (cause) {
            verification = {
              ok: false,
              checks: [
                {
                  name: "verification-adapter",
                  ok: false,
                  detail:
                    cause instanceof Error ? cause.message : String(cause),
                },
              ],
            };
          }
          replayResult = verification.ok
            ? {
                ok: true,
                environment,
                images,
                verification,
                retained: false,
                cleanup: null,
              }
            : {
                ok: false,
                stage: "verification",
                message: "clean immutable acceptance verification failed",
                environment,
                images,
                verification,
              };
        }
      }
    } catch (cause) {
      const runtimeStarted = environment.runtime.ready;
      replayResult = {
        ok: false,
        stage: runtimeStarted ? "runtime" : "readiness",
        message: `${runtimeStarted ? "acceptance runtime image inspection" : "acceptance readiness check"} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        environment,
        images,
      };
    }

    let cleanup: PreviewEnvironmentCleanupProof;
    try {
      cleanup = await this.deps.teardown.teardown({
        name: environment.name,
        timeoutMs,
        guard: {
          mode: "owned",
          requestId: command.provenance.requestId,
          sourceRevision: command.sourceRevision,
        },
      });
      if (!cleanup.complete) {
        return {
          ok: false,
          stage: "cleanup",
          message: cleanup.message ?? "acceptance cleanup did not converge",
          environment,
          images,
          ...("verification" in replayResult && replayResult.verification
            ? { verification: replayResult.verification }
            : {}),
          cleanup,
        };
      }
    } catch (cause) {
      return {
        ok: false,
        stage: "cleanup",
        message: `acceptance teardown failed after ${replayResult.ok ? "verification" : replayResult.stage}: ${cause instanceof Error ? cause.message : String(cause)}`,
        environment,
        images,
        ...("verification" in replayResult && replayResult.verification
          ? { verification: replayResult.verification }
          : {}),
      };
    }
    return replayResult.ok
      ? { ...replayResult, cleanup }
      : { ...replayResult, cleanup };
  }

  teardown(
    name: string,
    guard: NonNullable<
      Parameters<PreviewEnvironmentTeardownPort["teardown"]>[0]["guard"]
    >,
    timeoutMs = 15 * 60_000,
  ): Promise<PreviewEnvironmentCleanupProof> {
    return this.deps.teardown.teardown({ name, timeoutMs, guard });
  }
}

function validateBuildSet(
  services: readonly string[],
  images: readonly PreviewProductionImage[],
  sourceRevision: string,
): Readonly<Record<string, string>> {
  const expected = new Set(services);
  const actual = new Map<string, PreviewProductionImage>();
  for (const image of images) {
    if (!expected.has(image.service)) {
      throw new PreviewEnvironmentAcceptanceContractError(
        `builder returned unrequested service ${image.service}`,
      );
    }
    if (actual.has(image.service)) {
      throw new PreviewEnvironmentAcceptanceContractError(
        `builder returned duplicate service ${image.service}`,
      );
    }
    if (image.sourceRevision !== sourceRevision) {
      throw new PreviewEnvironmentAcceptanceContractError(
        `builder returned ${image.service} from a different source revision`,
      );
    }
    if (!image.immutableRef.endsWith(`@${image.digest}`)) {
      throw new PreviewEnvironmentAcceptanceContractError(
        `builder returned inconsistent digest metadata for ${image.service}`,
      );
    }
    actual.set(image.service, image);
  }
  const missing = services.filter((service) => !actual.has(service));
  if (missing.length > 0) {
    throw new PreviewEnvironmentAcceptanceContractError(
      `builder omitted services: ${missing.join(", ")}`,
    );
  }
  return Object.freeze(
    Object.fromEntries(
      services.map((service) => [service, actual.get(service)!.immutableRef]),
    ),
  );
}
