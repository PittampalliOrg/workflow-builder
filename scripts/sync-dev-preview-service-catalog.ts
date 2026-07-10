import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEV_PREVIEW_CATALOG_DIGEST,
  DEV_PREVIEW_CATALOG_PATH_POLICY,
  DEV_PREVIEW_SERVICES,
  PREVIEW_CATALOG_EXTENSIONS,
  devPreviewSyncPaths,
  serializeDevPreviewCatalog,
} from "../src/lib/server/workflows/dev-preview-registry";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) {
  throw new Error("[dev-preview-catalog] --output requires a path");
}
const artifact =
  outputIndex >= 0
    ? resolve(process.cwd(), process.argv[outputIndex + 1])
    : resolve(root, "services/shared/dev-preview-service-catalog.json");

function fail(message: string): never {
  throw new Error(`[dev-preview-catalog] ${message}`);
}

function assertCatalog(): void {
  const pathPolicyGroups = [
    DEV_PREVIEW_CATALOG_PATH_POLICY.ignoredPathPrefixes,
    DEV_PREVIEW_CATALOG_PATH_POLICY.unsupportedPathPrefixes,
  ];
  for (const prefixes of pathPolicyGroups) {
    if (
      prefixes.length === 0 ||
      new Set(prefixes).size !== prefixes.length ||
      prefixes.some(
        (path) =>
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path
            .split("/")
            .some((part) => !part || part === "." || part === ".."),
      )
    ) {
      fail("catalog changed-path policy is invalid");
    }
  }
  if (
    DEV_PREVIEW_CATALOG_PATH_POLICY.ignoredPathPrefixes.some((ignored) =>
      DEV_PREVIEW_CATALOG_PATH_POLICY.unsupportedPathPrefixes.some(
        (unsupported) =>
          ignored === unsupported ||
          ignored.startsWith(`${unsupported}/`) ||
          unsupported.startsWith(`${ignored}/`),
      ),
    )
  ) {
    fail("catalog changed-path policy is ambiguous");
  }
  const envKeys = new Set<string>();
  const hostnameRoles = new Set<string>();
  for (const [key, descriptor] of Object.entries(DEV_PREVIEW_SERVICES)) {
    if (key !== descriptor.service) {
      fail(`registry key ${key} does not match service ${descriptor.service}`);
    }
    if (envKeys.has(descriptor.imageEnvKey)) {
      fail(`duplicate image env key ${descriptor.imageEnvKey}`);
    }
    envKeys.add(descriptor.imageEnvKey);
    const hostnameRole = descriptor.tailnetHostnameRole;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostnameRole)) {
      fail(`invalid tailnet hostname role ${hostnameRole}`);
    }
    if (hostnameRoles.has(hostnameRole)) {
      fail(`duplicate tailnet hostname role ${hostnameRole}`);
    }
    hostnameRoles.add(hostnameRole);

    for (const build of [
      descriptor.devBuild,
      descriptor.capabilities.acceptanceBuild,
    ]) {
      if (!existsSync(resolve(root, build.context))) {
        fail(
          `${descriptor.service} build context does not exist: ${build.context}`,
        );
      }
      if (!existsSync(resolve(root, build.dockerfile))) {
        fail(
          `${descriptor.service} Dockerfile does not exist: ${build.dockerfile}`,
        );
      }
      if (/:(?:latest|main|master)$/i.test(build.image)) {
        fail(
          `${descriptor.service} build image must be an untagged repository`,
        );
      }
    }

    const syncPaths = new Set(devPreviewSyncPaths(descriptor));
    if (descriptor.language === "node") {
      for (const manifest of ["package.json", "pnpm-lock.yaml"]) {
        if (!syncPaths.has(manifest)) {
          fail(
            `${descriptor.service} syncPaths omits dependency input ${manifest}`,
          );
        }
      }
    }
    if (
      descriptor.language === "python" &&
      descriptor.depsCommand &&
      !["requirements.txt", "pyproject.toml"].some((path) =>
        syncPaths.has(path),
      )
    ) {
      fail(
        `${descriptor.service} syncPaths omits its Python dependency manifest`,
      );
    }

    const adoption = descriptor.capabilities.previewNative;
    if (adoption && (!adoption.deployment || !adoption.service)) {
      fail(
        `${descriptor.service} preview-native adoption names are incomplete`,
      );
    }
  }
  for (const [key, descriptor] of Object.entries(PREVIEW_CATALOG_EXTENSIONS)) {
    if (key !== descriptor.service) {
      fail(
        `catalog extension key ${key} does not match service ${descriptor.service}`,
      );
    }
    if (descriptor.changedPaths.length === 0) {
      fail(`${descriptor.service} catalog extension has no changed paths`);
    }
    if (
      descriptor.capabilities.acceptanceReplay !==
      (descriptor.capabilities.acceptanceBuild !== null)
    ) {
      fail(
        `${descriptor.service} acceptance replay/build capabilities disagree`,
      );
    }
    for (const build of [
      descriptor.capabilities.acceptanceBuild,
      descriptor.capabilities.activationBuild,
    ]) {
      if (!build) continue;
      if (!existsSync(resolve(root, build.context))) {
        fail(
          `${descriptor.service} build context does not exist: ${build.context}`,
        );
      }
      if (!existsSync(resolve(root, build.dockerfile))) {
        fail(
          `${descriptor.service} Dockerfile does not exist: ${build.dockerfile}`,
        );
      }
      if (/:(?:latest|main|master)$/i.test(build.image)) {
        fail(
          `${descriptor.service} build image must be an untagged repository`,
        );
      }
    }
  }
}

assertCatalog();
const expected = serializeDevPreviewCatalog();
if (check) {
  const actual = existsSync(artifact) ? readFileSync(artifact, "utf8") : "";
  if (actual !== expected) {
    fail(
      `${artifact} is stale; run pnpm catalog:dev-preview:generate (expected ${DEV_PREVIEW_CATALOG_DIGEST})`,
    );
  }
  console.log(`[dev-preview-catalog] ${DEV_PREVIEW_CATALOG_DIGEST} is current`);
} else {
  if (!artifact.endsWith(".json") || !existsSync(dirname(artifact))) {
    fail(`output must be a JSON file in an existing directory: ${artifact}`);
  }
  writeFileSync(artifact, expected);
  console.log(
    `[dev-preview-catalog] wrote ${artifact} (${DEV_PREVIEW_CATALOG_DIGEST})`,
  );
}
