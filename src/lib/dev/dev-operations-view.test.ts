import { describe, expect, it } from "vitest";

import {
  formatBootElapsed,
  previewDeliveryLabel,
  previewGitOpsHref,
  previewProfileLabel,
  previewRuntimePollInterval,
  PREVIEW_RUNTIME_PROVISIONING_POLL_MS,
  PREVIEW_RUNTIME_STABLE_POLL_MS,
  summarizeDevOperations,
} from "./dev-operations-view";
import type { VclusterPreviewSummary } from "$lib/types/dev-previews";

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

describe("dev operations view model", () => {
  it("summarizes ready, provisioning, attention, session, and capacity state", () => {
    expect(
      summarizeDevOperations(
        [
          preview(),
          preview({ name: "starting", phase: "provisioning", ready: false }),
          preview({ name: "broken", phase: "failed", ready: false }),
        ],
        [
          { primary: { ready: true, runStatus: "running" } },
          { primary: { ready: false, runStatus: "running" } },
        ],
        {
          awake: 3,
          slept: 0,
          total: 3,
          baking: 1,
          free: 0,
          claimed: 0,
          recycling: 0,
          max: 6,
          totalMax: 6,
          poolSize: 0,
        },
      ),
    ).toEqual({
      ready: 2,
      provisioning: 2,
      attention: 1,
      liveSessions: 2,
      previewCapacity: "3/6",
    });
  });

  it("keeps mutable previews outside GitOps and links reconciled previews", () => {
    const live = preview();
    const reconciled = preview({
      mode: "reconciled",
      origin: { kind: "pull-request", reference: "42" },
    });
    expect(previewDeliveryLabel(live)).toBe("Uncommitted preview state");
    expect(previewGitOpsHref(live)).toBeNull();
    expect(previewDeliveryLabel(reconciled)).toBe("Git-reconciled candidate");
    expect(previewGitOpsHref(reconciled)).toBe(
      "/admin/gitops?tab=services&service=workflow-builder",
    );
  });

  it("classifies cancelled sessions as attention instead of provisioning", () => {
    expect(
      summarizeDevOperations(
        [],
        [{ primary: { ready: false, runStatus: "cancelled" } }],
        null,
      ),
    ).toMatchObject({
      ready: 0,
      provisioning: 0,
      attention: 1,
      liveSessions: 1,
    });
  });

  it("keeps terminating previews visible as active lifecycle work", () => {
    expect(
      summarizeDevOperations(
        [preview({ phase: "terminating", ready: false })],
        [],
        null,
      ),
    ).toMatchObject({
      ready: 0,
      provisioning: 1,
      attention: 0,
    });
  });

  it("formats profile and elapsed provisioning labels", () => {
    expect(previewProfileLabel("app-live")).toBe("Application development");
    expect(previewProfileLabel("manifest-candidate")).toBe(
      "Infrastructure candidate",
    );
    expect(formatBootElapsed(185)).toBe("3m 05s");
  });

  it("polls runtime observations quickly only while a preview is converging", () => {
    const activeRuntime = {
      reconciliationSucceeded: false,
      provision: { active: true, failed: false, succeeded: false },
    };
    const stableRuntime = {
      reconciliationSucceeded: true,
      provision: { active: false, failed: false, succeeded: true },
    };

    expect(
      previewRuntimePollInterval(
        preview({ phase: "provisioning", ready: false }),
        activeRuntime,
      ),
    ).toBe(PREVIEW_RUNTIME_PROVISIONING_POLL_MS);
    expect(previewRuntimePollInterval(preview(), stableRuntime)).toBe(
      PREVIEW_RUNTIME_STABLE_POLL_MS,
    );
    expect(
      previewRuntimePollInterval(preview({ phase: "failed", ready: false }), {
        ...activeRuntime,
        provision: { active: false, failed: true, succeeded: false },
      }),
    ).toBe(PREVIEW_RUNTIME_STABLE_POLL_MS);
    expect(
      previewRuntimePollInterval(
        preview({ state: "slept", phase: "slept", ready: false }),
        null,
      ),
    ).toBe(PREVIEW_RUNTIME_STABLE_POLL_MS);
  });
});
