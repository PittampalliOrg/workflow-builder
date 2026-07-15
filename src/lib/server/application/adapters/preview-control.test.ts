import { describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher } from "undici";
import {
  GithubPreviewControlSourceAdapter,
  GithubPreviewControlPullRequestAdapter,
  HttpPreviewAcceptanceBrokerAdapter,
  HttpPreviewDevelopmentBuildBrokerAdapter,
  HttpPreviewInfrastructureCandidateBrokerAdapter,
} from "$lib/server/application/adapters/preview-control";

const SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const ADVANCED_MAIN_SHA = "c".repeat(40);

describe("GithubPreviewControlSourceAdapter", () => {
  it("verifies the exact parent while allowing main to advance", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request, _init?: RequestInit) => {
        const value = String(url);
        if (value.includes("/git/ref/heads/preview-development-1")) {
          return new Response(JSON.stringify({ object: { sha: SHA } }), {
            status: 200,
          });
        }
        if (value.includes("/git/ref/heads/main")) {
          return new Response(
            JSON.stringify({ object: { sha: ADVANCED_MAIN_SHA } }),
            {
              status: 200,
            },
          );
        }
        if (value.includes(`/git/commits/${SHA}`)) {
          return new Response(
            JSON.stringify({ parents: [{ sha: BASE_SHA }] }),
            {
              status: 200,
            },
          );
        }
        return new Response(
          JSON.stringify({
            status: "ahead",
            merge_base_commit: { sha: BASE_SHA },
          }),
          { status: 200 },
        );
      },
    );
    const adapter = new GithubPreviewControlSourceAdapter({
      fetch,
      token: () => null,
    });
    await expect(
      adapter.verifyBranch({
        repository: "PittampalliOrg/workflow-builder",
        branch: "preview-development-1",
        commitSha: SHA as never,
        baseBranch: "main",
        baseRevision: BASE_SHA as never,
        expectedBaseHead: ADVANCED_MAIN_SHA as never,
      }),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(6);
    for (const [, init] of fetch.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    }
  });

  it("rejects when the observed base head moves during verification", async () => {
    let baseReads = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("/git/ref/heads/preview-development-1")) {
        return new Response(JSON.stringify({ object: { sha: SHA } }));
      }
      if (value.includes("/git/ref/heads/main")) {
        baseReads += 1;
        return new Response(
          JSON.stringify({
            object: {
              sha: baseReads === 1 ? ADVANCED_MAIN_SHA : "d".repeat(40),
            },
          }),
        );
      }
      if (value.includes(`/git/commits/${SHA}`)) {
        return new Response(JSON.stringify({ parents: [{ sha: BASE_SHA }] }));
      }
      return new Response(
        JSON.stringify({
          status: "ahead",
          merge_base_commit: { sha: BASE_SHA },
        }),
      );
    });
    const adapter = new GithubPreviewControlSourceAdapter({ fetch });

    await expect(
      adapter.verifyBranch({
        repository: "PittampalliOrg/workflow-builder",
        branch: "preview-development-1",
        commitSha: SHA as never,
        baseBranch: "main",
        baseRevision: BASE_SHA as never,
        expectedBaseHead: ADVANCED_MAIN_SHA as never,
      }),
    ).resolves.toBe(false);
  });

  it("uses only the dedicated token and rejects a candidate with a different parent", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request, _init?: RequestInit) => {
        const value = String(url);
        if (value.includes(`/git/commits/${SHA}`)) {
          return new Response(
            JSON.stringify({ parents: [{ sha: "9".repeat(40) }] }),
            {
              status: 200,
            },
          );
        }
        return new Response(JSON.stringify({ object: { sha: SHA } }), {
          status: 200,
        });
      },
    );
    const adapter = new GithubPreviewControlSourceAdapter({
      fetch,
      token: () => "dedicated-token",
    });
    await expect(
      adapter.verifyBranch({
        repository: "PittampalliOrg/workflow-builder",
        branch: "preview-development-1",
        commitSha: SHA as never,
        baseBranch: "main",
        baseRevision: BASE_SHA as never,
      }),
    ).resolves.toBe(false);
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dedicated-token");
  });

  it("paginates GitHub's immutable commit files and requires an exact path set", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `src/generated/file-${index}.ts`,
    }));
    const lastPath = "src/routes/feature.ts";
    const expectedChangedPaths = [
      ...firstPage.map(({ filename }) => filename),
      lastPath,
    ];
    const fetch = vi.fn(
      async (url: string | URL | Request, _init?: RequestInit) => {
        const value = String(url);
        if (value.includes("/git/ref/heads/preview-feature-1")) {
          return new Response(JSON.stringify({ object: { sha: SHA } }), {
            status: 200,
          });
        }
        if (value.includes("/git/ref/heads/main")) {
          return new Response(JSON.stringify({ object: { sha: BASE_SHA } }), {
            status: 200,
          });
        }
        if (value.includes(`/git/commits/${SHA}`)) {
          return new Response(
            JSON.stringify({ parents: [{ sha: BASE_SHA }] }),
            { status: 200 },
          );
        }
        if (value.includes(`/commits/${SHA}?`)) {
          const page = new URL(value).searchParams.get("page");
          return new Response(
            JSON.stringify({
              sha: SHA,
              files: page === "1" ? firstPage : [{ filename: lastPath }],
            }),
            {
              status: 200,
              headers:
                page === "1"
                  ? {
                      link: `<https://api.github.com/next>; rel="next"`,
                    }
                  : {},
            },
          );
        }
        throw new Error(`unexpected URL ${value}`);
      },
    );
    const adapter = new GithubPreviewControlSourceAdapter({ fetch });
    const input = {
      repository: "PittampalliOrg/workflow-builder",
      branch: "preview-feature-1",
      commitSha: SHA as never,
      baseBranch: "main",
      baseRevision: BASE_SHA as never,
      expectedChangedPaths,
    };
    await expect(adapter.verifyBranch(input)).resolves.toBe(true);
    await expect(
      adapter.verifyBranch({
        ...input,
        expectedChangedPaths: expectedChangedPaths.slice(0, -1),
      }),
    ).resolves.toBe(false);
  });
});

describe("GithubPreviewControlPullRequestAdapter", () => {
  it("derives exact open PR identity and consumes every changed-file page", async () => {
    const baseSha = "b".repeat(40);
    const headSha = "c".repeat(40);
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      filename: `packages/workloads/file-${index}.yaml`,
    }));
    const fetch = vi.fn(
      async (url: string | URL | Request, _init?: RequestInit) => {
        const value = String(url);
        if (!value.includes("/files?")) {
          return new Response(
            JSON.stringify({
              state: "open",
              draft: true,
              changed_files: 101,
              base: {
                ref: "develop",
                sha: baseSha,
                repo: { full_name: "PittampalliOrg/stacks" },
              },
              head: {
                ref: "feature/preview-change",
                sha: headSha,
                repo: { full_name: "PittampalliOrg/stacks" },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify(
            new URL(value).searchParams.get("page") === "1"
              ? firstPage
              : [{ filename: "last.yaml" }],
          ),
          { status: 200 },
        );
      },
    );
    const adapter = new GithubPreviewControlPullRequestAdapter({
      fetch,
      token: () => "read-token",
      baseBranch: "develop",
    });

    await expect(
      adapter.inspectOpen({ repository: "PittampalliOrg/stacks", number: 42 }),
    ).resolves.toMatchObject({
      baseSha,
      headRef: "feature/preview-change",
      headSha,
      changedPaths: [...firstPage.map((file) => file.filename), "last.yaml"],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer read-token",
      );
    }
  });

  it("includes both paths for renames and rejects fork, non-main, or incomplete PR authority", async () => {
    const baseSha = "b".repeat(40);
    const headSha = "c".repeat(40);
    const pull = {
      state: "open",
      draft: true,
      changed_files: 1,
      base: {
        ref: "main",
        sha: baseSha,
        repo: { full_name: "PittampalliOrg/stacks" },
      },
      head: {
        ref: "feature/preview-change",
        sha: headSha,
        repo: { full_name: "PittampalliOrg/stacks" },
      },
    };
    const files = [
      {
        filename: "packages/components/workloads/new.yaml",
        previous_filename: "packages/components/workloads/old.yaml",
        status: "renamed",
      },
    ];
    const fetch = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(String(url).includes("/files?") ? files : pull),
          {
            status: 200,
          },
        ),
    );
    const adapter = new GithubPreviewControlPullRequestAdapter({ fetch });
    await expect(
      adapter.inspectOpen({ repository: "PittampalliOrg/stacks", number: 42 }),
    ).resolves.toMatchObject({
      headRef: "feature/preview-change",
      changedPaths: [
        "packages/components/workloads/new.yaml",
        "packages/components/workloads/old.yaml",
      ],
    });

    for (const invalid of [
      { ...pull, base: { ...pull.base, ref: "release" } },
      {
        ...pull,
        head: { ...pull.head, repo: { full_name: "someone/fork" } },
      },
      { ...pull, head: { ...pull.head, ref: "unsafe..branch" } },
      { ...pull, changed_files: 2 },
    ]) {
      fetch.mockImplementation(
        async (url: string | URL | Request) =>
          new Response(
            JSON.stringify(String(url).includes("/files?") ? files : invalid),
            {
              status: 200,
            },
          ),
      );
      await expect(
        adapter.inspectOpen({
          repository: "PittampalliOrg/stacks",
          number: 42,
        }),
      ).rejects.toThrow();
    }
  });
});

describe("HttpPreviewDevelopmentBuildBrokerAdapter", () => {
  it("sends only the dedicated broker credential and validates immutable results", async () => {
    const catalogDigest = `sha256:${"e".repeat(64)}` as const;
    const identity = {
      previewName: "preview1",
      environmentRequestId: "launch-1",
      environmentPlatformRevision: "9".repeat(40),
      environmentSourceRevision: BASE_SHA,
      catalogDigest,
    };
    const importIdentity = {
      previewName: "preview1",
      requestId: "launch-1",
      executionId: "exec-1",
      sourceArtifactId: "artifact-1",
      platformRevision: identity.environmentPlatformRevision,
      sourceRevision: BASE_SHA,
      catalogDigest,
      services: ["workflow-builder"],
      captureId: "capture-1",
      generation: "generation-1",
      fileDigest: `sha256:${"f".repeat(64)}` as const,
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            previewName: "preview1",
            branch: "preview-development-1",
            sourceRevision: SHA,
            baselineRevision: BASE_SHA,
            pullRequestBase: "main",
            changedPaths: ["src/routes/feature.ts"],
            catalogDigest,
            services: [
              {
                service: "workflow-builder",
                ok: true,
                image: {
                  service: "workflow-builder",
                  sourceRevision: SHA,
                  buildId: "build-1",
                  imageRef: `ghcr.io/pittampalliorg/workflow-builder-dev:git-${SHA}`,
                  digest: `sha256:${"d".repeat(64)}`,
                  immutableRef: `ghcr.io/pittampalliorg/workflow-builder-dev@sha256:${"d".repeat(64)}`,
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const adapter = new HttpPreviewDevelopmentBuildBrokerAdapter({
      baseUrl: () => "http://preview-control-broker:3000",
      token: () => "broker-token",
      identity: () => identity,
      artifacts: {
        transfer: vi.fn(async () => ({
          id: "central-artifact-1",
          fileId: "central-file-1",
          fileDigest: importIdentity.fileDigest,
          artifact: {
            id: "artifact-1",
            executionId: "exec-1",
            kind: "source-bundle",
            fileId: "preview-file-1",
            inlinePayload: {},
            metadata: null,
          },
          importIdentity,
        })),
      },
      fetch,
    });
    const request = {
      requestId: "request-1",
      executionId: "exec-1",
      artifactId: "artifact-1",
      previewName: "preview1",
      catalogDigest,
      services: ["workflow-builder"],
    };
    await expect(adapter.build(request)).resolves.toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      "http://preview-control-broker:3000/api/internal/preview-control/development-build",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Capability": "broker-token",
        },
        body: JSON.stringify({
          ...request,
          artifactId: "central-artifact-1",
          artifactIdentity: importIdentity,
          environmentRequestId: identity.environmentRequestId,
          environmentPlatformRevision: identity.environmentPlatformRevision,
          environmentSourceRevision: identity.environmentSourceRevision,
        }),
      }),
    );
  });
});

const INFRA_PATH =
  "packages/components/workloads/workflow-builder/manifests/Deployment.yaml";

function infrastructurePullRequest() {
  return {
    repository: "PittampalliOrg/stacks",
    number: 42,
    baseSha: BASE_SHA,
    headRef: "feature/preview-infrastructure",
    headSha: SHA,
    changedPaths: [INFRA_PATH],
  };
}

function infrastructureEnvironment() {
  return {
    name: "infra-one",
    id: "infra-one",
    profile: "manifest-candidate",
    lane: "application",
    capabilities: ["namespaced-manifests"],
    placement: "dev-vcluster",
    platformRevision: SHA,
    sourceRevision: "d".repeat(40),
    catalogDigest: `sha256:${"e".repeat(64)}`,
    services: [],
    candidatePaths: [INFRA_PATH],
    owner: { kind: "user", id: "admin-1" },
    origin: { kind: "user" },
    ttlHours: 24,
    mode: "reconciled",
    imageOverrides: {},
    lifecycle: "ephemeral",
    allocation: { kind: "cold" },
    provenance: {
      requestId: "generated-request-1",
      requestedAt: "2026-07-10T12:00:00.000Z",
      platformRepository: "PittampalliOrg/stacks",
      sourceRepository: "PittampalliOrg/workflow-builder",
      parentEnvironmentId: `pull-request:PittampalliOrg/stacks#42@${SHA}`,
    },
    lifecycleState: "provisioning",
    createdAt: "2026-07-10T12:00:00.000Z",
    expiresAt: "2026-07-11T12:00:00.000Z",
    runtime: {
      placement: "dev-vcluster",
      phase: "provisioning",
      ready: false,
      url: null,
      allocationId: null,
      pooled: false,
    },
  };
}

describe("HttpPreviewInfrastructureCandidateBrokerAdapter", () => {
  const input = {
    requestId: "infra-request-1",
    name: "infra-one",
    userId: "admin-1",
    pullRequestNumber: 42,
  };

  it("accepts only the exact PR-bound operator action", async () => {
    const proof = {
      ok: false,
      status: "operator-required",
      profile: "manifest-candidate",
      lane: "management",
      pullRequest: infrastructurePullRequest(),
      changedPaths: [INFRA_PATH],
      launch: null,
      operatorAction: {
        command: "preview-management-candidate.sh",
        id: "infra-one",
        revision: SHA,
        candidatePaths: [INFRA_PATH],
      },
    };
    const fetch = vi.fn(async () => Response.json(proof, { status: 409 }));
    const adapter = new HttpPreviewInfrastructureCandidateBrokerAdapter({
      baseUrl: () => "http://preview-control-broker:3000",
      token: () => "broker-token",
      platformRepository: "PittampalliOrg/stacks",
      fetch,
    });

    await expect(adapter.launch(input)).resolves.toMatchObject(proof);
    expect(fetch).toHaveBeenCalledWith(
      "http://preview-control-broker:3000/api/internal/preview-control/infrastructure-candidate",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-Preview-Control-Broker-Token": "broker-token",
        },
        body: JSON.stringify(input),
      }),
    );
  });

  it("rejects stale PR, operator, and nested launch identities", async () => {
    const valid = {
      ok: true,
      status: "launched",
      profile: "manifest-candidate",
      lane: "application",
      pullRequest: infrastructurePullRequest(),
      changedPaths: [INFRA_PATH],
      launch: { ok: true, environment: infrastructureEnvironment() },
    };
    const invalid = [
      {
        ...valid,
        pullRequest: { ...valid.pullRequest, number: 43 },
      },
      {
        ...valid,
        changedPaths: ["packages/another.yaml"],
      },
      {
        ...valid,
        launch: {
          ok: true,
          environment: {
            ...infrastructureEnvironment(),
            platformRevision: "f".repeat(40),
          },
        },
      },
      {
        ...valid,
        launch: {
          ok: true,
          environment: {
            ...infrastructureEnvironment(),
            provenance: {
              ...infrastructureEnvironment().provenance,
              parentEnvironmentId: "pull-request:stale",
            },
          },
        },
      },
    ];
    for (const proof of invalid) {
      const adapter = new HttpPreviewInfrastructureCandidateBrokerAdapter({
        baseUrl: () => "http://preview-control-broker:3000",
        token: () => "broker-token",
        fetch: vi.fn(async () => Response.json(proof, { status: 202 })),
      });
      await expect(adapter.launch(input)).rejects.toThrow(/proof/);
    }
  });
});

const ACCEPTANCE_DIGEST = `sha256:${"e".repeat(64)}` as const;
const ACCEPTANCE_NAME = `accept-pr42-${SHA.slice(0, 12)}`;
const CLEANUP_CHECK_NAMES = [
  "runner-succeeded",
  "preview-environment-absent",
  "application-absent",
  "agent-registration-absent",
  "agent-namespaces-absent",
  "database-absent",
  "nats-stream-absent",
  "headlamp-registration-absent",
  "tailnet-egress-absent",
  "host-namespace-absent",
  "storage-scope-absent",
  "runner-identity-absent",
] as const;

function acceptanceInput() {
  return {
    requestId: "accept-request-1",
    previewName: "preview1",
    pullRequest: {
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      baseSha: BASE_SHA as never,
      headSha: SHA as never,
    },
  };
}

function acceptanceProof() {
  const digest = `sha256:${"d".repeat(64)}`;
  return {
    ok: true,
    name: ACCEPTANCE_NAME,
    previewName: "preview1",
    pullRequest: acceptanceInput().pullRequest,
    services: ["workflow-builder"],
    images: [
      {
        service: "workflow-builder",
        sourceRevision: SHA,
        buildId: "build-1",
        imageRef: `ghcr.io/pittampalliorg/workflow-builder:git-${SHA}`,
        digest,
        immutableRef: `ghcr.io/pittampalliorg/workflow-builder@${digest}`,
      },
    ],
    verification: {
      ok: true,
      checks: [{ name: "bff-health", ok: true }],
    },
    cleanup: {
      name: ACCEPTANCE_NAME,
      resourceName: ACCEPTANCE_NAME,
      complete: true,
      phase: "complete",
      checks: Object.fromEntries(
        CLEANUP_CHECK_NAMES.map((name) => [name, true]),
      ),
      message: null,
    },
  };
}

function acceptanceAdapter(proof: unknown, status = 200) {
  return new HttpPreviewAcceptanceBrokerAdapter({
    baseUrl: () => "http://preview-control-broker:3000",
    token: () => "c".repeat(64),
    identity: () => ({
      previewName: "preview1",
      environmentRequestId: "environment-request-1",
      environmentPlatformRevision: "9".repeat(40),
      environmentSourceRevision: BASE_SHA,
      catalogDigest: ACCEPTANCE_DIGEST,
    }),
    catalog: {
      listPreviewNativeServices: () => ["workflow-builder"],
      assertPreviewNativeServices: (services) => {
        if (services.length !== 1 || services[0] !== "workflow-builder") {
          throw new Error("unsupported service");
        }
        return services;
      },
      assertAcceptanceReplayServices: (services) => {
        if (services.length !== 1 || services[0] !== "workflow-builder") {
          throw new Error("unsupported acceptance service");
        }
        return services;
      },
      acceptanceImageRepository: (service) =>
        `ghcr.io/pittampalliorg/${service}`,
    },
    fetch: vi.fn(async () => Response.json(proof, { status })),
  });
}

describe("HttpPreviewAcceptanceBrokerAdapter", () => {
  it("uses a local long-running dispatcher without changing the global dispatcher", async () => {
    const globalDispatcher = getGlobalDispatcher();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json(acceptanceProof()));
    try {
      const adapter = new HttpPreviewAcceptanceBrokerAdapter({
        baseUrl: () => "http://preview-control-broker:3000",
        token: () => "c".repeat(64),
        identity: () => ({
          previewName: "preview1",
          environmentRequestId: "environment-request-1",
          environmentPlatformRevision: "9".repeat(40),
          environmentSourceRevision: BASE_SHA,
          catalogDigest: ACCEPTANCE_DIGEST,
        }),
        catalog: {
          listPreviewNativeServices: () => ["workflow-builder"],
          assertPreviewNativeServices: (services) => services,
          assertAcceptanceReplayServices: (services) => services,
          acceptanceImageRepository: (service) =>
            `ghcr.io/pittampalliorg/${service}`,
        },
      });

      await expect(adapter.replay(acceptanceInput())).resolves.toMatchObject({
        ok: true,
      });

      const init = fetchSpy.mock.calls[0]?.[1] as
        | (RequestInit & { dispatcher?: unknown })
        | undefined;
      expect(init?.dispatcher).toBeDefined();
      expect(init?.dispatcher).not.toBe(globalDispatcher);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(getGlobalDispatcher()).toBe(globalDispatcher);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("mints the local tuple into the command and validates complete success proof", async () => {
    const adapter = acceptanceAdapter(acceptanceProof());

    await expect(adapter.replay(acceptanceInput())).resolves.toMatchObject({
      ok: true,
      name: ACCEPTANCE_NAME,
    });
  });

  it("rejects compromised provenance, image, verification, and cleanup proofs", async () => {
    const valid = acceptanceProof();
    const invalid = [
      {
        ...valid,
        pullRequest: { ...valid.pullRequest, headSha: "f".repeat(40) },
      },
      { ...valid, services: ["swebench-coordinator"] },
      {
        ...valid,
        images: [{ ...valid.images[0], sourceRevision: BASE_SHA }],
      },
      {
        ...valid,
        images: [
          {
            ...valid.images[0],
            immutableRef: `ghcr.io/attacker/workflow-builder@${valid.images[0].digest}`,
          },
        ],
      },
      {
        ...valid,
        verification: { ok: true, checks: [{ name: "bff-health", ok: false }] },
      },
      { ...valid, cleanup: null },
    ];
    for (const proof of invalid) {
      await expect(
        acceptanceAdapter(proof).replay(acceptanceInput()),
      ).rejects.toThrow(/proof|service/);
    }
  });

  it("requires cleanup proof for failures after an environment launch", async () => {
    const proof = {
      ...acceptanceProof(),
      ok: false,
      stage: "verification",
      message: "verification failed",
      cleanup: undefined,
    };

    await expect(
      acceptanceAdapter(proof, 422).replay(acceptanceInput()),
    ).rejects.toThrow("cleanup proof");
  });

  it("rejects a caller tuple that differs from the local preview identity", async () => {
    await expect(
      acceptanceAdapter(acceptanceProof()).replay({
        ...acceptanceInput(),
        environmentRequestId: "another-request",
      }),
    ).rejects.toThrow("identity changed");
  });
});
