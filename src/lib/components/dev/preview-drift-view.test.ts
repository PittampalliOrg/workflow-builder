import { describe, expect, it } from "vitest";

import type {
  PreviewDriftEntry,
  PreviewServiceDrift,
  PreviewServiceDriftStatus,
  PreviewStage,
} from "$lib/types/dev-previews";
import {
  DRIFT_STATUS_META,
  STAGE_META,
  STAGE_STEP_TOTAL,
  agentSessionLink,
  assessRevertRisk,
  driftEntryFor,
  driftSummaryChips,
  latestReceipt,
  pinVersionChip,
  reattachHref,
  receiptsTouchMigrations,
  runningVersionChip,
  shortDigest,
  shortSha,
  summarizeDriftOverview,
} from "./preview-drift-view";

function serviceRow(
  status: PreviewServiceDriftStatus,
  overrides: Partial<PreviewServiceDrift> = {},
): PreviewServiceDrift {
  return {
    service: "workflow-builder",
    running: {
      image: "ghcr.io/pittampalliorg/workflow-builder:git-abc",
      tag: "git-abc",
      digest: "sha256:" + "a".repeat(64),
      ready: true,
    },
    runningUnavailableReason: null,
    pin: { tag: "git-abc", digest: "sha256:" + "a".repeat(64), commitSha: "abc" },
    driftStatus: status,
    ...overrides,
  };
}

function entry(overrides: Partial<PreviewDriftEntry> = {}): PreviewDriftEntry {
  return {
    name: "feat-x",
    phase: "ready",
    state: "hot",
    lifecycle: "retained",
    stage: "ready",
    syncGeneration: null,
    services: [],
    receipts: [],
    ...overrides,
  };
}

describe("presentation metadata", () => {
  it("covers every drift status with label, classes and tooltip copy", () => {
    const statuses: PreviewServiceDriftStatus[] = [
      "in-sync",
      "behind-pin",
      "pin-behind-main",
      "diverged",
      "unknown",
    ];
    for (const status of statuses) {
      const meta = DRIFT_STATUS_META[status];
      expect(meta.label).toBeTruthy();
      expect(meta.badgeClass).toBeTruthy();
      expect(meta.dotClass).toBeTruthy();
      expect(meta.description.length).toBeGreaterThan(20);
    }
  });

  it("covers every stage; in-cycle steps stay within the progress total", () => {
    const stages: PreviewStage[] = [
      "provisioning",
      "agent-editing",
      "promoted",
      "retained",
      "sleeping",
      "ready",
      "failed",
    ];
    for (const stage of stages) {
      const meta = STAGE_META[stage];
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      if (meta.step !== null) {
        expect(meta.step).toBeGreaterThanOrEqual(1);
        expect(meta.step).toBeLessThanOrEqual(STAGE_STEP_TOTAL);
      }
    }
    expect(STAGE_META.sleeping.step).toBeNull();
    expect(STAGE_META.failed.step).toBeNull();
    expect(STAGE_META.promoted.step).toBe(STAGE_STEP_TOTAL);
  });
});

describe("summarizeDriftOverview + driftSummaryChips", () => {
  it("counts per-service verdicts across previews", () => {
    const counts = summarizeDriftOverview({
      previews: [
        entry({ services: [serviceRow("in-sync"), serviceRow("diverged")] }),
        entry({ name: "b", services: [serviceRow("behind-pin"), serviceRow("unknown")] }),
        entry({ name: "c", services: [serviceRow("pin-behind-main")] }),
      ],
    });
    expect(counts).toEqual({
      inSync: 1,
      behindPin: 1,
      pinBehindMain: 1,
      diverged: 1,
      unknown: 1,
      services: 5,
      previews: 3,
    });
  });

  it("returns null without an overview and orders chips most-severe first", () => {
    expect(summarizeDriftOverview(null)).toBeNull();
    expect(driftSummaryChips(null)).toEqual([]);

    const chips = driftSummaryChips(
      summarizeDriftOverview({
        previews: [
          entry({
            services: [serviceRow("in-sync"), serviceRow("diverged"), serviceRow("behind-pin")],
          }),
        ],
      }),
    );
    expect(chips.map((chip) => chip.status)).toEqual(["diverged", "behind-pin", "in-sync"]);
    expect(chips[0].count).toBe(1);
  });
});

describe("version chips", () => {
  it("shortens digests and shas", () => {
    expect(shortDigest("sha256:" + "ab".repeat(32))).toBe("abababababab");
    expect(shortDigest(null)).toBeNull();
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha(null)).toBeNull();
  });

  it("prefers the running tag, falls back to the digest, and reports null when slept", () => {
    expect(runningVersionChip(serviceRow("in-sync"))?.label).toBe("git-abc");
    const digestOnly = serviceRow("in-sync", {
      running: {
        image: "ghcr.io/x/y@sha256:" + "c".repeat(64),
        tag: null,
        digest: "sha256:" + "c".repeat(64),
        ready: true,
      },
    });
    expect(runningVersionChip(digestOnly)?.label).toBe("c".repeat(12));
    expect(
      runningVersionChip(
        serviceRow("unknown", { running: null, runningUnavailableReason: "slept" }),
      ),
    ).toBeNull();
  });

  it("labels the pin chip from tag or digest and titles it with the source sha", () => {
    const chip = pinVersionChip(serviceRow("in-sync"));
    expect(chip?.label).toBe("git-abc");
    expect(chip?.title).toContain("source abc");
    expect(pinVersionChip(serviceRow("unknown", { pin: null }))).toBeNull();
  });
});

describe("assessRevertRisk", () => {
  const receipt = (createdAt: string, changedPaths?: string[]) => ({
    prNumber: 12,
    prUrl: "https://github.com/o/r/pull/12",
    commitSha: "d".repeat(40),
    createdAt,
    ...(changedPaths ? { changedPaths } : {}),
  });

  it("flags a slept live preview with no captured receipts", () => {
    expect(
      assessRevertRisk({ state: "slept", mode: "live", lastActive: null, receipts: [] }),
    ).toEqual({ uncapturedSleep: true, migrationDrift: false });
  });

  it("flags a slept live preview whose activity postdates the newest receipt", () => {
    const risk = assessRevertRisk({
      state: "slept",
      mode: "live",
      lastActive: "2026-07-17T12:00:00Z",
      receipts: [receipt("2026-07-17T10:00:00Z")],
    });
    expect(risk.uncapturedSleep).toBe(true);
  });

  it("does not flag captured, awake, or reconciled previews", () => {
    expect(
      assessRevertRisk({
        state: "slept",
        mode: "live",
        lastActive: "2026-07-17T09:00:00Z",
        receipts: [receipt("2026-07-17T10:00:00Z")],
      }).uncapturedSleep,
    ).toBe(false);
    expect(
      assessRevertRisk({ state: "hot", mode: "live", lastActive: null, receipts: [] })
        .uncapturedSleep,
    ).toBe(false);
    expect(
      assessRevertRisk({ state: "slept", mode: "reconciled", lastActive: null, receipts: [] })
        .uncapturedSleep,
    ).toBe(false);
  });

  it("raises the migration caution only for drizzle/ paths", () => {
    expect(receiptsTouchMigrations([receipt("2026-07-17T10:00:00Z")])).toBe(false);
    expect(
      receiptsTouchMigrations([receipt("2026-07-17T10:00:00Z", ["src/lib/a.ts"])]),
    ).toBe(false);
    expect(
      receiptsTouchMigrations([receipt("2026-07-17T10:00:00Z", ["drizzle/0046_add.sql"])]),
    ).toBe(true);
    expect(
      receiptsTouchMigrations([
        receipt("2026-07-17T10:00:00Z", ["services/x/drizzle/0001_init.sql"]),
      ]),
    ).toBe(true);
    // "drizzle" as a bare substring must not match.
    expect(
      receiptsTouchMigrations([receipt("2026-07-17T10:00:00Z", ["src/drizzled/notes.md"])]),
    ).toBe(false);
  });
});

describe("deep links", () => {
  it("joins a preview to its live group via the non-user owner id", () => {
    const link = agentSessionLink(
      { owner: { kind: "workflow", id: "exec-1" }, provenance: null },
      [{ executionId: "exec-1", sessionUrl: "/sessions/s1" }],
      "acme",
    );
    expect(link).toEqual({
      executionId: "exec-1",
      sessionUrl: "/sessions/s1",
      environmentHref: "/workspaces/acme/dev/exec-1",
    });
  });

  it("falls back to provenance executionId and returns null when no group matches", () => {
    const viaProvenance = agentSessionLink(
      { owner: { kind: "user", id: "u1" }, provenance: { executionId: "exec-2" } },
      [{ executionId: "exec-2", sessionUrl: null }],
      "acme",
    );
    expect(viaProvenance?.executionId).toBe("exec-2");
    expect(viaProvenance?.sessionUrl).toBeNull();

    expect(
      agentSessionLink({ owner: { kind: "user", id: "u1" }, provenance: null }, [], "acme"),
    ).toBeNull();
  });

  it("builds the re-attach deep link with an encoded name", () => {
    expect(reattachHref("acme", "feat x")).toBe("/workspaces/acme/dev?launch=feat%20x");
  });

  it("finds entries and newest receipts", () => {
    const overview = { previews: [entry({ name: "feat-x" })] };
    expect(driftEntryFor(overview, "feat-x")?.name).toBe("feat-x");
    expect(driftEntryFor(overview, "other")).toBeNull();
    expect(latestReceipt(entry())).toBeNull();
    const withReceipts = entry({
      receipts: [
        { prNumber: 2, prUrl: "u2", commitSha: "c2", createdAt: "2026-07-17T11:00:00Z" },
        { prNumber: 1, prUrl: "u1", commitSha: "c1", createdAt: "2026-07-16T11:00:00Z" },
      ],
    });
    expect(latestReceipt(withReceipts)?.prNumber).toBe(2);
  });
});
