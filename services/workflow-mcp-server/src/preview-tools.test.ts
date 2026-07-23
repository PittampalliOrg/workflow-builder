import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewEnvironmentUseCases } from "./application/preview-environments.js";
import type { WorkflowMcpPrincipal } from "./auth-context.js";
import { PreviewEnvironmentRequestError } from "./ports/preview-environments.js";
import { registerPreviewEnvironmentTools } from "./preview-tools.js";

const { setSpanOutputMock } = vi.hoisted(() => ({
  setSpanOutputMock: vi.fn(),
}));

vi.mock("./observability/content.js", async () => {
  const actual = await vi.importActual<
    typeof import("./observability/content.js")
  >("./observability/content.js");
  return { ...actual, setSpanOutput: setSpanOutputMock };
});

function principal(scopes: string[]): WorkflowMcpPrincipal {
  return {
    authMode: "workspace_api_key",
    userId: "user-1",
    projectId: "project-1",
    scopes,
    principalAssertion: "signed-principal",
    capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
  };
}

function useCases(
  overrides: Partial<PreviewEnvironmentUseCases> = {},
): PreviewEnvironmentUseCases {
  return {
    list: vi.fn(async () => ({ previews: [], counts: null })),
    listServices: vi.fn(async () => ({ services: [] })),
    get: vi.fn(async () => ({
      preview: {
        name: "preview-one",
        phase: "ready",
        ready: true,
        url: null,
        targetCluster: "dev",
        lifecycle: "retained",
        protected: false,
        origin: { kind: "user" },
        expiresAt: null,
        platformRevision: "a".repeat(40),
        sourceRevision: "b".repeat(40),
        catalogDigest: `sha256:${"c".repeat(64)}`,
        services: [],
        provenance: { requestId: "request-1" },
      },
    })),
    launch: vi.fn(async (input) => ({
      preview: {
        name: input.name,
        phase: "provisioning",
        ready: false,
        url: null,
        targetCluster: "dev",
        lifecycle: "retained",
        protected: false,
        origin: { kind: "user" },
        expiresAt: null,
        platformRevision: "a".repeat(40),
        sourceRevision: "b".repeat(40),
        catalogDigest: null,
        services: input.services ?? [],
        provenance: { requestId: "request-1" },
      },
      pooled: false,
    })),
    debug: vi.fn(async () => ({
      preview: { name: "preview-one", phase: "ready" } as any,
      runtime: { services: [] },
      traces: [],
      traceServices: [],
      traceObservedAt: "2026-07-19T12:00:00.000Z",
      traceFailure: null,
      generationStable: true,
      evidenceCoverage: {
        preview: "available" as const,
        runtime: "available" as const,
        traces: "available" as const,
      },
      telemetry: {
        state: "complete" as const,
        isFinal: true,
        warnings: [],
      },
    })),
    queryTraces: vi.fn(async () => ({
      traces: [],
      services: [],
      observedAt: "2026-07-19T12:00:00.000Z",
    })),
    teardown: vi.fn(async () => ({
      preview: { name: "preview-one", phase: "terminating" } as any,
      teardown: {
        name: "preview-one",
        environmentUid: "uid-1",
        requestId: "request-1",
        sourceRevision: "b".repeat(40),
        signature: "e".repeat(64),
      },
    })),
    getTeardownStatus: vi.fn(async (ticket) => ({
      teardown: { phase: "complete" },
      ticket,
    })),
    ...overrides,
  };
}

function fakeServer() {
  const captured: Array<{
    name: string;
    config: Record<string, any>;
    handler: (args: any) => Promise<any>;
  }> = [];
  return {
    server: {
      registerTool(name: string, config: Record<string, any>, handler: any) {
        captured.push({ name, config, handler });
      },
    },
    captured,
  };
}

describe("preview environment tools", () => {
  beforeEach(() => setSpanOutputMock.mockClear());

  it("registers reads with workflow:read and lifecycle commands with workflow:execute", () => {
    const read = fakeServer();
    registerPreviewEnvironmentTools(read.server as any, {
      principal: principal(["workflow:read"]),
      previews: useCases(),
    });
    expect(read.captured.map((tool) => tool.name)).toEqual([
      "list_preview_services",
      "list_preview_environments",
      "get_preview_environment",
      "debug_preview_environment",
      "query_preview_traces",
      "get_preview_teardown_status",
    ]);

    const execute = fakeServer();
    registerPreviewEnvironmentTools(execute.server as any, {
      principal: principal(["workflow:execute"]),
      previews: useCases(),
    });
    expect(execute.captured.map((tool) => tool.name)).toEqual([
      "launch_preview_environment",
      "teardown_preview_environment",
    ]);
  });

  it("launches without inventing a service selection and returns a deterministic poll action", async () => {
    const previews = useCases();
    const { server, captured } = fakeServer();
    registerPreviewEnvironmentTools(server as any, {
      principal: principal(["workflow:read", "workflow:execute"]),
      previews,
    });
    const tool = captured.find(
      (entry) => entry.name === "launch_preview_environment",
    );

    const result = await tool?.handler({ name: "preview-one", ttlHours: 12 });

    expect(previews.launch).toHaveBeenCalledWith({
      name: "preview-one",
      ttlHours: 12,
    });
    expect(tool?.config.description).toContain("user-owned");
    expect(tool?.config.description).toContain("dynamic-script preview lifecycle");
    expect(result.structuredContent).toMatchObject({
      ok: true,
      telemetry: { state: "pending", refreshAfterMs: 5_000 },
      nextActions: [
        {
          tool: "get_preview_environment",
          arguments: { name: "preview-one" },
        },
      ],
    });
  });

  it("documents read-only protection and active-use teardown interlocks", () => {
    const { server, captured } = fakeServer();
    registerPreviewEnvironmentTools(server as any, {
      principal: principal(["workflow:read", "workflow:execute"]),
      previews: useCases(),
    });

    expect(
      captured.find((entry) => entry.name === "get_preview_environment")
        ?.config.description,
    ).toContain("protected flag");
    const teardown = captured.find(
      (entry) => entry.name === "teardown_preview_environment",
    );
    expect(teardown?.config.description).toContain("active or unverified workflow ownership");
    expect(
      teardown?.config.inputSchema.discardUnarchived.description,
    ).toContain("never overrides protected or active-use checks");
  });

  it("returns the signed teardown ticket to the caller without putting it in span output", async () => {
    const { server, captured } = fakeServer();
    registerPreviewEnvironmentTools(server as any, {
      principal: principal(["workflow:read", "workflow:execute"]),
      previews: useCases(),
    });
    const tool = captured.find(
      (entry) => entry.name === "teardown_preview_environment",
    );

    const result = await tool?.handler({
      name: "preview-one",
      expectedRequestId: "request-1",
      expectedSourceRevision: "b".repeat(40),
    });

    expect(result.structuredContent.nextActions[0]).toMatchObject({
      tool: "get_preview_teardown_status",
      arguments: { signature: "e".repeat(64) },
    });
    expect(JSON.stringify(setSpanOutputMock.mock.calls)).not.toContain(
      "e".repeat(64),
    );
  });

  it("supports the full 7d trace retention window", async () => {
    const previews = useCases();
    const { server, captured } = fakeServer();
    registerPreviewEnvironmentTools(server as any, {
      principal: principal(["workflow:read"]),
      previews,
    });
    const tool = captured.find((entry) => entry.name === "query_preview_traces");

    await tool?.handler({ name: "preview-one", range: "7d", limit: 100 });

    expect(previews.queryTraces).toHaveBeenCalledWith("preview-one", {
      range: "7d",
      limit: 100,
    });
  });

  it("turns a typed trace timeout into a narrower retry with the same filters", async () => {
    const previews = useCases({
      queryTraces: vi.fn(async () => {
        throw new PreviewEnvironmentRequestError(
          "trace evidence timed out",
          "preview_trace_timeout",
          true,
          1_000,
          { range: "24h", retryRange: "6h" },
        );
      }),
    });
    const { server, captured } = fakeServer();
    registerPreviewEnvironmentTools(server as any, {
      principal: principal(["workflow:read"]),
      previews,
    });
    const tool = captured.find((entry) => entry.name === "query_preview_traces");

    const result = await tool?.handler({
      name: "preview-one",
      range: "24h",
      status: "error",
      service: "workflow-builder",
      limit: 50,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "preview_trace_timeout", retryable: true },
      telemetry: { state: "unavailable", refreshAfterMs: 1_000 },
      nextActions: [
        {
          tool: "query_preview_traces",
          arguments: {
            name: "preview-one",
            range: "6h",
            status: "error",
            service: "workflow-builder",
            limit: 50,
          },
        },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "ClickHouse",
    );
  });

  it("narrows only a typed debug timeout while preserving every trace filter", async () => {
    const previews = useCases({
      debug: vi.fn(async () => ({
        preview: { name: "preview-one", phase: "ready" } as any,
        runtime: { services: [] },
        traces: null,
        traceServices: [],
        traceObservedAt: null,
        traceFailure: {
          code: "preview_trace_timeout" as const,
          retryable: true,
          range: "24h" as const,
          retryRange: "6h" as const,
          retryAfterMs: 1_000,
        },
        generationStable: true,
        evidenceCoverage: {
          preview: "available" as const,
          runtime: "available" as const,
          traces: "unavailable" as const,
        },
        telemetry: {
          state: "partial" as const,
          isFinal: false,
          warnings: [
            "traces: Preview trace query timed out for range 24h; retry with range 6h.",
          ],
          refreshAfterMs: 5_000,
        },
      })),
    });
    const { server, captured } = fakeServer();
    registerPreviewEnvironmentTools(server as any, {
      principal: principal(["workflow:read"]),
      previews,
    });
    const tool = captured.find(
      (entry) => entry.name === "debug_preview_environment",
    );

    const result = await tool?.handler({
      name: "preview-one",
      range: "24h",
      status: "error",
      service: "workflow-builder",
      search: "failed render",
      limit: 50,
    });

    expect(result.structuredContent.nextActions[0]).toMatchObject({
      tool: "query_preview_traces",
      arguments: {
        name: "preview-one",
        range: "6h",
        status: "error",
        service: "workflow-builder",
        search: "failed render",
        limit: 50,
      },
    });
  });

  it("does not suggest a narrower query for a non-timeout trace failure", async () => {
    const previews = useCases({
      debug: vi.fn(async () => ({
        preview: { name: "preview-one", phase: "ready" } as any,
        runtime: { services: [] },
        traces: null,
        traceServices: [],
        traceObservedAt: null,
        traceFailure: {
          code: "preview_trace_unavailable" as const,
          retryable: true,
          retryAfterMs: 5_000,
        },
        generationStable: true,
        evidenceCoverage: {
          preview: "available" as const,
          runtime: "available" as const,
          traces: "unavailable" as const,
        },
        telemetry: {
          state: "partial" as const,
          isFinal: false,
          warnings: ["traces: Preview trace evidence is unavailable."],
          refreshAfterMs: 5_000,
        },
      })),
    });
    const { server, captured } = fakeServer();
    registerPreviewEnvironmentTools(server as any, {
      principal: principal(["workflow:read"]),
      previews,
    });
    const tool = captured.find(
      (entry) => entry.name === "debug_preview_environment",
    );

    const result = await tool?.handler({ name: "preview-one", range: "24h" });

    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        traceFailure: {
          code: "preview_trace_unavailable",
          retryable: true,
        },
      },
      nextActions: [],
    });
  });

  it("fails closed when teardown polling returns a non-success terminal phase", async () => {
    const previews = useCases({
      getTeardownStatus: vi.fn(async (ticket) => ({
        teardown: {
          phase: "failed",
          checks: { "runner-succeeded": false },
          message: "runner failed",
        },
        ticket,
      })),
    });
    const { server, captured } = fakeServer();
    registerPreviewEnvironmentTools(server as any, {
      principal: principal(["workflow:read"]),
      previews,
    });
    const tool = captured.find(
      (entry) => entry.name === "get_preview_teardown_status",
    );

    const result = await tool?.handler({
      name: "preview-one",
      environmentUid: "uid-1",
      requestId: "request-1",
      sourceRevision: "b".repeat(40),
      signature: "e".repeat(64),
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      telemetry: { state: "unavailable", isFinal: true },
      data: { teardown: { phase: "failed" } },
      error: {
        code: "preview_teardown_contract_mismatch",
        retryable: false,
      },
    });
  });
});
