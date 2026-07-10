import type {
  PreviewAcceptanceChangedServiceCatalogPort,
  PreviewAcceptanceResponseCatalogPort,
  PreviewArtifactCaptureCatalogPort,
  PreviewEnvironmentVersionedServiceCatalogPort,
  PreviewGateRequirementCatalogPort,
} from "$lib/server/application/ports";
import {
  canonicalDevPreviewServices,
  canonicalPreviewAcceptanceServices,
  DEV_PREVIEW_CATALOG_DIGEST,
  DEV_PREVIEW_CATALOG_PATH_POLICY,
  DEV_PREVIEW_SERVICES,
  PREVIEW_CATALOG_EXTENSIONS,
  devPreviewCaptureMappings,
  devPreviewChangedPaths,
  devPreviewSyncPaths,
  resolveDevPreviewDescriptor,
  resolvePreviewAcceptanceBuild,
  resolveRequestedPreviewAcceptanceServiceSet,
  resolveRequestedDevPreviewServiceSet,
} from "$lib/server/workflows/dev-preview-registry";
import { previewGateRequirementDigest } from "$lib/server/application/preview-gate-requirements";

/** Catalog admission adapter shared by live launch and immutable acceptance. */
export class DevPreviewServiceCatalogAdapter
  implements
    PreviewEnvironmentVersionedServiceCatalogPort,
    PreviewAcceptanceChangedServiceCatalogPort,
    PreviewAcceptanceResponseCatalogPort,
    PreviewArtifactCaptureCatalogPort,
    PreviewGateRequirementCatalogPort
{
  currentDigest(): `sha256:${string}` {
    return DEV_PREVIEW_CATALOG_DIGEST;
  }

  listPreviewNativeServices(): readonly string[] {
    return Object.freeze(canonicalDevPreviewServices("preview-native"));
  }

  assertPreviewNativeServices(services: readonly string[]): readonly string[] {
    const resolution = resolveRequestedDevPreviewServiceSet(
      services,
      "preview-native",
    );
    if (resolution.rejected.length > 0) {
      const detail = resolution.rejected
        .map(({ service, reason }) =>
          reason === "unknown-service"
            ? `${service} is not registered`
            : `${service} is host-throwaway only`,
        )
        .join("; ");
      throw new Error(
        `unsupported preview-native services: ${detail}. Supported: ${canonicalDevPreviewServices("preview-native").join(", ")}`,
      );
    }
    if (resolution.services.length === 0) {
      throw new Error("At least one preview-native service is required");
    }
    return Object.freeze([...resolution.services]);
  }

  assertAcceptanceReplayServices(
    services: readonly string[],
  ): readonly string[] {
    const resolution = resolveRequestedPreviewAcceptanceServiceSet(services);
    if (resolution.rejected.length > 0) {
      const detail = resolution.rejected
        .map(({ service, reason }) =>
          reason === "unknown-service"
            ? `${service} is not registered`
            : `${service} has no immutable replay contract`,
        )
        .join("; ");
      throw new Error(
        `unsupported acceptance replay services: ${detail}. Supported: ${canonicalPreviewAcceptanceServices().join(", ")}`,
      );
    }
    if (resolution.services.length === 0) {
      throw new Error("At least one acceptance replay service is required");
    }
    return Object.freeze([...resolution.services]);
  }

  acceptanceImageRepository(service: string): string {
    return resolvePreviewAcceptanceBuild(service).image;
  }

  captureContract(service: string) {
    let descriptor;
    try {
      descriptor = resolveDevPreviewDescriptor(service);
    } catch {
      return null;
    }
    if (!descriptor.capabilities.previewNative) return null;
    return Object.freeze({
      service: descriptor.service,
      repository: descriptor.repoUrl,
      base: descriptor.baseBranch ?? "main",
      repoSubdir: descriptor.repoSubdir,
      syncPaths: Object.freeze(devPreviewSyncPaths(descriptor)),
      captureMappings: Object.freeze(
        devPreviewCaptureMappings(descriptor).map((mapping) =>
          Object.freeze({ ...mapping }),
        ),
      ),
    });
  }

  deriveChangedServices(paths: readonly string[]) {
    const services = new Set<string>();
    const activationArtifacts = new Set<string>();
    const unmappedRuntimePaths = new Set<string>();
    for (const path of paths) {
      if (!normalizedChangedPath(path)) {
        unmappedRuntimePaths.add(path);
        continue;
      }
      if (
        DEV_PREVIEW_CATALOG_PATH_POLICY.unsupportedPathPrefixes.some((prefix) =>
          matchesPath(path, prefix),
        )
      ) {
        unmappedRuntimePaths.add(path);
        continue;
      }
      const matching = [
        ...Object.values(DEV_PREVIEW_SERVICES).map((descriptor) => ({
          service: descriptor.service,
          acceptanceReplay: descriptor.capabilities.acceptanceReplay,
          activationBuild: false,
          changedPaths: devPreviewChangedPaths(descriptor),
        })),
        ...Object.values(PREVIEW_CATALOG_EXTENSIONS).map((descriptor) => ({
          service: descriptor.service,
          acceptanceReplay: descriptor.capabilities.acceptanceReplay,
          activationBuild: descriptor.capabilities.activationBuild !== null,
          changedPaths: [...descriptor.changedPaths],
        })),
      ].filter((descriptor) =>
        descriptor.changedPaths.some((candidate) =>
          matchesPath(path, candidate),
        ),
      );
      if (matching.length > 0) {
        for (const descriptor of matching) {
          if (descriptor.acceptanceReplay) services.add(descriptor.service);
          if (descriptor.activationBuild)
            activationArtifacts.add(descriptor.service);
          if (!descriptor.acceptanceReplay && !descriptor.activationBuild) {
            unmappedRuntimePaths.add(path);
          }
        }
        continue;
      }
      if (
        DEV_PREVIEW_CATALOG_PATH_POLICY.ignoredPathPrefixes.some((prefix) =>
          matchesPath(path, prefix),
        )
      )
        continue;
      unmappedRuntimePaths.add(path);
    }
    return Object.freeze({
      services: Object.freeze([...services].sort()),
      activationArtifacts: Object.freeze([...activationArtifacts].sort()),
      unmappedRuntimePaths: Object.freeze([...unmappedRuntimePaths].sort()),
    });
  }

  deriveGateRequirements(paths: readonly string[]) {
    const changed = this.deriveChangedServices(paths);
    const catalogDigest = this.currentDigest();
    const contexts: Array<
      "preview/immutable-acceptance" | "preview/activation-images"
    > = [];
    if (changed.services.length > 0)
      contexts.push("preview/immutable-acceptance");
    if (changed.activationArtifacts.length > 0)
      contexts.push("preview/activation-images");
    return Object.freeze({
      catalogDigest,
      contexts: Object.freeze(contexts),
      subjects: Object.freeze({
        "preview/immutable-acceptance": changed.services,
        "preview/activation-images": changed.activationArtifacts,
      }),
      requirementDigests: Object.freeze({
        "preview/immutable-acceptance":
          changed.services.length > 0
            ? previewGateRequirementDigest(
                catalogDigest,
                "preview/immutable-acceptance",
                changed.services,
              )
            : null,
        "preview/activation-images":
          changed.activationArtifacts.length > 0
            ? previewGateRequirementDigest(
                catalogDigest,
                "preview/activation-images",
                changed.activationArtifacts,
              )
            : null,
      }),
      unmappedRuntimePaths: changed.unmappedRuntimePaths,
    });
  }
}

function matchesPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function normalizedChangedPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1_024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
