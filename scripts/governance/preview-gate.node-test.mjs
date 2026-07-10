import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  classifyWorkflowBuilderPreviewGate,
  computePreviewCatalogDigest,
  PREVIEW_ACCEPTANCE_CONTEXT,
  PREVIEW_ACTIVATION_CONTEXT,
  PREVIEW_GATE_CONTEXT,
} from "./preview-gate-domain.mjs";
import {
  GitHubAppWorkflowPreviewGateCredentials,
  GitHubPreviewGateAdapter,
} from "./preview-gate-github-adapter.mjs";
import { initializeWorkflowBuilderPreviewGate } from "./initialize-preview-gate.mjs";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const tuple = {
  repository: "PittampalliOrg/workflow-builder",
  pullRequestNumber: 42,
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
};

const catalogPayload = {
  schemaVersion: 3,
  source: "src/lib/server/workflows/dev-preview-registry.ts",
  pathPolicy: {
    ignoredPathPrefixes: ["docs", "README.md"],
    unsupportedPathPrefixes: [
      ".github/CODEOWNERS",
      ".github/actions",
      ".github/workflows",
      "scripts/governance",
    ],
    unmatchedPathPolicy: "unsupported",
  },
  services: [
    {
      service: "workflow-builder",
      capabilities: {
        hotSync: true,
        previewNative: true,
        acceptanceBuild: true,
        acceptanceReplay: true,
        activationBuild: false,
        hostThrowaway: true,
      },
      source: {
        repository: "PittampalliOrg/workflow-builder",
        changedPaths: ["src", "package.json"],
      },
      development: {},
      acceptance: {
        image: "ghcr.io/pittampalliorg/workflow-builder",
        context: ".",
        dockerfile: "Dockerfile",
      },
      activation: null,
      stacksRequirements: {
        workloadAdoption: { deployment: "workflow-builder" },
      },
    },
    {
      service: "host-only",
      capabilities: {
        hotSync: false,
        previewNative: false,
        acceptanceBuild: false,
        acceptanceReplay: false,
        activationBuild: true,
        hostThrowaway: false,
      },
      source: {
        repository: "PittampalliOrg/workflow-builder",
        changedPaths: ["services/host-only"],
      },
      development: null,
      acceptance: null,
      activation: {
        image: "ghcr.io/pittampalliorg/dev-sync-sidecar",
        context: "services/dev-sync-sidecar",
        dockerfile: "services/dev-sync-sidecar/Dockerfile",
        statusContext: PREVIEW_ACTIVATION_CONTEXT,
      },
      stacksRequirements: { workloadAdoption: null },
    },
  ],
};
const catalog = {
  ...catalogPayload,
  catalogDigest: computePreviewCatalogDigest(catalogPayload),
};

test("classifies mapped runtime, unrelated, and unsupported changes", () => {
  assert.deepEqual(
    classifyWorkflowBuilderPreviewGate(catalog, ["src/routes/new.ts"]),
    {
      kind: "evidence-required",
      state: "pending",
      services: ["workflow-builder"],
      activationArtifacts: [],
      contexts: [PREVIEW_ACCEPTANCE_CONTEXT],
      unsupportedPaths: [],
      description: "Preview evidence required (1 requirement)",
    },
  );
  assert.equal(
    classifyWorkflowBuilderPreviewGate(catalog, ["docs/preview.md"]).kind,
    "not-applicable",
  );
  assert.deepEqual(
    classifyWorkflowBuilderPreviewGate(catalog, ["services/unknown/app.py"])
      .unsupportedPaths,
    ["services/unknown/app.py"],
  );
  assert.deepEqual(
    classifyWorkflowBuilderPreviewGate(catalog, ["future-build-config.toml"])
      .unsupportedPaths,
    ["future-build-config.toml"],
  );
  assert.deepEqual(
    classifyWorkflowBuilderPreviewGate(catalog, [
      "services/host-only/server.mjs",
    ]).contexts,
    [PREVIEW_ACTIVATION_CONTEXT],
  );
});

test("trusted governance surfaces fail closed under the current catalog", async () => {
  const currentCatalog = JSON.parse(
    await readFile(
      new URL(
        "../../services/shared/dev-preview-service-catalog.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const path of [
    ".github/CODEOWNERS",
    ".github/actions/preview-helper/action.yml",
    ".github/workflows/preview-governance-gate.yml",
    ".github/workflows/unrelated-new-workflow.yml",
    "scripts/governance/preview-gate-domain.mjs",
    "scripts/sync-dev-preview-service-catalog.ts",
    "services/shared/dev-preview-service-catalog.json",
    "src/lib/server/application/adapters/preview-control.ts",
    "src/lib/server/application/preview-gate-reconciler.ts",
    "src/routes/api/internal/preview-control/activation-images/+server.ts",
  ]) {
    const result = classifyWorkflowBuilderPreviewGate(currentCatalog, [path]);
    assert.equal(result.kind, "unsupported", path);
    assert.deepEqual(result.unsupportedPaths, [path]);
  }
  assert.equal(
    classifyWorkflowBuilderPreviewGate(currentCatalog, ["docs/preview.md"])
      .kind,
    "not-applicable",
  );
  const dockerignore = classifyWorkflowBuilderPreviewGate(currentCatalog, [
    ".dockerignore",
  ]);
  assert.equal(dockerignore.kind, "unsupported");
  assert.equal(dockerignore.state, "failure");
  assert.deepEqual(dockerignore.unsupportedPaths, [".dockerignore"]);
  assert.ok(dockerignore.services.includes("workflow-builder"));
  const mixed = classifyWorkflowBuilderPreviewGate(currentCatalog, [
    "src/routes/new.ts",
    ".github/workflows/exfiltrate-app-key.yml",
  ]);
  assert.equal(mixed.kind, "unsupported");
  assert.deepEqual(mixed.services, ["workflow-builder"]);
  assert.deepEqual(mixed.unsupportedPaths, [
    ".github/workflows/exfiltrate-app-key.yml",
  ]);
});

test("initializer always publishes the aggregate and conditionally the subordinate", async () => {
  const publications = [];
  let inspections = 0;
  const github = {
    inspect: async (input) => {
      inspections += 1;
      assert.deepEqual(input, tuple);
      return { ...tuple, changedPaths: ["src/routes/new.ts"] };
    },
    publish: async (input, status) => publications.push({ input, status }),
  };
  await initializeWorkflowBuilderPreviewGate({ tuple, catalog, github });
  assert.equal(inspections, 2);
  assert.deepEqual(
    publications.map(({ status }) => status.context).sort(),
    [PREVIEW_ACCEPTANCE_CONTEXT, PREVIEW_GATE_CONTEXT].sort(),
  );

  publications.length = 0;
  github.inspect = async () => ({ ...tuple, changedPaths: ["docs/readme.md"] });
  await initializeWorkflowBuilderPreviewGate({ tuple, catalog, github });
  assert.deepEqual(
    publications.map(({ status }) => [status.context, status.state]),
    [[PREVIEW_GATE_CONTEXT, "success"]],
  );
});

test("GitHub adapter rejects a stale tuple and bounds status contexts", async () => {
  const stale = new GitHubPreviewGateAdapter({
    token: "token",
    fetch: async () =>
      new Response(
        JSON.stringify({
          state: "open",
          changed_files: 1,
          base: {
            ref: "main",
            sha: "c".repeat(40),
            repo: { full_name: tuple.repository },
          },
          head: {
            sha: tuple.headSha,
            repo: { full_name: tuple.repository },
          },
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(stale.inspect(tuple), /stale or mismatched/);
  await assert.rejects(
    stale.publish(tuple, {
      context: "checks",
      state: "success",
      description: "not allowed",
    }),
    /status is invalid/,
  );
});

test("initializer exchanges the App key for a repo-only status token", async () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let request;
  const credentials = new GitHubAppWorkflowPreviewGateCredentials({
    appId: "2970091",
    installationId: "112998814",
    privateKey,
    now: () => new Date("2026-07-10T12:00:00.000Z"),
    fetch: async (url, init) => {
      request = { url, init };
      return Response.json({ token: "short-lived-token" });
    },
  });
  assert.equal(await credentials.token(), "short-lived-token");
  assert.equal(
    request.url,
    "https://api.github.com/app/installations/112998814/access_tokens",
  );
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    repositories: ["workflow-builder"],
    permissions: {
      contents: "read",
      pull_requests: "read",
      statuses: "write",
    },
  });
  assert.match(
    request.init.headers.Authorization,
    /^Bearer [^.]+\.[^.]+\.[^.]+$/,
  );
});

test("workflow is always-on, base-pinned, and grants only bounded write authority", async () => {
  const workflow = await readFile(
    new URL(
      "../../.github/workflows/preview-governance-gate.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /\n\s+paths:/);
  assert.doesNotMatch(workflow, /statuses: write/);
  assert.doesNotMatch(workflow, /GITHUB_TOKEN:/);
  assert.match(workflow, /PREVIEW_CONTROL_GITHUB_APP_ID: "2970091"/);
  assert.match(
    workflow,
    /PREVIEW_CONTROL_GITHUB_APP_INSTALLATION_ID: "112998814"/,
  );
  assert.match(workflow, /secrets\.PREVIEW_CONTROL_GITHUB_APP_PRIVATE_KEY/);
  assert.match(
    workflow,
    /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/,
  );
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  );
  assert.match(workflow, /persist-credentials: false/);
});
