import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYNC_PATHS,
  DEV_PREVIEW_CATALOG_DIGEST,
  DEV_PREVIEW_SERVICES,
  PREVIEW_CATALOG_EXTENSIONS,
  canonicalDevPreviewServices,
  canonicalPreviewAcceptanceServices,
  devPreviewCaptureMappings,
  devPreviewCaptureOnly,
  devPreviewChangedPaths,
  devPreviewCommands,
  devPreviewSandboxName,
  devPreviewSyncPaths,
  resolveRequestedDevPreviewServiceSet,
  resolveDevPreviewDescriptor,
  resolveDevPreviewImage,
  resolvePreviewAcceptanceBuild,
  resolveRequestedPreviewAcceptanceServiceSet,
  serializeDevPreviewCatalog,
} from "./dev-preview-registry";

describe("dev-preview registry", () => {
  it("matches the sandbox-execution-api canonical Sandbox identity", () => {
    expect(devPreviewSandboxName("exec-1", "workflow-builder")).toBe(
      "wfb-dev-preview-workflow-builder-exec-1",
    );
    expect(
      devPreviewSandboxName(
        `Execution_${"A".repeat(80)}`,
        "workflow-orchestrator",
      ),
    ).toBe(
      "wfb-dev-preview-workflow-orchestrator-execution-aaaa-264a01ed8c",
    );
  });

  it("resolves explicit syncPaths, else the language-family default", () => {
    // Explicit list wins.
    expect(
      devPreviewSyncPaths(DEV_PREVIEW_SERVICES["workflow-orchestrator"]),
    ).toEqual([
      "app.py",
      "core",
      "activities",
      "workflows",
      "tests",
      "subscriptions",
      "requirements.txt",
      "pyproject.toml",
      "uv.lock",
    ]);
    // mcp-gateway omits syncPaths and inherits dependency manifests too.
    expect(devPreviewSyncPaths(DEV_PREVIEW_SERVICES["mcp-gateway"])).toEqual(
      DEFAULT_SYNC_PATHS.node,
    );
    expect(
      devPreviewSyncPaths(DEV_PREVIEW_SERVICES["workflow-mcp-server"]),
    ).toEqual(["src", "config", "package.json", "pnpm-lock.yaml"]);
  });

  it("builds the /__run allowlist from depsCommand + testCommands", () => {
    // BFF: dependency, migration, contract, and CI gate actions.
    expect(
      devPreviewCommands(DEV_PREVIEW_SERVICES["workflow-builder"]),
    ).toEqual({
      deps: "CI=true pnpm install --no-frozen-lockfile",
      migrate: "node scripts/db-migrate-runtime.mjs",
      contract:
        "node_modules/.bin/vitest run src/routes/api/internal/workflow-data/workflow-data-contract.test.ts",
      check: "pnpm check",
      "test-unit": "pnpm test:unit",
      boundaries: "pnpm check:boundaries",
    });
    // Orchestrator: python deps + a pytest contract lane.
    expect(
      devPreviewCommands(DEV_PREVIEW_SERVICES["workflow-orchestrator"]),
    ).toEqual({
      deps: "pip install -r requirements.txt && touch /app/app.py",
      contract:
        "python -m pytest tests/test_workflow_data_activity_migration.py -q",
    });
    // Pyproject edits are synced and can refresh the editable install in-place.
    expect(
      devPreviewCommands(DEV_PREVIEW_SERVICES["swebench-coordinator"]),
    ).toEqual({
      deps: "pip install -e . && touch src/app.py",
    });
  });

  it("keeps Node dev images independent of root-scoped Corepack state", () => {
    const images = [
      [
        "skaffold/dev/workflow-builder/Dockerfile.dev",
        "/app/node_modules/.bin/vite",
      ],
      [
        "skaffold/dev/function-router/Dockerfile.dev",
        "/app/node_modules/.bin/tsx",
      ],
      ["skaffold/dev/mcp-gateway/Dockerfile.dev", "/app/node_modules/.bin/tsx"],
      [
        "skaffold/dev/workflow-mcp-server/Dockerfile.dev",
        "/app/node_modules/.bin/tsx",
      ],
    ] as const;

    for (const [path, executable] of images) {
      const dockerfile = readFileSync(join(process.cwd(), path), "utf8");
      expect(dockerfile).toContain("RUN npm install -g pnpm@${PNPM_VERSION}");
      expect(dockerfile).toContain("ENV HOME=/home/dev-runtime");
      expect(dockerfile).toContain("ENV npm_config_store_dir=/app/.pnpm-store");
      expect(dockerfile).toContain("USER 1001:1001");
      expect(dockerfile).toContain(executable);
      expect(dockerfile).not.toContain("corepack prepare");
    }

    expect(
      readFileSync(join(process.cwd(), ".dockerignore"), "utf8"),
    ).toContain("**/node_modules/");
  });

  it("keeps the workflow-builder on the sidecar transport", () => {
    const descriptor = resolveDevPreviewDescriptor("workflow-builder", {});
    expect(descriptor.syncMode).toBe("sidecar");
    expect(descriptor.syncPort).toBe(8001);

    const resolved = resolveDevPreviewDescriptor("workflow-builder", {
      WFB_DEV_SYNC_MODE: "sidecar",
    });
    expect(resolved.syncMode).toBe("sidecar");
    expect(resolved.syncPort).toBe(8001);
    // Everything else is preserved (adopt + functional stay intact).
    expect(resolved.capabilities.previewNative?.service).toBe(
      "workflow-builder",
    );
    expect(resolved.functional).toBe(true);

    // A service already in sidecar mode is untouched by the flag.
    const orch = resolveDevPreviewDescriptor("workflow-orchestrator", {
      WFB_DEV_SYNC_MODE: "sidecar",
    });
    expect(orch.syncMode).toBe("sidecar");
    expect(orch.syncPort).toBe(8001);
    expect(orch.previewNativeEnvFrom).toEqual([
      { configMapRef: { name: "workflow-orchestrator-config" } },
      { configMapRef: { name: "workflow-orchestrator-otel-config" } },
      { configMapRef: { name: "workflow-orchestrator-dapr-config" } },
      {
        secretRef: {
          name: "workflow-orchestrator-secrets",
          optional: true,
        },
      },
    ]);

    expect(
      DEV_PREVIEW_SERVICES["function-router"].previewNativeEnvFrom,
    ).toEqual([
      { configMapRef: { name: "function-router-config" } },
      { configMapRef: { name: "function-router-dapr-config" } },
      { secretRef: { name: "function-router-secrets", optional: true } },
    ]);
  });

  it("declares the mcp-gateway preview adoption and live-sync contract", () => {
    const gw = DEV_PREVIEW_SERVICES["mcp-gateway"];
    expect(gw.syncMode).toBe("sidecar");
    expect(gw.port).toBe(8080);
    expect(gw.healthPath).toBe("/health");
    expect(gw.repoSubdir).toBe("services/mcp-gateway");
    expect(gw.capabilities.previewNative).toEqual({
      deployment: "mcp-gateway",
      service: "mcp-gateway",
      daprAppId: null,
    });
    expect(gw.capabilities.acceptanceReplay).toBe(true);
    expect(gw.envFrom).toEqual([
      { secretRef: { name: "workflow-builder-secrets" } },
    ]);
    expect(gw.extraEnv).toEqual({
      WORKFLOW_BUILDER_URL:
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
      OTEL_SDK_DISABLED: "true",
    });

    const orchestrator = resolveDevPreviewDescriptor("workflow-orchestrator");
    expect(orchestrator.extraEnv).toEqual({
      WORKFLOW_DATA_READ_MODEL_STARTUP_TIMEOUT_SECONDS: "300",
      WORKFLOW_DATA_READ_MODEL_STARTUP_RETRY_INTERVAL_SECONDS: "1",
    });

    const wf = DEV_PREVIEW_SERVICES["workflow-mcp-server"];
    expect(wf.syncMode).toBe("sidecar");
    expect(wf.port).toBe(3200);
    expect(wf.healthPath).toBe("/health");
    expect(wf.capabilities.previewNative).toMatchObject({
      deployment: "workflow-mcp-server",
      service: "workflow-mcp-server",
    });
    expect(wf.previewNativeEnvFrom).toEqual([
      { secretRef: { name: "workflow-builder-secrets" } },
    ]);
  });

  it("wires the B4 contract paths on both sides of the boundary", () => {
    // BFF syncs the shared contract into its cwd so the contract vitest sees it.
    expect(DEV_PREVIEW_SERVICES["workflow-builder"].syncPaths).toContain(
      "services/shared/workflow-data-contract",
    );
    // Orchestrator stages the same contract into its baked fixture dir via extraSync.
    expect(DEV_PREVIEW_SERVICES["workflow-orchestrator"].extraSync).toEqual([
      {
        from: "../shared/workflow-data-contract",
        to: ".contract-fixtures",
      },
    ]);
    expect(
      devPreviewCaptureMappings(DEV_PREVIEW_SERVICES["workflow-orchestrator"]),
    ).toContainEqual({
      from: ".contract-fixtures",
      to: "services/shared/workflow-data-contract",
    });
    expect(
      devPreviewChangedPaths(DEV_PREVIEW_SERVICES["workflow-orchestrator"]),
    ).toContain("services/shared/workflow-data-contract");
  });

  it("routes root Docker context exclusions through immutable acceptance", () => {
    expect(
      devPreviewChangedPaths(DEV_PREVIEW_SERVICES["workflow-builder"]),
    ).toContain(".dockerignore");
  });

  it("stages Dockerfiles under hidden capture-only paths and maps them back", () => {
    const descriptor = DEV_PREVIEW_SERVICES["workflow-orchestrator"];
    expect(devPreviewCaptureOnly(descriptor)).toEqual([
      {
        from: "Dockerfile",
        to: ".preview-capture/production.Dockerfile",
      },
      {
        from: "../../skaffold/dev/workflow-orchestrator/Dockerfile.dev",
        to: ".preview-capture/development.Dockerfile",
      },
    ]);
    expect(devPreviewCaptureMappings(descriptor)).toEqual(
      expect.arrayContaining([
        {
          from: ".preview-capture/production.Dockerfile",
          to: "services/workflow-orchestrator/Dockerfile",
        },
        {
          from: ".preview-capture/development.Dockerfile",
          to: "skaffold/dev/workflow-orchestrator/Dockerfile.dev",
        },
      ]),
    );
    expect(devPreviewSyncPaths(descriptor)).not.toContain("Dockerfile");
    expect(devPreviewSyncPaths(descriptor)).not.toContain(
      "../../skaffold/dev/workflow-orchestrator/Dockerfile.dev",
    );
  });

  it("canonicalizes requested service sets and reports every unsupported entry", () => {
    expect(canonicalDevPreviewServices("preview-native")).toEqual([
      "function-router",
      "mcp-gateway",
      "workflow-builder",
      "workflow-mcp-server",
      "workflow-orchestrator",
    ]);
    expect(
      resolveRequestedDevPreviewServiceSet(
        [
          "workflow-builder",
          "mcp-gateway",
          "swebench-coordinator",
          "missing",
          "workflow-builder",
        ],
        "preview-native",
      ),
    ).toEqual({
      services: ["mcp-gateway", "workflow-builder"],
      rejected: [
        { service: "missing", reason: "unknown-service" },
        { service: "swebench-coordinator", reason: "unsupported-capability" },
      ],
    });
  });

  it("separates hot-sync, immutable replay, and activation-only catalog entries", () => {
    expect(canonicalPreviewAcceptanceServices()).toEqual([
      "function-router",
      "mcp-gateway",
      "sandbox-execution-api",
      "workflow-builder",
      "workflow-mcp-server",
      "workflow-orchestrator",
    ]);
    expect(
      resolveRequestedPreviewAcceptanceServiceSet([
        "sandbox-execution-api",
        "dev-sync-sidecar",
        "missing",
      ]),
    ).toEqual({
      services: ["sandbox-execution-api"],
      rejected: [
        { service: "dev-sync-sidecar", reason: "unsupported-capability" },
        { service: "missing", reason: "unknown-service" },
      ],
    });
    expect(resolvePreviewAcceptanceBuild("sandbox-execution-api")).toEqual({
      image: "ghcr.io/pittampalliorg/sandbox-execution-api",
      context: "services/sandbox-execution-api",
      dockerfile: "services/sandbox-execution-api/Dockerfile",
    });
    expect(resolvePreviewAcceptanceBuild("mcp-gateway")).toEqual({
      image: "ghcr.io/pittampalliorg/mcp-gateway",
      context: ".",
      dockerfile: "services/mcp-gateway/Dockerfile",
    });
    expect(
      PREVIEW_CATALOG_EXTENSIONS["dev-sync-sidecar"].capabilities
        .activationBuild,
    ).toEqual(
      expect.objectContaining({
        pipeline: "build-dev-sync-sidecar-activation",
        statusContext: "preview/activation-images",
      }),
    );
  });

  it("keeps the checked catalog artifact byte-for-byte deterministic", () => {
    const artifact = readFileSync(
      join(process.cwd(), "services/shared/dev-preview-service-catalog.json"),
      "utf8",
    );
    expect(artifact).toBe(serializeDevPreviewCatalog());
    const document = JSON.parse(artifact);
    expect(document.catalogDigest).toBe(DEV_PREVIEW_CATALOG_DIGEST);
    expect(document.schemaVersion).toBe(3);
    expect(document.pathPolicy).toEqual({
      ignoredPathPrefixes: expect.arrayContaining(["docs", "README.md"]),
      unsupportedPathPrefixes: expect.arrayContaining([
        ".github/CODEOWNERS",
        ".github/actions",
        ".github/workflows",
      ]),
      unmatchedPathPolicy: "unsupported",
    });
    for (const service of document.services) {
      expect(service.capabilities).toEqual({
        acceptanceBuild: expect.any(Boolean),
        acceptanceReplay: expect.any(Boolean),
        activationBuild: expect.any(Boolean),
        hostThrowaway: expect.any(Boolean),
        hotSync: expect.any(Boolean),
        previewNative: expect.any(Boolean),
      });
      if (service.capabilities.acceptanceBuild) {
        expect(service.acceptance).toEqual({
          context: expect.any(String),
          dockerfile: expect.any(String),
          image: expect.stringMatching(/^ghcr\.io\/pittampalliorg\//),
        });
      } else {
        expect(service.acceptance).toBeNull();
      }
      expect(service.stacksRequirements).toHaveProperty("workloadAdoption");
      expect(service.stacksRequirements).not.toHaveProperty(
        "tailnetLoadBalancer",
      );
      if (service.service === "workflow-builder") {
        expect(service.stacksRequirements.externalRoutes).toEqual([
          {
            backendPort: 3000,
            backendService: "workflow-builder",
            pathPrefix: "/",
            tlsTermination: "host",
          },
        ]);
      } else if (service.service === "workflow-mcp-server") {
        expect(service.stacksRequirements.externalRoutes).toEqual([
          {
            backendPort: 3200,
            backendService: "workflow-mcp-server",
            pathPrefix: "/mcp",
            tlsTermination: "host",
          },
        ]);
      } else {
        expect(service.stacksRequirements.externalRoutes).toEqual([]);
      }
    }
    const sandbox = document.services.find(
      (service: { service: string }) =>
        service.service === "sandbox-execution-api",
    );
    expect(sandbox).toMatchObject({
      capabilities: {
        acceptanceBuild: true,
        acceptanceReplay: true,
        activationBuild: false,
        hotSync: false,
        previewNative: false,
      },
      development: null,
      stacksRequirements: {
        workloadAdoption: {
          deployment: "sandbox-execution-api",
          service: "sandbox-execution-api",
        },
      },
    });
    const sidecar = document.services.find(
      (service: { service: string }) => service.service === "dev-sync-sidecar",
    );
    expect(sidecar).toMatchObject({
      capabilities: {
        acceptanceBuild: false,
        acceptanceReplay: false,
        activationBuild: true,
        hotSync: false,
        previewNative: false,
      },
      acceptance: null,
      activation: {
        pipeline: "build-dev-sync-sidecar-activation",
        statusContext: "preview/activation-images",
      },
      development: null,
    });
  });

  it("throws on an unknown service", () => {
    expect(() => resolveDevPreviewDescriptor("nope", {})).toThrow(
      /Unknown dev-preview service/,
    );
  });

  it("resolves immutable stacks pins file-first and fails closed", () => {
    const d = DEV_PREVIEW_SERVICES["workflow-builder"];
    const dir = mkdtempSync(join(tmpdir(), "dpr-"));
    const pinFile = join(dir, "runtime-images.json");
    const fileImage = `${d.devBuild.image}@sha256:${"1".repeat(64)}`;
    const envImage = `${d.devBuild.image}:git-${"a".repeat(40)}`;
    writeFileSync(pinFile, JSON.stringify({ [d.imageEnvKey]: fileImage }));
    // file wins over the env pin
    expect(
      resolveDevPreviewImage(d, {
        WORKFLOW_BUILDER_IMAGE_PINS_FILE: pinFile,
        [d.imageEnvKey]: envImage,
      }),
    ).toBe(fileImage);
    // no file → env pin
    expect(resolveDevPreviewImage(d, { [d.imageEnvKey]: envImage })).toBe(
      envImage,
    );
    expect(() => resolveDevPreviewImage(d, {})).toThrow(/Missing required/);
    expect(() =>
      resolveDevPreviewImage(d, {
        [d.imageEnvKey]: `${d.devBuild.image}:latest`,
      }),
    ).toThrow(/pinned by digest or full git SHA/);
  });
});
