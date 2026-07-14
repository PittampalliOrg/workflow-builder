import { describe, expect, it } from "vitest";
import {
  effectivePreviewStatus,
  expiresIn,
  phaseTone,
  previewTeardownOutcome,
  previewTeardownProgress,
  previewTeardownStatusPath,
  previewsWithAcceptedTeardowns,
  relativeTime,
  sleepDisabledReason,
} from "$lib/components/dev/preview-lifecycle";
import type { VclusterPreviewSummary } from "$lib/types/dev-previews";

const NOW = Date.parse("2026-07-05T12:00:00Z");

function preview(
  overrides: Partial<VclusterPreviewSummary> = {},
): VclusterPreviewSummary {
  return {
    name: "feature-x",
    phase: "ready",
    ready: true,
    url: null,
    targetCluster: "dev",
    pool: null,
    state: "hot",
    lifecycle: "ephemeral",
    origin: { kind: "user" },
    legacyOrigin: "user",
    prNumber: null,
    expiresAt: null,
    lastActive: null,
    protected: false,
    bootSeconds: null,
    platformRevision: null,
    sourceRevision: null,
    profile: "app-live",
    lane: "application",
    mode: "live",
    owner: null,
    services: ["workflow-builder"],
    provenance: null,
    trustedCode: true,
    allocation: { kind: "cold" },
    images: null,
    catalogDigest: null,
    prUrl: null,
    ...overrides,
  };
}

describe("relativeTime", () => {
  it("buckets a past timestamp", () => {
    expect(relativeTime("2026-07-05T11:59:30Z", NOW)).toBe("just now");
    expect(relativeTime("2026-07-05T11:30:00Z", NOW)).toBe("30m ago");
    expect(relativeTime("2026-07-05T09:00:00Z", NOW)).toBe("3h ago");
    expect(relativeTime(null, NOW)).toBeNull();
    expect(relativeTime("not-a-date", NOW)).toBeNull();
  });
});

describe("expiresIn", () => {
  it("is urgent under an hour and flags expiry", () => {
    expect(expiresIn("2026-07-05T12:45:00Z", NOW)).toEqual({
      label: "expires in 45m",
      urgent: true,
      expired: false,
    });
    expect(expiresIn("2026-07-05T15:00:00Z", NOW)).toEqual({
      label: "expires in 3h",
      urgent: false,
      expired: false,
    });
    expect(expiresIn("2026-07-07T12:00:00Z", NOW)).toEqual({
      label: "expires in 2d",
      urgent: false,
      expired: false,
    });
    expect(expiresIn("2026-07-05T11:00:00Z", NOW)).toEqual({
      label: "expired",
      urgent: true,
      expired: true,
    });
    expect(expiresIn(null, NOW)).toBeNull();
  });
});

describe("effectivePreviewStatus / phaseTone", () => {
  it("slept overrides a ready phase", () => {
    expect(effectivePreviewStatus({ phase: "ready", state: "slept" })).toBe(
      "slept",
    );
    expect(effectivePreviewStatus({ phase: "ready", state: "hot" })).toBe(
      "ready",
    );
    expect(phaseTone({ phase: "ready", state: "slept" })).toBe("warning");
    expect(phaseTone({ phase: "ready", state: "hot" })).toBe("success");
    expect(phaseTone({ phase: "provisioning", state: null })).toBe("pending");
  });
});

describe("previewTeardownOutcome", () => {
  it("does not report completion for an accepted teardown", () => {
    expect(previewTeardownOutcome("terminating")).toBe("teardown started");
    expect(previewTeardownOutcome("absent")).toBe("torn down");
  });
});

describe("previewTeardownProgress", () => {
  it("reports the next incomplete controller check and bounded progress", () => {
    const progress = previewTeardownProgress({
      name: "preview-one",
      resourceName: "preview-one",
      complete: false,
      phase: "pending",
      checks: {
        runnerSucceeded: true,
        previewEnvironmentAbsent: false,
        applicationAbsent: false,
        agentRegistrationAbsent: false,
        agentNamespacesAbsent: false,
        databaseAbsent: true,
        natsStreamAbsent: true,
        headlampRegistrationAbsent: false,
        tailnetEgressAbsent: true,
        hostNamespaceAbsent: false,
        storageScopeAbsent: false,
        runnerIdentityAbsent: false,
      },
      message: null,
    });

    expect(progress).toEqual({
      completed: 4,
      total: 12,
      percent: 33,
      label: "Removing workload namespace",
      failed: false,
    });
  });
});

describe("accepted teardown tracking", () => {
  it("retains an accepted row when SEA omits its terminating namespace", () => {
    const ready = preview({ name: "ready-one" });
    const terminating = preview({
      name: "ending-one",
      phase: "terminating",
      ready: false,
    });

    expect(previewsWithAcceptedTeardowns([ready], [terminating])).toEqual([
      ready,
      terminating,
    ]);
    expect(previewsWithAcceptedTeardowns([ready], [ready])).toEqual([ready]);
  });

  it("binds status polling to the complete signed ticket", () => {
    const path = previewTeardownStatusPath({
      name: "ending-one",
      environmentUid: "uid-1",
      requestId: "request-1",
      sourceRevision: "b".repeat(40),
      signature: "e".repeat(64),
    });

    expect(path).toContain("/ending-one/teardown/status?");
    expect(path).toContain("environmentUid=uid-1");
    expect(path).toContain(`signature=${"e".repeat(64)}`);
  });
});

describe("sleepDisabledReason", () => {
  it("mirrors the SEA sleep-refusal contract", () => {
    expect(
      sleepDisabledReason({
        state: "hot",
        protected: false,
        pool: null,
        origin: { kind: "user" },
      }),
    ).toBeNull();
    expect(sleepDisabledReason({ state: "slept" })).toBe("Already sleeping");
    expect(sleepDisabledReason({ protected: true })).toContain("Protected");
    expect(sleepDisabledReason({ pool: "pool-1" })).toContain(
      "Legacy pool-backed",
    );
    expect(
      sleepDisabledReason({
        origin: { kind: "pull-request", reference: "42" },
      }),
    ).toContain("PR");
  });
});
