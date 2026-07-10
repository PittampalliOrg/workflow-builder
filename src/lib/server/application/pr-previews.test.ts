import { describe, expect, it } from "vitest";
import {
  ApplicationPrPreviewService,
  ApplicationPrPreviewFacadeService,
  PrPreviewAdmissionError,
  prPreviewAlias,
  type PrPreviewDeps,
} from "$lib/server/application/pr-previews";
import { InMemoryPrPreviewRecordStore } from "$lib/server/application/adapters/pr-preview-records";
import type {
  PrPreviewAuthority,
  PrPreviewRegistryEntry,
  PrPreviewStatus,
  PreviewEnvironmentCleanupProof,
  PreviewEnvironmentLaunchSpec,
} from "$lib/server/application/ports";

const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const PLATFORM = "d".repeat(40);
const CATALOG = `sha256:${"e".repeat(64)}` as const;
const REPOSITORY = "PittampalliOrg/workflow-builder";
const PLATFORM_REPOSITORY = "PittampalliOrg/stacks";
const NOW = new Date("2026-07-09T12:00:00.000Z");

const REGISTRY: PrPreviewRegistryEntry[] = [
  {
    service: "workflow-builder",
    repoSubdir: ".",
    syncPaths: ["src", "services/shared/workflow-data-contract"],
    extraSync: [],
    appPort: 3000,
    healthPath: "/",
  },
  {
    service: "workflow-orchestrator",
    repoSubdir: "services/workflow-orchestrator",
    syncPaths: ["app.py", "core"],
    extraSync: [
      {
        from: "../shared/workflow-data-contract",
        to: ".contract-fixtures",
      },
    ],
    appPort: 8080,
    healthPath: "/healthz",
  },
];

const COMPLETE_CHECKS = {
  "runner-succeeded": true,
  "preview-environment-absent": true,
  "application-absent": true,
  "agent-registration-absent": true,
  "agent-namespaces-absent": true,
  "database-absent": true,
  "nats-stream-absent": true,
  "headlamp-registration-absent": true,
  "tailnet-egress-absent": true,
  "host-namespace-absent": true,
  "storage-scope-absent": true,
  "runner-identity-absent": true,
} as const;

function cleanup(
  name: string,
  complete = true,
): PreviewEnvironmentCleanupProof {
  return {
    name,
    resourceName: name,
    complete,
    phase: complete ? "complete" : "timeout",
    checks: complete
      ? COMPLETE_CHECKS
      : { ...COMPLETE_CHECKS, "database-absent": false },
    message: complete ? null : "database still exists",
  };
}

type TestControls = {
  head: string;
  base: string;
  changedPaths: string[];
  services: string[];
  unmappedRuntimePaths: string[];
  launchOutcome: "ok" | "capacity" | "conflict";
  ready: boolean;
  adoptionFails: boolean;
  seedFails: boolean;
  cleanupComplete: boolean;
  teardownFails: boolean;
  inspectFails: boolean;
};

type Calls = {
  inspect: Array<{ prNumber: number; expectedHeadSha: string }>;
  launch: PreviewEnvironmentLaunchSpec[];
  ready: unknown[];
  teardown: string[];
  seed: Array<{ headSha: string; services: string[] }>;
};

function makeHarness(initial: Partial<TestControls> = {}) {
  const controls: TestControls = {
    head: HEAD,
    base: BASE,
    changedPaths: ["src/routes/+page.svelte"],
    services: ["workflow-builder"],
    unmappedRuntimePaths: [],
    launchOutcome: "ok",
    ready: true,
    adoptionFails: false,
    seedFails: false,
    cleanupComplete: true,
    teardownFails: false,
    inspectFails: false,
    ...initial,
  };
  const calls: Calls = {
    inspect: [],
    launch: [],
    ready: [],
    teardown: [],
    seed: [],
  };
  const store = new InMemoryPrPreviewRecordStore();
  const deps: PrPreviewDeps = {
    environments: {
      async launch(input) {
        calls.launch.push(input);
        if (controls.launchOutcome === "capacity") {
          return {
            ok: false,
            reason: "capacity",
            awake: 6,
            max: 6,
            message: "capacity full",
          };
        }
        if (controls.launchOutcome === "conflict") {
          return {
            ok: false,
            reason: "conflict",
            message: "already exists",
          };
        }
        return { ok: true, environment: {} as never };
      },
    },
    readiness: {
      async waitReady(input) {
        calls.ready.push(input);
        return {
          ready: controls.ready,
          phase: controls.ready ? "ready" : "contract-mismatch:owner",
          url: controls.ready ? "https://wfb-pr-42.tail286401.ts.net" : null,
        };
      },
    },
    teardown: {
      async teardown({ name }) {
        calls.teardown.push(name);
        if (controls.teardownFails)
          throw new Error("teardown transport failed");
        return cleanup(name, controls.cleanupComplete);
      },
    },
    platformRevisions: {
      async resolve() {
        return PLATFORM;
      },
    },
    pullRequests: {
      async inspect(input) {
        calls.inspect.push(input);
        if (controls.inspectFails) throw new Error("fork PR rejected");
        if (input.expectedHeadSha !== controls.head) {
          throw new Error("head moved");
        }
        return {
          repository: REPOSITORY,
          prNumber: input.prNumber,
          baseRef: "main",
          baseSha: controls.base as never,
          headSha: controls.head as never,
          changedPaths: [...controls.changedPaths],
        };
      },
      async upsertStickyComment() {
        return true;
      },
    },
    catalog: {
      currentDigest: () => CATALOG,
      deriveChangedServices: () => ({
        services: [...controls.services],
        activationArtifacts: [],
        unmappedRuntimePaths: [...controls.unmappedRuntimePaths],
      }),
    },
    devPods: {
      async provision(input) {
        return input.services.map((service) =>
          controls.adoptionFails
            ? {
                service,
                ok: false,
                podIp: null,
                syncPort: null,
                syncCapability: null,
                error: "pod missing",
              }
            : {
                service,
                ok: true,
                podIp: "10.0.0.9",
                syncPort: 8001,
                syncCapability: "a".repeat(64),
              },
        );
      },
    },
    seeder: {
      async seed(input) {
        calls.seed.push({
          headSha: input.headSha,
          services: input.targets.map((target) => target.service),
        });
        return controls.seedFails
          ? { ok: false, detail: "head moved" }
          : { ok: true, detail: null };
      },
    },
    verify: {
      async start() {
        return { started: false, reason: "disabled" };
      },
      async waitForVerdict() {
        return { status: "completed", verdict: "ok" };
      },
    },
    store,
    registry: REGISTRY,
    syncToken: (alias) => `token-${alias}`,
    platformRepository: PLATFORM_REPOSITORY,
    platformRef: "main",
    sourceRepository: REPOSITORY,
    readyTimeoutMs: 100,
    teardownTimeoutMs: 100,
    heartbeatMs: 60_000,
    resumeStaleMs: 0,
    now: () => NOW,
    requestId: () => "request-42",
  };
  return {
    controls,
    calls,
    store,
    service: new ApplicationPrPreviewService(deps),
  };
}

describe("ApplicationPrPreviewService", () => {
  it("launches one cold app-live PreviewEnvironment from persisted server authority", async () => {
    const { service, calls, store } = makeHarness({
      services: ["workflow-builder", "workflow-orchestrator"],
      changedPaths: [
        "src/routes/+page.svelte",
        "services/workflow-orchestrator/app.py",
      ],
    });
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);

    expect(calls.inspect).toEqual([{ prNumber: 42, expectedHeadSha: HEAD }]);
    expect(calls.launch).toHaveLength(1);
    expect(calls.launch[0]).toEqual({
      name: "pr-42",
      profile: "app-live",
      lane: "application",
      capabilities: ["service-live-sync"],
      platformRevision: PLATFORM,
      sourceRevision: HEAD,
      services: ["workflow-builder", "workflow-orchestrator"],
      owner: { kind: "automation", id: "pr-preview:42" },
      origin: {
        kind: "pull-request",
        reference: `${REPOSITORY}#42`,
      },
      ttlHours: 24,
      mode: "live",
      lifecycle: "ephemeral",
      allocation: { kind: "cold" },
      provenance: {
        requestId: "request-42",
        requestedAt: NOW.toISOString(),
        platformRepository: PLATFORM_REPOSITORY,
        sourceRepository: REPOSITORY,
      },
    });
    expect(calls.ready[0]).toMatchObject({
      name: "pr-42",
      platformRevision: PLATFORM,
      sourceRevision: HEAD,
      profile: "app-live",
      lane: "application",
      mode: "live",
      services: ["workflow-builder", "workflow-orchestrator"],
      owner: { kind: "automation", id: "pr-preview:42" },
      origin: {
        kind: "pull-request",
        reference: `${REPOSITORY}#42`,
      },
      lifecycle: "ephemeral",
      allocation: { kind: "cold" },
      provenance: {
        requestId: "request-42",
        requestedAt: NOW.toISOString(),
        platformRepository: PLATFORM_REPOSITORY,
        sourceRepository: REPOSITORY,
      },
      images: {},
      catalogDigest: CATALOG,
    });
    expect(calls.seed).toEqual([
      {
        headSha: HEAD,
        services: ["workflow-builder", "workflow-orchestrator"],
      },
    ]);
    expect(await service.status(42)).toMatchObject({
      state: "ready",
      headSha: HEAD,
      services: ["workflow-builder", "workflow-orchestrator"],
    });
    const authority = (await store.get(42))?.authority;
    expect(authority).toEqual({
      repository: REPOSITORY,
      baseRef: "main",
      baseSha: BASE,
      headSha: HEAD,
      changedPaths: [
        "src/routes/+page.svelte",
        "services/workflow-orchestrator/app.py",
      ],
      services: ["workflow-builder", "workflow-orchestrator"],
      platformRepository: PLATFORM_REPOSITORY,
      platformRevision: PLATFORM,
      catalogDigest: CATALOG,
      requestId: "request-42",
      requestedAt: NOW.toISOString(),
    });
  });

  it("rejects invalid or unverified webhook authority before persisting", async () => {
    const invalid = makeHarness();
    await expect(
      invalid.service.up({ prNumber: 42, headSha: "short" }),
    ).rejects.toMatchObject({
      code: "invalid-request",
    });
    expect(await invalid.store.get(42)).toBeNull();

    const rejected = makeHarness({ inspectFails: true });
    await expect(
      rejected.service.up({ prNumber: 42, headSha: HEAD }),
    ).rejects.toMatchObject({
      code: "github-verification-failed",
    });
    expect(rejected.calls.launch).toHaveLength(0);
    expect(await rejected.store.get(42)).toBeNull();
  });

  it("rejects every unmapped runtime path instead of falling back to the BFF", async () => {
    const { service, calls, store } = makeHarness({
      unmappedRuntimePaths: ["services/new-runtime/src/main.ts"],
    });
    await expect(
      service.up({ prNumber: 42, headSha: HEAD }),
    ).rejects.toMatchObject({
      code: "unsupported-change",
      message: expect.stringContaining("services/new-runtime/src/main.ts"),
    });
    expect(calls.launch).toHaveLength(0);
    expect(await store.get(42)).toBeNull();
  });

  it("rejects a PR with no catalog-backed preview-native service", async () => {
    const { service, calls } = makeHarness({ services: [] });
    await expect(
      service.up({ prNumber: 42, headSha: HEAD }),
    ).rejects.toMatchObject({
      code: "no-preview-service",
    });
    expect(calls.launch).toHaveLength(0);
  });

  it("is idempotent only when GitHub, catalog, source, and platform authority match", async () => {
    const { service, calls } = makeHarness();
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);
    expect(calls.inspect).toHaveLength(2);
    expect(calls.launch).toHaveLength(1);
    expect(calls.teardown).toHaveLength(0);
  });

  it("tears down the prior generation before a force-pushed head gets a create-only launch", async () => {
    const { service, controls, calls } = makeHarness();
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);

    controls.head = NEXT_HEAD;
    controls.changedPaths = ["src/lib/new.ts"];
    await service.up({ prNumber: 42, headSha: NEXT_HEAD });
    await service.settled(42);
    expect(calls.teardown).toEqual(["pr-42"]);
    expect(calls.launch).toHaveLength(2);
    expect(calls.launch[1]?.sourceRevision).toBe(NEXT_HEAD);
    expect((await service.status(42)).headSha).toBe(NEXT_HEAD);
  });

  it("accepts a create-only conflict only after readiness proves the exact persisted contract", async () => {
    const { service, calls } = makeHarness({ launchOutcome: "conflict" });
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);
    expect(calls.ready).toHaveLength(1);
    expect((await service.status(42)).state).toBe("ready");
  });

  it("reports capacity without adopting or seeding", async () => {
    const { service, calls } = makeHarness({ launchOutcome: "capacity" });
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);
    expect(await service.status(42)).toMatchObject({
      state: "capacity_full",
      error: "capacity full",
    });
    expect(calls.ready).toHaveLength(0);
    expect(calls.seed).toHaveLength(0);
  });

  it("fails closed and proves cleanup when any selected service cannot be adopted", async () => {
    const { service, calls } = makeHarness({ adoptionFails: true });
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);
    expect(await service.status(42)).toMatchObject({
      state: "error",
      error: expect.stringContaining("preview-native adoption failed"),
    });
    expect(calls.seed).toHaveLength(0);
    expect(calls.teardown).toEqual(["pr-42"]);
  });

  it("uses typed unified teardown and conditionally deletes its fenced record", async () => {
    const { service, calls } = makeHarness();
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);
    await expect(service.down({ prNumber: 42 })).resolves.toEqual({
      state: "down",
    });
    expect(calls.teardown).toEqual(["pr-42"]);
    expect((await service.peek(42)).state).toBe("absent");
  });

  it("retains an error record when unified cleanup proof is incomplete", async () => {
    const { service, controls } = makeHarness();
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);
    controls.cleanupComplete = false;
    await expect(service.down({ prNumber: 42 })).rejects.toBeInstanceOf(
      PrPreviewAdmissionError,
    );
    expect(await service.peek(42)).toMatchObject({
      state: "error",
      error: "database still exists",
    });
  });

  it("retains an error record when unified teardown throws", async () => {
    const { service, controls } = makeHarness();
    await service.up({ prNumber: 42, headSha: HEAD });
    await service.settled(42);
    controls.teardownFails = true;

    await expect(service.down({ prNumber: 42 })).rejects.toThrow(
      "teardown transport failed",
    );
    expect(await service.peek(42)).toMatchObject({
      state: "error",
      error: "preview cleanup failed: teardown transport failed",
    });
  });

  it("fails closed when a legacy stale record has no persisted authority", async () => {
    const { service, store, calls } = makeHarness();
    await store.upsert({
      prNumber: 42,
      alias: prPreviewAlias(42),
      url: null,
      state: "provisioning",
      headSha: HEAD,
      services: ["workflow-builder"],
      authority: null,
      error: null,
      verify: null,
    });
    await service.status(42);
    expect(await service.peek(42)).toMatchObject({
      state: "error",
      error: "legacy PR preview record has no persisted server authority",
    });
    expect(calls.launch).toHaveLength(0);
  });
});

describe("InMemoryPrPreviewRecordStore fencing", () => {
  it("does not let an old teardown generation delete a newer upsert", async () => {
    const store = new InMemoryPrPreviewRecordStore();
    const authority = {
      repository: REPOSITORY,
      baseRef: "main",
      baseSha: BASE as never,
      headSha: HEAD as never,
      changedPaths: ["src/a.ts"],
      services: ["workflow-builder"],
      platformRepository: PLATFORM_REPOSITORY,
      platformRevision: PLATFORM as never,
      catalogDigest: CATALOG,
      requestId: "request-1",
      requestedAt: NOW.toISOString(),
    } satisfies PrPreviewAuthority;
    const first = await store.upsert({
      prNumber: 42,
      alias: "pr-42",
      url: null,
      state: "tearing_down",
      headSha: HEAD,
      services: ["workflow-builder"],
      authority,
      error: null,
      verify: null,
    });
    const { gen: _gen, updatedAt: _updatedAt, ...firstRecord } = first;
    const second = await store.upsert({
      ...firstRecord,
      state: "provisioning",
    });
    expect(await store.delete(42, first.gen)).toBe(false);
    expect((await store.get(42))?.gen).toBe(second.gen);
  });
});

describe("ApplicationPrPreviewFacadeService", () => {
  it("keeps reads local and delegates mutating or resuming commands", async () => {
    const store = new InMemoryPrPreviewRecordStore();
    await store.upsert({
      prNumber: 42,
      alias: "pr-42",
      url: null,
      state: "ready",
      headSha: HEAD,
      services: ["workflow-builder"],
      authority: null,
      error: null,
      verify: null,
    });
    const commands: string[] = [];
    const commandStatus: PrPreviewStatus = {
      prNumber: 42,
      alias: "pr-42",
      url: null,
      state: "ready",
      headSha: HEAD,
      services: ["workflow-builder"],
      error: null,
      verify: null,
      updatedAt: null,
    };
    const facade = new ApplicationPrPreviewFacadeService(
      {
        async up(): Promise<PrPreviewStatus> {
          commands.push("up");
          return commandStatus;
        },
        async down() {
          commands.push("down");
          return { state: "down" };
        },
        async status(): Promise<PrPreviewStatus> {
          commands.push("status");
          return commandStatus;
        },
      },
      store,
    );
    expect(
      (await facade.listStatuses()).map((status) => status.prNumber),
    ).toEqual([42]);
    expect((await facade.peek(42)).state).toBe("ready");
    expect(commands).toEqual([]);
    await facade.up({ prNumber: 42, headSha: HEAD });
    await facade.status(42);
    await facade.down({ prNumber: 42 });
    expect(commands).toEqual(["up", "status", "down"]);
  });
});
