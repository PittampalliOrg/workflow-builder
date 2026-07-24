import { describe, expect, it } from "vitest";

import {
  createPrButtonState,
  parsePromotionResponse,
  pullRequestUrlFromPromotion,
  runVersionPromotion,
  selectRunPromotion,
  type CodeVersionRecord,
} from "./run-pr-promotion";

function legacy(overrides: Partial<CodeVersionRecord> = {}): CodeVersionRecord {
  return {
    artifactId: overrides.artifactId ?? "v1",
    fileId: "fileId" in overrides ? (overrides.fileId ?? null) : "file-1",
    payload: overrides.payload ?? { tier: "tar-overlay" },
    promotionGate:
      overrides.promotionGate ?? { required: false, allowed: true, reason: "not_required" },
    promotion: overrides.promotion ?? null,
    createdAt: overrides.createdAt ?? "2026-07-24T10:00:00Z",
  };
}

function strict(overrides: Partial<CodeVersionRecord> = {}): CodeVersionRecord {
  return legacy({
    payload: { tier: "tar-overlay-set", captureProtocol: "atomic-generation-v2" },
    ...overrides,
  });
}

describe("selectRunPromotion", () => {
  it("returns 'none' when there are no versions", () => {
    expect(selectRunPromotion([])).toEqual({ status: "none" });
  });

  it("returns 'strict-only' when only preview captures exist", () => {
    expect(selectRunPromotion([strict({ artifactId: "s1" })])).toEqual({ status: "strict-only" });
  });

  it("selects the newest legacy source bundle as ready", () => {
    const result = selectRunPromotion([
      legacy({ artifactId: "old", createdAt: "2026-07-24T09:00:00Z" }),
      legacy({ artifactId: "new", createdAt: "2026-07-24T11:00:00Z" }),
    ]);
    expect(result).toEqual({ status: "ready", artifactId: "new" });
  });

  it("ignores strict captures when a legacy bundle is present", () => {
    const result = selectRunPromotion([
      strict({ artifactId: "s1", createdAt: "2026-07-24T12:00:00Z" }),
      legacy({ artifactId: "v1", createdAt: "2026-07-24T10:00:00Z" }),
    ]);
    expect(result).toEqual({ status: "ready", artifactId: "v1" });
  });

  it("surfaces an already-open PR from the newest legacy version", () => {
    const result = selectRunPromotion([
      legacy({
        artifactId: "v1",
        promotion: { prUrl: "https://github.com/o/r/pull/7" },
      }),
    ]);
    expect(result).toEqual({
      status: "already-promoted",
      artifactId: "v1",
      prUrl: "https://github.com/o/r/pull/7",
    });
  });

  it("blocks when the source bundle blob is missing", () => {
    const result = selectRunPromotion([legacy({ artifactId: "v1", fileId: null })]);
    expect(result).toEqual({
      status: "gate-blocked",
      artifactId: "v1",
      reason: "source_bundle_unavailable",
    });
  });

  it("blocks when the promotion gate is required but not allowed", () => {
    const result = selectRunPromotion([
      legacy({
        artifactId: "v1",
        promotionGate: { required: true, allowed: false, reason: "score_below_threshold" },
      }),
    ]);
    expect(result).toEqual({
      status: "gate-blocked",
      artifactId: "v1",
      reason: "score_below_threshold",
    });
  });
});

describe("createPrButtonState", () => {
  it("is an actionable create button when ready", () => {
    const state = createPrButtonState({ status: "ready", artifactId: "v1" });
    expect(state).toMatchObject({ action: "create", disabled: false, artifactId: "v1" });
  });

  it("offers a view link for an already-open PR", () => {
    const state = createPrButtonState({
      status: "already-promoted",
      artifactId: "v1",
      prUrl: "https://github.com/o/r/pull/7",
    });
    expect(state).toMatchObject({ action: "view", disabled: false, prUrl: "https://github.com/o/r/pull/7" });
  });

  it("disables with an explanatory tooltip when gate-blocked", () => {
    const state = createPrButtonState({
      status: "gate-blocked",
      artifactId: "v1",
      reason: "score_below_threshold",
    });
    expect(state.disabled).toBe(true);
    expect(state.action).toBe("none");
    expect(state.tooltip).toMatch(/score/i);
  });

  it("routes strict-only runs to the dev detail page", () => {
    const state = createPrButtonState({ status: "strict-only" });
    expect(state.disabled).toBe(true);
    expect(state.tooltip).toMatch(/dev environment detail/i);
  });

  it("explains when there is nothing to promote", () => {
    const state = createPrButtonState({ status: "none" });
    expect(state.disabled).toBe(true);
    expect(state.tooltip).toMatch(/no promotable source bundle/i);
  });
});

describe("pullRequestUrlFromPromotion", () => {
  it("prefers an explicit prUrl", () => {
    expect(pullRequestUrlFromPromotion({ prUrl: "https://github.com/o/r/pull/3" })).toBe(
      "https://github.com/o/r/pull/3",
    );
  });

  it("reconstructs from repository + number", () => {
    expect(
      pullRequestUrlFromPromotion({ pullRequest: { repository: "o/r", number: 12 } }),
    ).toBe("https://github.com/o/r/pull/12");
  });

  it("returns null for incomplete records", () => {
    expect(pullRequestUrlFromPromotion({ repository: "o/r" })).toBeNull();
    expect(pullRequestUrlFromPromotion(null)).toBeNull();
  });
});

describe("parsePromotionResponse", () => {
  it("returns the PR url on success", () => {
    const outcome = parsePromotionResponse(true, 200, {
      ok: true,
      prUrl: "https://github.com/o/r/pull/9",
      branch: "promote/x",
    });
    expect(outcome).toEqual({ ok: true, prUrl: "https://github.com/o/r/pull/9", branch: "promote/x" });
  });

  it("accepts a branch-only success", () => {
    const outcome = parsePromotionResponse(true, 200, { ok: true, branch: "promote/x" });
    expect(outcome).toEqual({ ok: true, prUrl: null, branch: "promote/x" });
  });

  it("surfaces the gate error body", () => {
    const outcome = parsePromotionResponse(false, 409, {
      ok: false,
      error: "promotion_gate_failed",
    });
    expect(outcome).toEqual({ ok: false, error: "promotion_gate_failed" });
  });

  it("falls back to a status-coded message", () => {
    const outcome = parsePromotionResponse(false, 502, {});
    expect(outcome).toEqual({ ok: false, error: "Promotion failed (502)" });
  });
});

describe("runVersionPromotion", () => {
  it("POSTs mode:pr and returns the parsed outcome", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, prUrl: "https://github.com/o/r/pull/1" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const outcome = await runVersionPromotion("exec-1", "v1", fakeFetch);
    expect(outcome).toEqual({ ok: true, prUrl: "https://github.com/o/r/pull/1", branch: null });
    expect(calls[0].url).toBe("/api/workflows/executions/exec-1/versions/v1/promote");
    expect(calls[0].body).toEqual({ mode: "pr" });
  });

  it("maps a thrown fetch into an error outcome", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const outcome = await runVersionPromotion("exec-1", "v1", fakeFetch);
    expect(outcome).toEqual({ ok: false, error: "network down" });
  });
});
