import { createHash } from "node:crypto";

const MAX_CHANGED_PATHS = 3_000;

export const PREVIEW_GATE_CONTEXT = "preview/gate";
export const PREVIEW_ACCEPTANCE_CONTEXT = "preview/immutable-acceptance";
export const PREVIEW_ACTIVATION_CONTEXT = "preview/activation-images";

function normalizedPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function matches(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function computePreviewCatalogDigest(catalog) {
  const { catalogDigest: _ignored, ...payload } = catalog ?? {};
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)))
    .digest("hex")}`;
}

function validateCatalog(catalog) {
  if (
    !catalog ||
    catalog.schemaVersion !== 3 ||
    catalog.source !== "src/lib/server/workflows/dev-preview-registry.ts" ||
    !/^sha256:[0-9a-f]{64}$/.test(catalog.catalogDigest ?? "") ||
    catalog.catalogDigest !== computePreviewCatalogDigest(catalog) ||
    !Array.isArray(catalog.services) ||
    catalog.services.length === 0
  ) {
    throw new Error("preview service catalog is invalid");
  }
  const pathPolicy = catalog.pathPolicy;
  if (
    !pathPolicy ||
    !Array.isArray(pathPolicy.ignoredPathPrefixes) ||
    pathPolicy.ignoredPathPrefixes.length === 0 ||
    !Array.isArray(pathPolicy.unsupportedPathPrefixes) ||
    pathPolicy.unsupportedPathPrefixes.length === 0 ||
    pathPolicy.unmatchedPathPolicy !== "unsupported"
  ) {
    throw new Error("preview service catalog path policy is invalid");
  }
  for (const prefixes of [
    pathPolicy.ignoredPathPrefixes,
    pathPolicy.unsupportedPathPrefixes,
  ]) {
    if (
      prefixes.some((path) => !normalizedPath(path)) ||
      new Set(prefixes).size !== prefixes.length
    ) {
      throw new Error("preview service catalog path policy is invalid");
    }
  }
  if (
    pathPolicy.ignoredPathPrefixes.some((ignored) =>
      pathPolicy.unsupportedPathPrefixes.some(
        (unsupported) =>
          matches(ignored, unsupported) || matches(unsupported, ignored),
      ),
    )
  ) {
    throw new Error("preview service catalog path policy is ambiguous");
  }
  const serviceNames = new Set();
  for (const descriptor of catalog.services) {
    const capabilities = descriptor?.capabilities;
    const capabilityNames = [
      "acceptanceBuild",
      "acceptanceReplay",
      "activationBuild",
      "hostThrowaway",
      "hotSync",
      "previewNative",
    ];
    if (
      !descriptor ||
      typeof descriptor.service !== "string" ||
      !descriptor.service ||
      descriptor.source?.repository !== "PittampalliOrg/workflow-builder" ||
      !Array.isArray(descriptor.source?.changedPaths) ||
      descriptor.source.changedPaths.length === 0 ||
      descriptor.source.changedPaths.some((path) => !normalizedPath(path)) ||
      serviceNames.has(descriptor.service) ||
      !capabilities ||
      capabilityNames.some((name) => typeof capabilities[name] !== "boolean") ||
      capabilities.acceptanceBuild !== (descriptor.acceptance !== null) ||
      (capabilities.acceptanceReplay && !capabilities.acceptanceBuild) ||
      capabilities.activationBuild !== (descriptor.activation !== null) ||
      capabilities.hotSync !== (descriptor.development !== null) ||
      (capabilities.previewNative &&
        !descriptor.stacksRequirements?.workloadAdoption)
    ) {
      throw new Error("preview service catalog contains an invalid descriptor");
    }
    serviceNames.add(descriptor.service);
    for (const build of [descriptor.acceptance, descriptor.activation]) {
      if (
        build !== null &&
        (typeof build.image !== "string" ||
          !build.image.startsWith("ghcr.io/pittampalliorg/") ||
          typeof build.context !== "string" ||
          !normalizedPath(build.context.replace(/^\.$/, "repo-root")) ||
          typeof build.dockerfile !== "string" ||
          !normalizedPath(build.dockerfile))
      ) {
        throw new Error(
          "preview service catalog contains an invalid build contract",
        );
      }
    }
    if (
      descriptor.activation !== null &&
      descriptor.activation.statusContext !== PREVIEW_ACTIVATION_CONTEXT
    ) {
      throw new Error("preview activation status context is invalid");
    }
  }
}

export function classifyWorkflowBuilderPreviewGate(catalog, changedPaths) {
  validateCatalog(catalog);
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    changedPaths.length > MAX_CHANGED_PATHS ||
    changedPaths.some((path) => !normalizedPath(path)) ||
    new Set(changedPaths).size !== changedPaths.length
  ) {
    throw new Error("pull request changed paths are invalid or unsupported");
  }

  const services = new Set();
  const activationArtifacts = new Set();
  const requirements = new Set();
  const unsupported = new Set();
  for (const path of changedPaths) {
    if (
      catalog.pathPolicy.unsupportedPathPrefixes.some((prefix) =>
        matches(path, prefix),
      )
    ) {
      unsupported.add(path);
      continue;
    }
    const matching = catalog.services.filter((descriptor) =>
      descriptor.source.changedPaths.some((prefix) => matches(path, prefix)),
    );
    if (matching.length > 0) {
      for (const descriptor of matching) {
        let covered = false;
        if (
          descriptor.capabilities?.acceptanceBuild === true &&
          descriptor.capabilities?.acceptanceReplay === true
        ) {
          services.add(descriptor.service);
          requirements.add(PREVIEW_ACCEPTANCE_CONTEXT);
          covered = true;
        }
        if (descriptor.capabilities?.activationBuild === true) {
          activationArtifacts.add(descriptor.service);
          requirements.add(PREVIEW_ACTIVATION_CONTEXT);
          covered = true;
        }
        if (!covered) {
          unsupported.add(path);
        }
      }
      continue;
    }
    if (
      catalog.pathPolicy.ignoredPathPrefixes.some((prefix) =>
        matches(path, prefix),
      )
    )
      continue;
    unsupported.add(path);
  }

  if (unsupported.size > 0) {
    return Object.freeze({
      kind: "unsupported",
      state: "failure",
      services: Object.freeze([...services].sort()),
      activationArtifacts: Object.freeze([...activationArtifacts].sort()),
      contexts: Object.freeze([...requirements].sort()),
      unsupportedPaths: Object.freeze([...unsupported].sort()),
      description: "Preview acceptance does not cover every runtime path",
    });
  }
  if (requirements.size === 0) {
    return Object.freeze({
      kind: "not-applicable",
      state: "success",
      services: Object.freeze([]),
      activationArtifacts: Object.freeze([]),
      contexts: Object.freeze([]),
      unsupportedPaths: Object.freeze([]),
      description: "No preview acceptance required",
    });
  }
  const required = [...services].sort();
  const contexts = [...requirements].sort();
  return Object.freeze({
    kind: "evidence-required",
    state: "pending",
    services: Object.freeze(required),
    activationArtifacts: Object.freeze([...activationArtifacts].sort()),
    contexts: Object.freeze(contexts),
    unsupportedPaths: Object.freeze([]),
    description: `Preview evidence required (${contexts.length} requirement${contexts.length === 1 ? "" : "s"})`,
  });
}
