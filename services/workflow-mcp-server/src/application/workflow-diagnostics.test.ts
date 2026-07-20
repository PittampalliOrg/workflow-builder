import { describe, expect, it, vi } from "vitest";
import type { WorkflowDiagnosticsPort } from "../ports/workflow-diagnostics.js";
import { ApplicationWorkflowDiagnosticsService } from "./workflow-diagnostics.js";

function port(
  overrides: Partial<WorkflowDiagnosticsPort> = {},
): WorkflowDiagnosticsPort {
  return {
    listWorkflowExecutions: vi.fn(async () => ({ executions: [] })),
    getExecutionOverview: vi.fn(async () => ({
      execution: { status: "error" },
    })),
    getDigest: vi.fn(async () => ({ issues: [{ code: "failed" }] })),
    searchSpans: vi.fn(async () => ({ spans: [{ spanId: "span-1" }] })),
    getSpan: vi.fn(async () => ({ span: { spanId: "span-1" } })),
    getLlmTurns: vi.fn(async () => ({ turns: [] })),
    getToolCalls: vi.fn(async () => ({ toolCalls: [] })),
    getSpanTree: vi.fn(async () => ({ roots: [] })),
    searchLogs: vi.fn(async () => ({ logs: [{ body: "failed" }] })),
    getBrowserScreenshot: vi.fn(async () => ({
      contentType: "image/png",
      payloadBase64: "cGl4ZWxz",
    })),
    ...overrides,
  };
}

describe("ApplicationWorkflowDiagnosticsService", () => {
  it("assembles a bounded first-pass diagnostic from independent reads", async () => {
    const adapter = port();
    const service = new ApplicationWorkflowDiagnosticsService(adapter);

    await expect(
      service.debugWorkflowExecution("execution-1"),
    ).resolves.toMatchObject({
      overview: { execution: { status: "error" } },
      digest: { issues: [{ code: "failed" }] },
      errorSpans: { spans: [{ spanId: "span-1" }] },
      errorLogs: { logs: [{ body: "failed" }] },
      evidenceCoverage: {
        overview: "available",
        digest: "available",
        spans: "available",
        logs: "available",
      },
      warnings: [],
      telemetry: {
        state: "complete",
        isFinal: true,
        warnings: [],
      },
    });
    expect(adapter.searchSpans).toHaveBeenCalledWith("execution-1", {
      errorsOnly: true,
      limit: 20,
    });
    expect(adapter.searchLogs).toHaveBeenCalledWith("execution-1", {
      errorsOnly: true,
      limit: 40,
    });
  });

  it("keeps the authoritative overview and reports partial trace coverage", async () => {
    const service = new ApplicationWorkflowDiagnosticsService(
      port({
        getDigest: vi.fn(async () => {
          throw new Error("digest unavailable");
        }),
        searchLogs: vi.fn(async () => {
          throw new Error("logs delayed");
        }),
      }),
    );

    await expect(
      service.debugWorkflowExecution("execution-1"),
    ).resolves.toMatchObject({
      overview: { execution: { status: "error" } },
      digest: null,
      errorLogs: null,
      evidenceCoverage: { digest: "unavailable", logs: "unavailable" },
      warnings: [
        { source: "digest", message: "digest unavailable" },
        { source: "logs", message: "logs delayed" },
      ],
      telemetry: {
        state: "partial",
        isFinal: false,
        warnings: ["digest: digest unavailable", "logs: logs delayed"],
        refreshAfterMs: 5_000,
      },
    });
  });

  it("maps fulfilled downstream telemetry into state-aware evidence coverage", async () => {
    const service = new ApplicationWorkflowDiagnosticsService(
      port({
        getExecutionOverview: vi.fn(async () => ({
          execution: { status: "running" },
        })),
        getDigest: vi.fn(async () => ({
          telemetry: {
            state: "partial",
            isFinal: false,
            warnings: ["Digest is journal-only"],
            refreshAfterMs: 2_500,
          },
        })),
        searchSpans: vi.fn(async () => ({
          spans: [],
          telemetry: {
            state: "pending",
            isFinal: false,
            warnings: ["Spans are still ingesting"],
            refreshAfterMs: 1_500,
          },
        })),
        searchLogs: vi.fn(async () => ({
          logs: [],
          telemetry: {
            state: "unavailable",
            isFinal: true,
            warnings: ["Log storage is disabled"],
          },
        })),
      }),
    );

    await expect(
      service.debugWorkflowExecution("execution-1"),
    ).resolves.toMatchObject({
      evidenceCoverage: {
        overview: "available",
        digest: "partial",
        spans: "pending",
        logs: "unavailable",
      },
      warnings: [
        { source: "digest", message: "Digest is journal-only" },
        { source: "spans", message: "Spans are still ingesting" },
        { source: "logs", message: "Log storage is disabled" },
      ],
      telemetry: {
        state: "pending",
        isFinal: false,
        warnings: [
          "digest: Digest is journal-only",
          "spans: Spans are still ingesting",
          "logs: Log storage is disabled",
        ],
        refreshAfterMs: 1_500,
      },
    });
  });

  it("keeps terminal degraded evidence final when downstream marks it final", async () => {
    const finalPartial = {
      telemetry: {
        state: "partial" as const,
        isFinal: true,
        warnings: ["Historical telemetry is incomplete"],
      },
    };
    const service = new ApplicationWorkflowDiagnosticsService(
      port({
        getDigest: vi.fn(async () => finalPartial),
        searchSpans: vi.fn(async () => finalPartial),
        searchLogs: vi.fn(async () => finalPartial),
      }),
    );

    const diagnostic = await service.debugWorkflowExecution("execution-1");

    expect(diagnostic.telemetry).toMatchObject({
      state: "partial",
      isFinal: true,
    });
    expect(diagnostic.telemetry).not.toHaveProperty("refreshAfterMs");
  });
});
