import { describe, expect, it, vi } from "vitest";
import {
  ApplicationPreviewEnvironmentService,
  PREVIEW_ENVIRONMENT_PROFILE_POLICIES,
  PreviewEnvironmentValidationError,
  routePreviewEnvironmentCapabilities,
  validatePreviewEnvironmentLaunchSpec as validateLaunchSpec,
} from "$lib/server/application/preview-environments";
import type {
  PreviewEnvironment,
  PreviewEnvironmentLaunchPort,
  PreviewEnvironmentLaunchSpec,
  PreviewEnvironmentServiceCatalogPort,
  ValidatedPreviewEnvironmentLaunchSpec,
} from "$lib/server/application/ports";

const PLATFORM_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}` as const;
const PREVIEW_NATIVE_SERVICES = new Set([
  "function-router",
  "workflow-builder",
  "workflow-mcp-server",
  "workflow-orchestrator",
]);

function validatePreviewEnvironmentLaunchSpec(
  input: PreviewEnvironmentLaunchSpec,
) {
  return validateLaunchSpec(input, CATALOG_DIGEST);
}

function serviceCatalog(): PreviewEnvironmentServiceCatalogPort & {
  currentDigest(): `sha256:${string}`;
} {
  return {
    currentDigest: () => CATALOG_DIGEST,
    listPreviewNativeServices: () => [...PREVIEW_NATIVE_SERVICES].sort(),
    assertPreviewNativeServices(services) {
      const unsupported = services.filter(
        (service) => !PREVIEW_NATIVE_SERVICES.has(service),
      );
      if (unsupported.length) {
        throw new Error(
          `Unsupported preview-native service set: ${unsupported.join(", ")}`,
        );
      }
      return [...new Set(services)].sort();
    },
  };
}

function appLiveSpec(
  overrides: Partial<PreviewEnvironmentLaunchSpec> = {},
): PreviewEnvironmentLaunchSpec {
  return {
    name: "preview-1",
    profile: "app-live",
    lane: "application",
    capabilities: ["service-live-sync"],
    platformRevision: PLATFORM_SHA.toUpperCase(),
    sourceRevision: SOURCE_SHA.toUpperCase(),
    services: ["workflow-builder", "workflow-orchestrator"],
    owner: { kind: "user", id: "user-1" },
    origin: { kind: "user" },
    ttlHours: 24,
    mode: "live",
    lifecycle: "retained",
    allocation: { kind: "cold" },
    provenance: {
      requestId: "request-1",
      requestedAt: "2026-07-09T16:30:00Z",
      platformRepository: "PittampalliOrg/stacks",
      sourceRepository: "PittampalliOrg/workflow-builder",
    },
    ...overrides,
  };
}

function environment(
  command: ValidatedPreviewEnvironmentLaunchSpec,
): PreviewEnvironment {
  return {
    ...command,
    id: "preview-1",
    lifecycleState: "requested",
    createdAt: "2026-07-09T16:30:01Z",
    expiresAt: "2026-07-10T16:30:01Z",
    runtime: {
      placement: command.placement,
      phase: "provisioning",
      ready: false,
      url: null,
      allocationId: null,
      pooled: false,
    },
  };
}

function launchPort(): PreviewEnvironmentLaunchPort {
  return {
    launch: vi.fn(async (command) => ({
      ok: true as const,
      environment: environment(command),
    })),
  };
}

function validationError(input: PreviewEnvironmentLaunchSpec) {
  try {
    validatePreviewEnvironmentLaunchSpec(input);
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PreviewEnvironmentValidationError);
    return error as PreviewEnvironmentValidationError;
  }
}

describe("preview environment capability routing", () => {
  it.each([
    ["service-live-sync", "app-live", "application", "dev-vcluster"],
    [
      "namespaced-manifests",
      "manifest-candidate",
      "application",
      "dev-vcluster",
    ],
    [
      "virtual-cluster-control-plane",
      "manifest-candidate",
      "application",
      "dev-vcluster",
    ],
    ["host-control-plane", "host-candidate", "application", "dev-physical"],
    ["host-networking", "host-candidate", "application", "dev-physical"],
    ["host-storage", "host-candidate", "application", "dev-physical"],
    ["node-runtime", "host-candidate", "application", "dev-physical"],
    [
      "gitops-management-plane",
      "manifest-candidate",
      "management",
      "dev-vcluster",
    ],
  ] as const)("routes %s to %s", (capability, profile, lane, placement) => {
    expect(routePreviewEnvironmentCapabilities([capability])).toEqual({
      profile,
      lane,
      placement,
    });
  });

  it("routes host plus virtualized manifest capabilities to the physical lane", () => {
    expect(
      routePreviewEnvironmentCapabilities([
        "namespaced-manifests",
        "host-storage",
      ]),
    ).toMatchObject({ profile: "host-candidate", placement: "dev-physical" });
  });

  it("requires live sync and infrastructure validation to be separate phases", () => {
    expect(() =>
      routePreviewEnvironmentCapabilities([
        "service-live-sync",
        "namespaced-manifests",
      ]),
    ).toThrow("separate preview phases");
  });

  it("rejects empty and unknown capability sets", () => {
    expect(() => routePreviewEnvironmentCapabilities([])).toThrow(
      "at least one preview capability",
    );
    expect(() =>
      routePreviewEnvironmentCapabilities(["unknown" as never]),
    ).toThrow("unsupported preview capability");
  });

  it("defines an exhaustive policy for each profile", () => {
    expect(PREVIEW_ENVIRONMENT_PROFILE_POLICIES).toEqual({
      "app-live": {
        placement: "dev-vcluster",
        mode: "live",
        lifecycles: ["ephemeral", "retained"],
        requiresServices: true,
      },
      "manifest-candidate": {
        placement: "dev-vcluster",
        mode: "reconciled",
        lifecycles: ["ephemeral", "retained"],
        requiresServices: false,
      },
      "host-candidate": {
        placement: "dev-physical",
        mode: "reconciled",
        lifecycles: ["exclusive"],
        requiresServices: false,
      },
    });
  });
});

describe("validatePreviewEnvironmentLaunchSpec", () => {
  it("classifies a missing launch object as validation data instead of crashing", () => {
    expect(() => validatePreviewEnvironmentLaunchSpec(null as never)).toThrow(
      PreviewEnvironmentValidationError,
    );
    try {
      validatePreviewEnvironmentLaunchSpec(null as never);
    } catch (error) {
      expect(
        (error as PreviewEnvironmentValidationError).issues,
      ).toContainEqual(
        expect.objectContaining({ path: "launchSpec", code: "required" }),
      );
    }
  });

  it("brands full SHAs, normalizes case, and freezes the adapter command", () => {
    const command = validatePreviewEnvironmentLaunchSpec(appLiveSpec());
    expect(command.platformRevision).toBe(PLATFORM_SHA);
    expect(command.sourceRevision).toBe(SOURCE_SHA);
    expect(command.placement).toBe("dev-vcluster");
    expect(command.allocation).toEqual({ kind: "cold" });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.services)).toBe(true);
    expect(Object.isFrozen(command.capabilities)).toBe(true);
    expect(Object.isFrozen(command.owner)).toBe(true);
    expect(Object.isFrozen(command.origin)).toBe(true);
    expect(Object.isFrozen(command.provenance)).toBe(true);
    expect(Object.isFrozen(command.allocation)).toBe(true);
  });

  it.each([
    "pool-1383",
    "pool-replacement",
    "mtxdev1",
    "mtxtmpl1",
    "preview6",
    "ganpilot",
    "ganvalidate",
    "test3",
  ])(
    "rejects legacy retirement subject name %s before adapter dispatch",
    (name) => {
      expect(validationError(appLiveSpec({ name })).issues).toContainEqual(
        expect.objectContaining({
          path: "name",
          code: "invalid-value",
          message: "name is reserved for legacy preview retirement",
        }),
      );
    },
  );

  it("requires a user or pull-request automation owner for live app previews", () => {
    const error = validationError(
      appLiveSpec({
        owner: { kind: "workflow", id: "workflow-1" },
        origin: { kind: "workflow", reference: "execution-1" },
      }),
    );
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        path: "owner.kind",
        code: "invalid-value",
      }),
    );
  });

  it("allows pull-request automation to own an ephemeral live app preview", () => {
    const command = validatePreviewEnvironmentLaunchSpec(
      appLiveSpec({
        lifecycle: "ephemeral",
        owner: { kind: "automation", id: "pr-preview:42" },
        origin: {
          kind: "pull-request",
          reference: "PittampalliOrg/workflow-builder#42",
        },
      }),
    );

    expect(command.owner).toEqual({
      kind: "automation",
      id: "pr-preview:42",
    });
    expect(command.origin).toEqual({
      kind: "pull-request",
      reference: "PittampalliOrg/workflow-builder#42",
    });
  });

  it.each([
    [{ kind: "automation", id: "scheduled-preview" }, { kind: "automation" }],
    [
      { kind: "workflow", id: "workflow-1" },
      { kind: "pull-request", reference: "PittampalliOrg/workflow-builder#42" },
    ],
    [
      { kind: "session", id: "session-1" },
      { kind: "interactive-session", reference: "session-1" },
    ],
  ] as const)(
    "rejects non-PR automation and non-user live ownership",
    (owner, origin) => {
      expect(
        validationError(
          appLiveSpec({
            owner,
            origin,
          }),
        ).issues,
      ).toContainEqual(
        expect.objectContaining({
          path: "owner.kind",
          code: "invalid-value",
        }),
      );
    },
  );

  it("allows non-user owners for immutable reconciled app acceptance previews", () => {
    const image = `ghcr.io/pittampalliorg/workflow-builder@sha256:${"c".repeat(64)}`;
    const command = validatePreviewEnvironmentLaunchSpec(
      appLiveSpec({
        mode: "reconciled",
        capabilities: ["immutable-image-replay"],
        services: ["workflow-builder"],
        imageOverrides: { "workflow-builder": image },
        owner: { kind: "automation", id: "acceptance-1" },
        origin: { kind: "pull-request", reference: "123" },
      }),
    );
    expect(command.owner).toEqual({ kind: "automation", id: "acceptance-1" });
  });

  it("binds app-live capabilities to the actual delivery mode", () => {
    for (const input of [
      appLiveSpec({ capabilities: ["immutable-image-replay"] }),
      appLiveSpec({
        mode: "reconciled",
        capabilities: ["service-live-sync"],
        services: ["workflow-builder"],
        imageOverrides: {
          "workflow-builder": `ghcr.io/pittampalliorg/workflow-builder@sha256:${"c".repeat(64)}`,
        },
      }),
    ]) {
      expect(validationError(input).issues).toContainEqual(
        expect.objectContaining({
          path: "capabilities",
          code: "profile-capability-mismatch",
        }),
      );
    }
  });

  it.each([
    "main",
    "abc1234",
    "a".repeat(39),
    "a".repeat(41),
    "g".repeat(40),
    ` ${PLATFORM_SHA}`,
    `${PLATFORM_SHA} `,
  ])("rejects non-immutable platform revision %s", (platformRevision) => {
    const error = validationError(appLiveSpec({ platformRevision }));
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        path: "platformRevision",
        code: "invalid-sha",
      }),
    );
  });

  it("requires both platform and source revisions to be immutable", () => {
    const error = validationError(
      appLiveSpec({ platformRevision: "main", sourceRevision: "feature/x" }),
    );
    expect(
      error.issues.filter((entry) => entry.code === "invalid-sha"),
    ).toHaveLength(2);
  });

  it("rejects the retired warm allocation shape", () => {
    const invalid = validationError({
      ...appLiveSpec(),
      allocation: { kind: "warm", baselinePlatformRevision: PLATFORM_SHA },
    } as unknown as PreviewEnvironmentLaunchSpec);
    expect(invalid.issues).toContainEqual(
      expect.objectContaining({
        path: "allocation.kind",
        code: "invalid-value",
      }),
    );
  });

  it("forces manifest candidates to be reconciled and cold", () => {
    const valid = validatePreviewEnvironmentLaunchSpec(
      appLiveSpec({
        profile: "manifest-candidate",
        capabilities: ["namespaced-manifests"],
        services: [],
        candidatePaths: [
          "packages/components/workloads/workflow-builder/manifests/deployment.yaml",
        ],
        mode: "reconciled",
        lifecycle: "ephemeral",
        allocation: { kind: "cold" },
      }),
    );
    expect(valid.placement).toBe("dev-vcluster");

    const invalid = validationError({
      ...appLiveSpec({
        profile: "manifest-candidate",
        capabilities: ["namespaced-manifests"],
        candidatePaths: [
          "packages/components/workloads/workflow-builder/manifests/deployment.yaml",
        ],
        mode: "live",
      }),
      allocation: { kind: "warm", baselinePlatformRevision: PLATFORM_SHA },
    } as unknown as PreviewEnvironmentLaunchSpec);
    expect(invalid.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["mode-not-allowed", "invalid-value"]),
    );
  });

  it("matches the CRD admission bound of at most 64 candidate paths", () => {
    const error = validationError(
      appLiveSpec({
        profile: "manifest-candidate",
        capabilities: ["namespaced-manifests"],
        services: [],
        candidatePaths: Array.from(
          { length: 65 },
          (_, index) => `packages/workloads/file-${index}.yaml`,
        ),
        mode: "reconciled",
        lifecycle: "ephemeral",
        allocation: { kind: "cold" },
      }),
    );
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        path: "candidatePaths",
        code: "invalid-value",
      }),
    );
  });

  it("accepts a cold reconciled app-live replay with immutable production digests", () => {
    const image = `ghcr.io/pittampalliorg/workflow-builder@sha256:${"c".repeat(64)}`;
    const valid = validatePreviewEnvironmentLaunchSpec(
      appLiveSpec({
        mode: "reconciled",
        capabilities: ["immutable-image-replay"],
        allocation: { kind: "cold" },
        services: ["workflow-builder"],
        imageOverrides: { "workflow-builder": image },
      }),
    );
    expect(valid.mode).toBe("reconciled");
    expect(valid.allocation).toEqual({ kind: "cold" });
    expect(valid.imageOverrides).toEqual({ "workflow-builder": image });
  });

  it("rejects mutable, unrequested, warm, or missing acceptance images", () => {
    const base = {
      mode: "reconciled" as const,
      allocation: { kind: "cold" as const },
      services: ["workflow-builder"],
    };
    expect(
      validationError(appLiveSpec({ ...base, imageOverrides: {} })).issues,
    ).toContainEqual(
      expect.objectContaining({ path: "imageOverrides", code: "required" }),
    );
    expect(
      validationError(
        appLiveSpec({
          ...base,
          imageOverrides: {
            "workflow-builder":
              "ghcr.io/pittampalliorg/workflow-builder:latest",
          },
        }),
      ).issues,
    ).toContainEqual(
      expect.objectContaining({ path: "imageOverrides.workflow-builder" }),
    );
    expect(
      validationError(
        appLiveSpec({
          ...base,
          imageOverrides: {
            "function-router": `ghcr.io/pittampalliorg/function-router@sha256:${"d".repeat(64)}`,
          },
        }),
      ).issues,
    ).toContainEqual(expect.objectContaining({ code: "invalid-service" }));
    expect(
      validationError({
        ...appLiveSpec({
          ...base,
          imageOverrides: {
            "workflow-builder": `ghcr.io/pittampalliorg/workflow-builder@sha256:${"e".repeat(64)}`,
          },
        }),
        allocation: { kind: "warm", baselinePlatformRevision: PLATFORM_SHA },
      } as unknown as PreviewEnvironmentLaunchSpec).issues,
    ).toContainEqual(expect.objectContaining({ code: "invalid-value" }));
  });

  it("forces host candidates onto an exclusive, reconciled, cold lease", () => {
    const valid = validatePreviewEnvironmentLaunchSpec(
      appLiveSpec({
        profile: "host-candidate",
        capabilities: ["host-networking", "host-storage"],
        services: [],
        mode: "reconciled",
        lifecycle: "exclusive",
        allocation: { kind: "cold" },
      }),
    );
    expect(valid.placement).toBe("dev-physical");

    const invalid = validationError({
      ...appLiveSpec({
        profile: "host-candidate",
        capabilities: ["host-networking"],
        mode: "live",
        lifecycle: "retained",
      }),
      allocation: { kind: "warm", baselinePlatformRevision: PLATFORM_SHA },
    } as unknown as PreviewEnvironmentLaunchSpec);
    expect(invalid.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "mode-not-allowed",
        "lifecycle-not-allowed",
        "invalid-value",
      ]),
    );
  });

  it("bounds the manifest management lane to an ephemeral reconciled vcluster", () => {
    const valid = validatePreviewEnvironmentLaunchSpec(
      appLiveSpec({
        profile: "manifest-candidate",
        lane: "management",
        capabilities: ["gitops-management-plane"],
        services: [],
        candidatePaths: ["packages/hub/promoter.yaml"],
        mode: "reconciled",
        lifecycle: "ephemeral",
        allocation: { kind: "cold" },
        ttlHours: 24,
      }),
    );
    expect(valid.placement).toBe("dev-vcluster");

    const invalid = validationError(
      appLiveSpec({
        profile: "manifest-candidate",
        lane: "management",
        capabilities: ["gitops-management-plane"],
        services: [],
        candidatePaths: ["packages/hub/promoter.yaml"],
        mode: "reconciled",
        lifecycle: "retained",
        allocation: { kind: "cold" },
        ttlHours: 25,
      }),
    );
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "lifecycle",
          code: "lifecycle-not-allowed",
        }),
        expect.objectContaining({ path: "ttlHours", code: "out-of-range" }),
      ]),
    );
  });

  it.each([
    ["app-live", ["namespaced-manifests"]],
    ["manifest-candidate", ["service-live-sync"]],
    ["host-candidate", ["namespaced-manifests"]],
  ] as const)(
    "rejects profile %s when capabilities route elsewhere",
    (profile, capabilities) => {
      const error = validationError(
        appLiveSpec({ profile, capabilities, allocation: { kind: "cold" } }),
      );
      expect(error.issues).toContainEqual(
        expect.objectContaining({ code: "profile-capability-mismatch" }),
      );
    },
  );

  it("requires at least one valid, unique service for app-live", () => {
    const empty = validationError(appLiveSpec({ services: [] }));
    expect(empty.issues).toContainEqual(
      expect.objectContaining({ path: "services", code: "required" }),
    );

    const invalid = validationError(
      appLiveSpec({
        services: ["workflow-builder", "Workflow Builder", "workflow-builder"],
      }),
    );
    expect(invalid.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["invalid-service", "duplicate"]),
    );
  });

  it.each([1, 168])("accepts TTL boundary %d hours", (ttlHours) => {
    expect(
      validatePreviewEnvironmentLaunchSpec(appLiveSpec({ ttlHours })).ttlHours,
    ).toBe(ttlHours);
  });

  it.each([0, 1.5, 169, Number.NaN])("rejects TTL %s", (ttlHours) => {
    const error = validationError(appLiveSpec({ ttlHours }));
    expect(error.issues).toContainEqual(
      expect.objectContaining({ path: "ttlHours", code: "out-of-range" }),
    );
  });

  it("validates owner and referenced origins", () => {
    const ownerError = validationError(
      appLiveSpec({ owner: { kind: "user", id: " " } }),
    );
    expect(ownerError.issues).toContainEqual(
      expect.objectContaining({ path: "owner.id", code: "required" }),
    );

    const originError = validationError(
      appLiveSpec({ origin: { kind: "pull-request" } }),
    );
    expect(originError.issues).toContainEqual(
      expect.objectContaining({ path: "origin.reference", code: "required" }),
    );

    const valid = validatePreviewEnvironmentLaunchSpec(
      appLiveSpec({
        origin: { kind: "interactive-session", reference: "session-42" },
      }),
    );
    expect(valid.origin.reference).toBe("session-42");
  });

  it.each(["not-a-date", "2026-02-30T12:00:00Z", "2026-07-09T12:00:00-04:00"])(
    "rejects non-UTC or impossible provenance timestamp %s",
    (requestedAt) => {
      const error = validationError(
        appLiveSpec({
          provenance: { ...appLiveSpec().provenance, requestedAt },
        }),
      );
      expect(error.issues).toContainEqual(
        expect.objectContaining({
          path: "provenance.requestedAt",
          code: "invalid-value",
        }),
      );
    },
  );
});

describe("ApplicationPreviewEnvironmentService", () => {
  function userService() {
    const vcluster = launchPort();
    const physicalDev = launchPort();
    const revisions = {
      resolve: vi.fn(
        async ({ repository }: { repository: string; ref: string }) =>
          repository.endsWith("/stacks") ? PLATFORM_SHA : SOURCE_SHA,
      ),
    };
    return {
      vcluster,
      physicalDev,
      revisions,
      service: new ApplicationPreviewEnvironmentService({
        vcluster,
        physicalDev,
        serviceCatalog: serviceCatalog(),
        candidatePaths: {
          assertManifestCandidatePaths: (paths) => [...paths].sort(),
        },
        revisions,
        defaults: {
          platformRepository: "PittampalliOrg/stacks",
          platformRef: "main",
          sourceRepository: "PittampalliOrg/workflow-builder",
          sourceRef: "main",
          ttlHours: 24,
        },
        now: () => new Date("2026-07-09T18:00:00.000Z"),
        requestId: () => "server-request-1",
      }),
    };
  }

  it("resolves symbolic defaults before validation and derives trusted user provenance", async () => {
    const { service, revisions, vcluster } = userService();
    await service.launchForUser({ name: "feature-x", userId: "user-42" });

    expect(revisions.resolve).toHaveBeenNthCalledWith(1, {
      repository: "PittampalliOrg/stacks",
      ref: "main",
    });
    expect(revisions.resolve).toHaveBeenNthCalledWith(2, {
      repository: "PittampalliOrg/workflow-builder",
      ref: "main",
    });
    expect(vcluster.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "feature-x",
        profile: "app-live",
        services: [...PREVIEW_NATIVE_SERVICES].sort(),
        platformRevision: PLATFORM_SHA,
        sourceRevision: SOURCE_SHA,
        owner: { kind: "user", id: "user-42" },
        origin: { kind: "user" },
        provenance: {
          requestId: "server-request-1",
          requestedAt: "2026-07-09T18:00:00.000Z",
          platformRepository: "PittampalliOrg/stacks",
          sourceRepository: "PittampalliOrg/workflow-builder",
        },
        lane: "application",
        allocation: { kind: "cold" },
      }),
    );
  });

	it("derives workflow origin from trusted host execution context", async () => {
		const { service, vcluster } = userService();
		await service.launchForUser({
			name: "feature-x",
			userId: "user-42",
			workflowExecutionId: "parent-execution-1",
			services: ["workflow-builder"],
			provenance: {
				parentEnvironmentId: `workflow-execution:sha256:${"a".repeat(64)}:launch:sha256:${"b".repeat(64)}`,
			},
		});

		expect(vcluster.launch).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: { kind: "user", id: "user-42" },
				origin: { kind: "workflow", reference: "parent-execution-1" },
				provenance: expect.objectContaining({
					parentEnvironmentId: `workflow-execution:sha256:${"a".repeat(64)}:launch:sha256:${"b".repeat(64)}`,
				}),
			}),
		);
	});

  it("verifies full immutable revisions through repository authority", async () => {
    const { service, revisions } = userService();
    await service.launchForUser({
      name: "feature-x",
      userId: "user-42",
      platformRevision: PLATFORM_SHA,
      sourceRevision: SOURCE_SHA,
    });
    expect(revisions.resolve).toHaveBeenNthCalledWith(1, {
      repository: "PittampalliOrg/stacks",
      ref: PLATFORM_SHA,
    });
    expect(revisions.resolve).toHaveBeenNthCalledWith(2, {
      repository: "PittampalliOrg/workflow-builder",
      ref: SOURCE_SHA,
    });
  });

  it("rejects unreachable and mismatched exact revisions before provisioning", async () => {
    const unreachable = userService();
    unreachable.revisions.resolve.mockRejectedValueOnce(new Error("not found"));
    await expect(
      unreachable.service.launchForUser({
        name: "feature-x",
        userId: "user-42",
        platformRevision: PLATFORM_SHA,
        sourceRevision: SOURCE_SHA,
      }),
    ).rejects.toMatchObject({
      name: "PreviewEnvironmentRevisionResolutionError",
      field: "platform",
    });
    expect(unreachable.vcluster.launch).not.toHaveBeenCalled();

    const mismatched = userService();
    mismatched.revisions.resolve.mockResolvedValueOnce("d".repeat(40));
    await expect(
      mismatched.service.launchForUser({
        name: "feature-x",
        userId: "user-42",
        platformRevision: PLATFORM_SHA,
        sourceRevision: SOURCE_SHA,
      }),
    ).rejects.toMatchObject({
      name: "PreviewEnvironmentRevisionResolutionError",
      field: "platform",
    });
    expect(mismatched.vcluster.launch).not.toHaveBeenCalled();
  });

  it("rejects ambiguous revision selectors before provisioning", async () => {
    const { service, vcluster } = userService();
    await expect(
      service.launchForUser({
        name: "feature-x",
        userId: "user-42",
        platformRevision: PLATFORM_SHA,
        platformRef: "main",
      }),
    ).rejects.toThrow("provide platformRevision or platformRef, not both");
    expect(vcluster.launch).not.toHaveBeenCalled();
  });

  it("defaults manifest candidates to a cold reconciled launch", async () => {
    const { service, vcluster } = userService();
    await service.launchForUser({
      name: "manifest-x",
      userId: "user-42",
      profile: "manifest-candidate",
      candidatePaths: [
        "packages/components/workloads/workflow-builder/manifests/deployment.yaml",
      ],
    });
    expect(vcluster.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "manifest-candidate",
        mode: "reconciled",
        lifecycle: "ephemeral",
        allocation: { kind: "cold" },
      }),
    );
  });

  it("delegates validated app and manifest launches only to the vcluster port", async () => {
    const vcluster = launchPort();
    const physicalDev = launchPort();
    const service = new ApplicationPreviewEnvironmentService({
      vcluster,
      physicalDev,
      serviceCatalog: serviceCatalog(),
    });

    const result = await service.launch(appLiveSpec());
    expect(result.ok && result.environment.id).toBe("preview-1");
    expect(vcluster.launch).toHaveBeenCalledOnce();
    expect(vcluster.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "app-live",
        placement: "dev-vcluster",
        platformRevision: PLATFORM_SHA,
      }),
    );
    expect(physicalDev.launch).not.toHaveBeenCalled();
  });

  it("rejects catalog services that are not preview-native before an adapter runs", async () => {
    const vcluster = launchPort();
    const physicalDev = launchPort();
    const service = new ApplicationPreviewEnvironmentService({
      vcluster,
      physicalDev,
      serviceCatalog: serviceCatalog(),
    });

    await expect(
      service.launch(appLiveSpec({ services: ["swebench-coordinator"] })),
    ).rejects.toMatchObject({
      name: "PreviewEnvironmentValidationError",
      issues: [
        expect.objectContaining({ path: "services", code: "invalid-service" }),
      ],
    });
    expect(vcluster.launch).not.toHaveBeenCalled();
    expect(physicalDev.launch).not.toHaveBeenCalled();
  });

  it("delegates host capabilities only to the physical dev port", async () => {
    const vcluster = launchPort();
    const physicalDev = launchPort();
    const service = new ApplicationPreviewEnvironmentService({
      vcluster,
      physicalDev,
      serviceCatalog: serviceCatalog(),
    });
    await service.launch(
      appLiveSpec({
        profile: "host-candidate",
        capabilities: ["node-runtime"],
        services: [],
        mode: "reconciled",
        lifecycle: "exclusive",
        allocation: { kind: "cold" },
      }),
    );
    expect(physicalDev.launch).toHaveBeenCalledOnce();
    expect(vcluster.launch).not.toHaveBeenCalled();
  });

  it("aggregates validation failures and never calls an adapter", async () => {
    const vcluster = launchPort();
    const physicalDev = launchPort();
    const service = new ApplicationPreviewEnvironmentService({
      vcluster,
      physicalDev,
      serviceCatalog: serviceCatalog(),
    });
    const input = appLiveSpec({
      platformRevision: "main",
      sourceRevision: "feature/x",
      services: [],
      ttlHours: 0,
    });
    await expect(service.launch(input)).rejects.toMatchObject({
      name: "PreviewEnvironmentValidationError",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "platformRevision" }),
        expect.objectContaining({ path: "sourceRevision" }),
        expect.objectContaining({ path: "services" }),
        expect.objectContaining({ path: "ttlHours" }),
      ]),
    });
    expect(vcluster.launch).not.toHaveBeenCalled();
    expect(physicalDev.launch).not.toHaveBeenCalled();
  });

  it("preserves adapter failures", async () => {
    const failure = new Error("capacity exhausted");
    const vcluster: PreviewEnvironmentLaunchPort = {
      launch: vi.fn(async () => {
        throw failure;
      }),
    };
    const service = new ApplicationPreviewEnvironmentService({
      vcluster,
      physicalDev: launchPort(),
      serviceCatalog: serviceCatalog(),
    });
    await expect(service.launch(appLiveSpec())).rejects.toBe(failure);
  });
});
