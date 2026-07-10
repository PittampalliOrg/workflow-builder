import type {
  DevPreviewAcceptanceCapturePort,
  ImmutableGitSha,
  PreviewDevelopmentImage,
  PreviewDevelopmentBuildBrokerPort,
  PreviewDevelopmentBrokerServiceResult,
  PreviewEnvironmentProvisioner,
  PreviewEnvironmentVersionedServiceCatalogPort,
} from "$lib/server/application/ports";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const DEVELOPMENT_BRANCH = /^preview-development-[0-9]{1,20}$/;
const DEVELOPMENT_BASE_BRANCH = "main";
const PREVIEW_HOST =
  /^wfb-([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\.(?:[a-z0-9-]+\.)+ts\.net$/;

export class PreviewDevelopmentBuildInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewDevelopmentBuildInputError";
  }
}

export type PreviewDevelopmentServiceOutcome = Readonly<{
  service: string;
  build:
    | Readonly<{ ok: true; image: PreviewDevelopmentImage }>
    | Readonly<{ ok: false; error: string }>;
  provision:
    | Readonly<{
        ok: true;
        preview: Awaited<
          ReturnType<PreviewEnvironmentProvisioner["provision"]>
        >;
      }>
    | Readonly<{ ok: false; error: string }>
    | Readonly<{
        ok: false;
        skipped: "build-failed" | "batch-build-failed";
      }>;
}>;

export type PreviewDevelopmentBuildOutcome =
  | Readonly<{
      ok: false;
      stage: "capture" | "broker";
      executionId: string;
      error: string;
      artifactId?: string;
      services?: readonly unknown[];
    }>
  | Readonly<{
      ok: boolean;
      stage: "complete";
      executionId: string;
      artifactId: string;
      captureId: string | null;
      generation: string | null;
      branch: string;
      sourceRevision: ImmutableGitSha;
      baselineRevision: ImmutableGitSha;
      pullRequestBase: typeof DEVELOPMENT_BASE_BRANCH;
      changedPaths: readonly string[];
      catalogDigest: `sha256:${string}`;
      services: readonly PreviewDevelopmentServiceOutcome[];
      rollback: Awaited<
        ReturnType<PreviewEnvironmentProvisioner["replaceMany"]>
      >["rollback"];
    }>;

type PreviewDevelopmentBuildDeps = Readonly<{
  capture: DevPreviewAcceptanceCapturePort;
  broker: PreviewDevelopmentBuildBrokerPort;
  provisioner: PreviewEnvironmentProvisioner;
  catalog: PreviewEnvironmentVersionedServiceCatalogPort;
  requestId?: () => string;
}>;

export type PreviewDevelopmentBuildInput = Readonly<{
  executionId: string;
  services: readonly string[];
  origin: string;
  adopt: boolean;
}>;

/**
 * Materialize the current live generation in GitHub, build its dev images, and
 * replace only the selected preview-native services with those immutable images.
 */
export class ApplicationPreviewDevelopmentBuildService {
  private readonly requestId: () => string;

  constructor(private readonly deps: PreviewDevelopmentBuildDeps) {
    this.requestId = deps.requestId ?? (() => globalThis.crypto.randomUUID());
  }

  async buildAndReprovision(
    input: PreviewDevelopmentBuildInput,
  ): Promise<PreviewDevelopmentBuildOutcome> {
    const services = this.validateServices(input.services);
    const origin = canonicalPreviewOrigin(input.origin);
    const previewName = previewNameFromOrigin(origin);
    if (typeof input.adopt !== "boolean") {
      throw new PreviewDevelopmentBuildInputError(
        "adopt must explicitly choose true or false",
      );
    }
    if (input.adopt && services.includes("workflow-builder")) {
      throw new PreviewDevelopmentBuildInputError(
        "adopt=true cannot replace the workflow-builder BFF that is coordinating the build; use adopt=false and verify the image in a fresh acceptance preview",
      );
    }

    const captured = await this.deps.capture.captureAcceptanceCandidate({
      executionId: input.executionId,
      nodeId: "preview-development-build",
      expectedServices: services,
    });
    if (!captured.ok || !captured.artifactId) {
      return Object.freeze({
        ok: false,
        stage: "capture",
        executionId: input.executionId,
        error: captured.skipped ?? "strict source capture failed",
        services: captured.services,
      });
    }

    const catalogDigest = this.deps.catalog.currentDigest();
    const requestId = this.requestId();
    let brokerResult;
    try {
      brokerResult = await this.deps.broker.build({
        requestId,
        executionId: input.executionId,
        artifactId: captured.artifactId,
        previewName,
        catalogDigest,
        services,
      });
    } catch (cause) {
      return Object.freeze({
        ok: false,
        stage: "broker",
        executionId: input.executionId,
        artifactId: captured.artifactId,
        error: message(cause),
      });
    }
    if (
      brokerResult.previewName !== previewName ||
      brokerResult.catalogDigest !== catalogDigest ||
      !DEVELOPMENT_BRANCH.test(brokerResult.branch) ||
      !FULL_SHA.test(brokerResult.sourceRevision) ||
      !FULL_SHA.test(brokerResult.baselineRevision) ||
      brokerResult.sourceRevision === brokerResult.baselineRevision ||
      brokerResult.pullRequestBase !== DEVELOPMENT_BASE_BRANCH ||
      !validChangedPaths(brokerResult.changedPaths)
    ) {
      return Object.freeze({
        ok: false,
        stage: "broker",
        executionId: input.executionId,
        artifactId: captured.artifactId,
        error: "preview control broker returned mismatched provenance",
      });
    }
    const sourceRevision = brokerResult.sourceRevision as ImmutableGitSha;
    const baselineRevision = brokerResult.baselineRevision as ImmutableGitSha;
    const changedPaths = Object.freeze([...brokerResult.changedPaths]);
    const requested = new Set(services);
    const affectedServices = brokerResult.services.map(
      (result) => result.service,
    );
    const builds = new Map(
      brokerResult.services.map((result) => [result.service, result]),
    );
    if (
      affectedServices.length === 0 ||
      builds.size !== affectedServices.length ||
      affectedServices.some((service) => !requested.has(service))
    ) {
      return Object.freeze({
        ok: false,
        stage: "broker",
        executionId: input.executionId,
        artifactId: captured.artifactId,
        error:
          "preview control broker returned an invalid changed-service closure",
      });
    }
    if (
      brokerResult.services.some(
        (result) => result.ok && !validBrokerImage(result, sourceRevision),
      )
    ) {
      return Object.freeze({
        ok: false,
        stage: "broker",
        executionId: input.executionId,
        artifactId: captured.artifactId,
        error:
          "preview control broker returned invalid development image provenance",
      });
    }
    const anyBuildFailed = affectedServices.some(
      (service) => !builds.get(service)?.ok,
    );
    if (!brokerResult.ok || anyBuildFailed) {
      const serviceResults = affectedServices.map(
        (service): PreviewDevelopmentServiceOutcome => {
          const build = builds.get(
            service,
          ) as PreviewDevelopmentBrokerServiceResult;
          return Object.freeze({
            service,
            build: build.ok
              ? ({ ok: true, image: build.image } as const)
              : ({ ok: false, error: build.error } as const),
            provision: {
              ok: false,
              skipped: "batch-build-failed",
            } as const,
          });
        },
      );
      return Object.freeze({
        ok: false,
        stage: "complete",
        executionId: input.executionId,
        artifactId: captured.artifactId,
        captureId: captured.captureId ?? null,
        generation: captured.generation ?? null,
        branch: brokerResult.branch,
        sourceRevision,
        baselineRevision,
        pullRequestBase: DEVELOPMENT_BASE_BRANCH,
        changedPaths,
        catalogDigest,
        services: Object.freeze(serviceResults),
        rollback: null,
      });
    }

    let replacement;
    try {
      replacement = await this.deps.provisioner.replaceMany({
        executionId: input.executionId,
        services: affectedServices.map((service) => {
          const build = builds.get(service);
          if (!build?.ok) throw new Error("unreachable failed build");
          return { service, image: build.image.immutableRef };
        }),
        executionClass: "preview-development-build",
        mode: "preview-native",
        adopt: input.adopt,
        origin,
      });
    } catch (cause) {
      const serviceResults = affectedServices.map(
        (service): PreviewDevelopmentServiceOutcome => {
          const build = builds.get(service);
          if (!build?.ok) throw new Error("unreachable failed build");
          return Object.freeze({
            service,
            build: { ok: true, image: build.image } as const,
            provision: { ok: false, error: message(cause) } as const,
          });
        },
      );
      return Object.freeze({
        ok: false,
        stage: "complete",
        executionId: input.executionId,
        artifactId: captured.artifactId,
        captureId: captured.captureId ?? null,
        generation: captured.generation ?? null,
        branch: brokerResult.branch,
        sourceRevision,
        baselineRevision,
        pullRequestBase: DEVELOPMENT_BASE_BRANCH,
        changedPaths,
        catalogDigest,
        services: Object.freeze(serviceResults),
        rollback: null,
      });
    }
    const provisions = new Map(
      replacement.services.map((result) => [result.service, result]),
    );
    const serviceResults = affectedServices.map(
      (service): PreviewDevelopmentServiceOutcome => {
        const build = builds.get(service);
        if (!build?.ok) throw new Error("unreachable failed build");
        const provision = provisions.get(service);
        return Object.freeze({
          service,
          build: { ok: true, image: build.image } as const,
          provision:
            replacement.ok && provision?.ok && provision.info
              ? ({ ok: true, preview: provision.info } as const)
              : ({
                  ok: false,
                  error:
                    provision?.error ??
                    "multi-service replacement failed and was rolled back",
                } as const),
        });
      },
    );
    return Object.freeze({
      ok: replacement.ok,
      stage: "complete",
      executionId: input.executionId,
      artifactId: captured.artifactId,
      captureId: captured.captureId ?? null,
      generation: captured.generation ?? null,
      branch: brokerResult.branch,
      sourceRevision,
      baselineRevision,
      pullRequestBase: DEVELOPMENT_BASE_BRANCH,
      changedPaths,
      catalogDigest,
      services: Object.freeze(serviceResults),
      rollback: replacement.rollback,
    });
  }

  private validateServices(requested: readonly string[]): readonly string[] {
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new PreviewDevelopmentBuildInputError(
        "services must be a non-empty preview-native service set",
      );
    }
    if (
      requested.some(
        (service) => typeof service !== "string" || !service.trim(),
      )
    ) {
      throw new PreviewDevelopmentBuildInputError(
        "services must contain only non-empty service ids",
      );
    }
    const normalized = requested.map((service) => service.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new PreviewDevelopmentBuildInputError(
        "services must not contain duplicates",
      );
    }
    try {
      return this.deps.catalog.assertPreviewNativeServices(normalized);
    } catch (cause) {
      throw new PreviewDevelopmentBuildInputError(message(cause));
    }
  }
}

function validBrokerImage(
  result: Extract<PreviewDevelopmentBrokerServiceResult, { ok: true }>,
  sourceRevision: ImmutableGitSha,
): boolean {
  const tag = `:git-${sourceRevision}`;
  if (!result.image.imageRef.endsWith(tag)) return false;
  const repository = result.image.imageRef.slice(0, -tag.length);
  return Boolean(
    result.image.service === result.service &&
    result.image.sourceRevision === sourceRevision &&
    result.image.buildId &&
    /^ghcr\.io\/pittampalliorg\/[a-z0-9][a-z0-9._-]{1,126}$/.test(repository) &&
    SHA256.test(result.image.digest) &&
    result.image.immutableRef === `${repository}@${result.image.digest}`,
  );
}

function validChangedPaths(paths: readonly string[]): boolean {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 4096) {
    return false;
  }
  const seen = new Set<string>();
  for (const path of paths) {
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 512 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(path)
    ) {
      return false;
    }
    seen.add(path);
  }
  return true;
}

export function canonicalPreviewOrigin(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new PreviewDevelopmentBuildInputError(
      "origin must be the preview's HTTPS origin",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new PreviewDevelopmentBuildInputError(
      "origin must be a valid preview HTTPS origin",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !PREVIEW_HOST.test(parsed.hostname)
  ) {
    throw new PreviewDevelopmentBuildInputError(
      "origin must match https://wfb-<preview>.<tailnet>.ts.net with no path, port, query, or credentials",
    );
  }
  return parsed.origin;
}

export function previewNameFromOrigin(origin: string): string {
  const parsed = new URL(canonicalPreviewOrigin(origin));
  const match = PREVIEW_HOST.exec(parsed.hostname);
  if (!match?.[1]) {
    throw new PreviewDevelopmentBuildInputError(
      "origin does not contain a preview name",
    );
  }
  return match[1];
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
