import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  PreviewEnvironmentRequestError,
  type PreviewEnvironmentSummary,
  type PreviewEnvironmentsPort,
} from "../ports/preview-environments.js";
import { ApplicationPreviewEnvironmentService } from "./preview-environments.js";

function preview(
  overrides: Partial<PreviewEnvironmentSummary> = {},
): PreviewEnvironmentSummary {
  return {
    name: "preview-one",
    phase: "ready",
    ready: true,
    url: "https://preview-one.test",
    targetCluster: "dev",
    lifecycle: "retained",
    expiresAt: "2026-07-20T00:00:00.000Z",
    platformRevision: "a".repeat(40),
    sourceRevision: "b".repeat(40),
    catalogDigest: `sha256:${"c".repeat(64)}`,
    services: ["workflow-builder"],
    provenance: { requestId: "request-1" },
    ...overrides,
  };
}

function port(
  overrides: Partial<PreviewEnvironmentsPort> = {},
): PreviewEnvironmentsPort {
  return {
    list: vi.fn(async () => ({ previews: [], counts: null })),
    listServices: vi.fn(async () => ({ services: [] })),
    get: vi.fn(async () => ({ preview: preview() })),
    launch: vi.fn(async () => ({ preview: preview(), pooled: false })),
    getRuntime: vi.fn(async () => ({ runtime: { services: [] } })),
    queryTraces: vi.fn(async () => ({
      traces: [{ traceId: "trace-1" }],
      services: ["workflow-builder"],
      observedAt: "2026-07-19T12:00:00.000Z",
    })),
    teardown: vi.fn(async () => ({ preview: preview(), teardown: null })),
    getTeardownStatus: vi.fn(async (ticket) => ({
      teardown: { phase: "complete" },
      ticket,
    })),
    ...overrides,
  };
}

describe("ApplicationPreviewEnvironmentService", () => {
  it("keeps transport and cluster concerns behind its port", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "preview-environments.ts"),
      "utf8",
    );
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("kubernetes");
    expect(source).not.toContain("X-Internal-Token");
  });

  it("returns a complete bounded bundle only when the generation stays stable", async () => {
    const adapter = port();
    const service = new ApplicationPreviewEnvironmentService(adapter);

    const result = await service.debug("preview-one", {
      range: "7d",
      status: "error",
      limit: 25,
    });

    expect(result).toMatchObject({
      preview: { name: "preview-one", phase: "ready" },
      runtime: { services: [] },
      traces: [{ traceId: "trace-1" }],
      traceServices: ["workflow-builder"],
      traceFailure: null,
      generationStable: true,
      evidenceCoverage: {
        preview: "available",
        runtime: "available",
        traces: "available",
      },
      telemetry: { state: "complete", isFinal: true, warnings: [] },
    });
    expect(adapter.queryTraces).toHaveBeenCalledWith("preview-one", {
      range: "7d",
      status: "error",
      limit: 25,
    });
  });

  it("performs the final generation fence only after runtime and trace reads settle", async () => {
    const order: string[] = [];
    let releaseRuntime!: () => void;
    const runtimeReady = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const get = vi.fn(async () => {
      order.push(`get-${get.mock.calls.length}`);
      return { preview: preview() };
    });
    const adapter = port({
      get,
      getRuntime: vi.fn(async () => {
        order.push("runtime-start");
        await runtimeReady;
        order.push("runtime-end");
        return { runtime: { services: [] } };
      }),
    });
    const service = new ApplicationPreviewEnvironmentService(adapter);

    const pending = service.debug("preview-one", {});
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    releaseRuntime();
    await pending;

    expect(get).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "get-1",
      "runtime-start",
      "runtime-end",
      "get-2",
    ]);
  });

  it("marks mixed-generation or unavailable evidence partial instead of presenting it as final", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ preview: preview() })
      .mockResolvedValueOnce({
        preview: preview({ provenance: { requestId: "request-2" } }),
      });
    const adapter = port({
      get,
      getRuntime: vi.fn(async () => {
        throw new Error("runtime unavailable");
      }),
    });
    const service = new ApplicationPreviewEnvironmentService(adapter);

    const result = await service.debug("preview-one", {});

    expect(result.generationStable).toBe(false);
    expect(result.runtime).toBeNull();
    expect(result.telemetry).toMatchObject({
      state: "partial",
      isFinal: false,
      refreshAfterMs: 5_000,
    });
    expect(result.telemetry.warnings).toEqual(
      expect.arrayContaining([
        "runtime: runtime unavailable",
        expect.stringContaining("generation could not be proven stable"),
      ]),
    );
  });

  it("carries a typed trace timeout as safe retry metadata", async () => {
    const adapter = port({
      queryTraces: vi.fn(async () => {
        throw new PreviewEnvironmentRequestError(
          "upstream detail that must not escape",
          "preview_trace_timeout",
          true,
          1_000,
          {
            range: "24h",
            retryRange: "6h",
            backend: "http://observability-internal",
          },
        );
      }),
    });
    const service = new ApplicationPreviewEnvironmentService(adapter);

    const result = await service.debug("preview-one", {
      range: "24h",
      status: "error",
      service: "workflow-builder",
      search: "failed render",
      limit: 50,
    });

    expect(result).toMatchObject({
      traces: null,
      traceFailure: {
        code: "preview_trace_timeout",
        retryable: true,
        range: "24h",
        retryRange: "6h",
        retryAfterMs: 1_000,
      },
      evidenceCoverage: { traces: "unavailable" },
      telemetry: {
        state: "partial",
        isFinal: false,
        warnings: [
          "traces: Preview trace query timed out for range 24h; retry with range 6h.",
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("upstream detail");
    expect(JSON.stringify(result)).not.toContain("observability-internal");
  });

  it(
    "sanitizes non-timeout trace failures without inventing retry ranges",
    async () => {
      const adapter = port({
        queryTraces: vi.fn(async () => {
          throw new PreviewEnvironmentRequestError(
            "failed to reach http://observability-internal",
            "preview_management_unavailable",
            true,
            5_000,
            { backend: "clickhouse" },
          );
        }),
      });
      const service = new ApplicationPreviewEnvironmentService(adapter);

      const result = await service.debug("preview-one", { range: "24h" });

      expect(result.traceFailure).toEqual({
        code: "preview_trace_unavailable",
        retryable: true,
        retryAfterMs: 5_000,
      });
      expect(result.telemetry.warnings).toContain(
        "traces: Preview trace evidence is unavailable.",
      );
      expect(JSON.stringify(result)).not.toContain("observability-internal");
      expect(JSON.stringify(result)).not.toContain("clickhouse");
    },
  );
});
