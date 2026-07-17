import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROFILED_PREVIEW_TTL_HOURS,
  PREVIEW_TTL_HOURS_BOUNDS,
  claimVclusterPreview,
  provisionVclusterPreview,
  resolvePreviewTtlHours,
} from "./vcluster-preview";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String((init as RequestInit).body));
}

describe("vcluster-preview TTL plumbing (expires-at reap marker)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("derives the SEA ttlHours (expires-at source) from the lifecycle input", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "feature-one", status: "provisioning" }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);

    // proof26 lifecycle shape: profiled app-live launch with ttlHours: 4.
    await provisionVclusterPreview({
      name: "feature-one",
      profile: "app-live",
      lifecycle: "retained",
      origin: { kind: "workflow", reference: "parent-execution" },
      ttlHours: 4,
    });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      action: "up",
      ttlHours: 4,
    });
  });

  it("defaults ttlHours on profiled launches that omit it so the preview stays reapable", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/claim")) return jsonResponse({ detail: "empty" }, 404);
      return jsonResponse({ name: "feature-one", status: "provisioning" }, 202);
    });
    vi.stubGlobal("fetch", fetchMock);

    await claimVclusterPreview({ name: "feature-one", profile: "app-live" });
    await provisionVclusterPreview({ name: "feature-one", profile: "app-live" });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      ttlHours: DEFAULT_PROFILED_PREVIEW_TTL_HOURS,
    });
    expect(bodyOf(fetchMock.mock.calls[1]?.[1])).toMatchObject({
      action: "up",
      ttlHours: DEFAULT_PROFILED_PREVIEW_TTL_HOURS,
    });
  });

  it("keeps the legacy/human never-auto-reaped shape: no profile + no ttlHours = omitted", async () => {
    vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-api");
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: "human", status: "provisioning" }, 202),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provisionVclusterPreview({ name: "human" });
    expect("ttlHours" in bodyOf(fetchMock.mock.calls[0]?.[1])).toBe(false);
  });

  it("clamps explicit ttlHours to the VAP-admitted 1-168 range", () => {
    expect(resolvePreviewTtlHours({ profile: "app-live", ttlHours: 0 })).toBe(
      PREVIEW_TTL_HOURS_BOUNDS.min,
    );
    expect(resolvePreviewTtlHours({ profile: "app-live", ttlHours: 400 })).toBe(
      PREVIEW_TTL_HOURS_BOUNDS.max,
    );
    expect(resolvePreviewTtlHours({ ttlHours: 24 })).toBe(24);
    expect(resolvePreviewTtlHours({ profile: "app-live" })).toBe(
      DEFAULT_PROFILED_PREVIEW_TTL_HOURS,
    );
    expect(resolvePreviewTtlHours({})).toBeUndefined();
  });
});
