import { createHash } from "node:crypto";
import type {
  PreviewGateCatalogSnapshot,
  PreviewGateRequirements,
  PreviewGateSubordinateContext,
} from "$lib/server/application/ports";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function previewGateRequirementDigest(
  catalogDigest: `sha256:${string}`,
  context: PreviewGateSubordinateContext,
  subjects: readonly string[],
): `sha256:${string}` {
  const canonical = [...subjects].sort();
  if (
    !SHA256.test(catalogDigest) ||
    canonical.length === 0 ||
    new Set(canonical).size !== canonical.length ||
    canonical.some((subject) => !SUBJECT.test(subject))
  ) {
    throw new Error("preview gate requirement identity is invalid");
  }
  return `sha256:${createHash("sha256")
    .update(
      [
        "preview-gate-requirement-v2",
        catalogDigest,
        context,
        ...canonical,
      ].join("\0"),
    )
    .digest("hex")}`;
}

export function derivePreviewGateRequirementsFromSnapshot(
  snapshot: PreviewGateCatalogSnapshot,
  changedPaths: readonly string[],
): PreviewGateRequirements {
  const acceptance = new Set<string>();
  const activation = new Set<string>();
  const unmapped = new Set<string>();
  for (const path of changedPaths) {
    if (!normalizedPath(path)) {
      unmapped.add(path);
      continue;
    }
    if (
      snapshot.pathPolicy.unsupportedPathPrefixes.some((prefix) =>
        matchesPath(path, prefix),
      )
    ) {
      unmapped.add(path);
      continue;
    }
    const matching = snapshot.services.filter((service) =>
      service.changedPaths.some((prefix) => matchesPath(path, prefix)),
    );
    if (matching.length > 0) {
      for (const service of matching) {
        let covered = false;
        if (service.acceptanceBuild && service.acceptanceReplay) {
          acceptance.add(service.service);
          covered = true;
        }
        if (service.activationBuild) {
          activation.add(service.service);
          covered = true;
        }
        if (!covered) unmapped.add(path);
      }
    } else if (
      !snapshot.pathPolicy.ignoredPathPrefixes.some((prefix) =>
        matchesPath(path, prefix),
      )
    )
      unmapped.add(path);
  }

  const acceptanceSubjects = Object.freeze([...acceptance].sort());
  const activationSubjects = Object.freeze([...activation].sort());
  const contexts: PreviewGateSubordinateContext[] = [];
  if (acceptanceSubjects.length > 0)
    contexts.push("preview/immutable-acceptance");
  if (activationSubjects.length > 0) contexts.push("preview/activation-images");
  return Object.freeze({
    catalogDigest: snapshot.catalogDigest,
    contexts: Object.freeze(contexts),
    subjects: Object.freeze({
      "preview/immutable-acceptance": acceptanceSubjects,
      "preview/activation-images": activationSubjects,
    }),
    requirementDigests: Object.freeze({
      "preview/immutable-acceptance":
        acceptanceSubjects.length > 0
          ? previewGateRequirementDigest(
              snapshot.catalogDigest,
              "preview/immutable-acceptance",
              acceptanceSubjects,
            )
          : null,
      "preview/activation-images":
        activationSubjects.length > 0
          ? previewGateRequirementDigest(
              snapshot.catalogDigest,
              "preview/activation-images",
              activationSubjects,
            )
          : null,
    }),
    unmappedRuntimePaths: Object.freeze([...unmapped].sort()),
  });
}

function matchesPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function normalizedPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1_024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
