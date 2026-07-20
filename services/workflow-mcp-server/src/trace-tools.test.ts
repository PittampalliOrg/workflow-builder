import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDiagnosticsUseCases } from "./application/workflow-diagnostics.js";
import type { WorkflowMcpPrincipal } from "./auth-context.js";
import { registerTraceTools } from "./trace-tools.js";

const { setSpanOutputMock } = vi.hoisted(() => ({
  setSpanOutputMock: vi.fn(),
}));

vi.mock("./observability/content.js", async () => {
  const actual = await vi.importActual<
    typeof import("./observability/content.js")
  >("./observability/content.js");
  return { ...actual, setSpanOutput: setSpanOutputMock };
});

const principal: WorkflowMcpPrincipal = {
  authMode: "workspace_api_key",
  userId: "user-1",
  projectId: "project-1",
  scopes: ["workflow:read"],
  principalAssertion: "signed-principal",
  capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
};

function diagnostics(
  overrides: Partial<WorkflowDiagnosticsUseCases> = {},
): WorkflowDiagnosticsUseCases {
  return {
    listWorkflowExecutions: vi.fn(async () => ({ executions: [] })),
    debugWorkflowExecution: vi.fn(async () => ({
      overview: { execution: { status: "error" } },
      digest: { issues: [] },
      errorSpans: { spans: [{ spanId: "span-1" }] },
      errorLogs: { logs: [] },
      evidenceCoverage: {
        overview: "available",
        digest: "available",
        spans: "available",
        logs: "available",
      } as const,
      warnings: [],
      telemetry: {
        state: "complete" as const,
        isFinal: true,
        warnings: [] as string[],
      },
    })),
    getDigest: vi.fn(async () => ({ issues: [] })),
    searchSpans: vi.fn(async () => ({ spans: [{ spanId: "span-1" }] })),
    getSpan: vi.fn(async () => ({ span: { spanId: "span-1" } })),
    getLlmTurns: vi.fn(async () => ({ turns: [] })),
    getToolCalls: vi.fn(async () => ({ toolCalls: [] })),
    getSpanTree: vi.fn(async () => ({ roots: [] })),
    searchLogs: vi.fn(async () => ({ logs: [] })),
    getBrowserScreenshot: vi.fn(async () => ({
      storageRef: "screenshots/frame.png",
      contentType: "image/png",
      payloadBase64: "cGl4ZWxz",
      sizeBytes: 6,
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

describe("trace tools", () => {
  beforeEach(() => {
    setSpanOutputMock.mockClear();
  });

  it("keeps transport and legacy session concerns behind the diagnostics port", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "trace-tools.ts"),
      "utf8",
    );
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("currentGoalSessionId");
    expect(source).not.toContain("X-Wfb-Session-Id");
    expect(source).not.toContain("$lib/server/db");
  });

  it("registers the complete debug ladder for a sessionless workflow reader", () => {
    const { server, captured } = fakeServer();
    const tools = registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics(),
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "list_workflow_executions",
      "debug_workflow_execution",
      "trace_get_digest",
      "trace_search_spans",
      "trace_get_span",
      "trace_get_llm_turn",
      "trace_get_tree",
      "trace_get_tool_calls",
      "trace_get_logs",
      "trace_get_browser_screenshot",
    ]);
    expect(captured.every((tool) => tool.config.annotations.readOnlyHint)).toBe(
      true,
    );
    expect(captured.every((tool) => tool.config.outputSchema)).toBe(true);
  });

  it("returns browser screenshots as native MCP image content", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics(),
    });
    const tool = captured.find(
      (entry) => entry.name === "trace_get_browser_screenshot",
    );

    const response = await tool?.handler({
      executionId: "execution-1",
      storageRef: "screenshots/frame.png",
    });

    expect(response.content).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", data: "cGl4ZWxz", mimeType: "image/png" },
    ]);
    expect(response.structuredContent).toMatchObject({
      ok: true,
      data: {
        storageRef: "screenshots/frame.png",
        contentType: "image/png",
        sizeBytes: 6,
      },
    });
    expect(JSON.stringify(response.structuredContent)).not.toContain(
      "cGl4ZWxz",
    );
    expect(JSON.stringify(setSpanOutputMock.mock.calls)).not.toContain(
      "cGl4ZWxz",
    );
    expect(JSON.stringify(setSpanOutputMock.mock.calls)).not.toContain(
      "screenshots/frame.png",
    );
  });

  it("registers no diagnostics without workflow read scope", () => {
    const { server, captured } = fakeServer();
    expect(
      registerTraceTools(server as any, {
        principal: { ...principal, scopes: ["workflow:execute"] },
        diagnostics: diagnostics(),
      }),
    ).toEqual([]);
    expect(captured).toEqual([]);
  });

  it("returns structured first-pass evidence and deterministic drilldowns", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics(),
    });
    const tool = captured.find(
      (entry) => entry.name === "debug_workflow_execution",
    );

    const response = await tool?.handler({ executionId: "execution-1" });

    expect(response.structuredContent).toMatchObject({
      ok: true,
      telemetry: { state: "complete", isFinal: true },
      data: { evidenceCoverage: { overview: "available" } },
      nextActions: [
        {
          tool: "trace_get_tree",
          arguments: { executionId: "execution-1" },
        },
        {
          tool: "trace_get_span",
          arguments: { executionId: "execution-1", spanId: "span-1" },
        },
        {
          tool: "trace_get_logs",
          arguments: { executionId: "execution-1", spanId: "span-1" },
        },
      ],
    });
    expect(JSON.parse(response.content[0].text)).toEqual(
      response.structuredContent,
    );
  });

  it("does not promote incidental error spans for a successful run with a clean digest", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        debugWorkflowExecution: vi.fn(async () => ({
          overview: { execution: { status: "success" } },
          digest: { issues: [] },
          errorSpans: {
            spans: [
              {
                spanId: "cleanup-404",
                name: "DELETE",
                attributes: {
                  "http.status_code": "404",
                  "http.target": "/apis/example/sandboxtemplates/pool",
                },
              },
            ],
          },
          errorLogs: { logs: [] },
          evidenceCoverage: {
            overview: "available",
            digest: "available",
            spans: "available",
            logs: "available",
          } as const,
          warnings: [],
          telemetry: {
            state: "complete" as const,
            isFinal: true,
            warnings: [] as string[],
          },
        })),
      }),
    });
    const tool = captured.find(
      (entry) => entry.name === "debug_workflow_execution",
    );

    const response = await tool?.handler({ executionId: "execution-1" });

    expect(response.structuredContent.data.errorSpans.spans).toHaveLength(1);
    // The structural tree suggestion is unconditional; no ERROR drills for a
    // clean successful run.
    expect(
      response.structuredContent.nextActions.map(
        (action: { tool: string }) => action.tool,
      ),
    ).toEqual(["trace_get_tree"]);
  });

  it("still promotes error evidence when a successful run digest reports an issue", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        debugWorkflowExecution: vi.fn(async () => ({
          overview: { execution: { status: "success" } },
          digest: { issues: [{ code: "retry_exhaustion" }] },
          errorSpans: { spans: [{ spanId: "span-with-issue" }] },
          errorLogs: { logs: [] },
          evidenceCoverage: {
            overview: "available",
            digest: "available",
            spans: "available",
            logs: "available",
          } as const,
          warnings: [],
          telemetry: {
            state: "complete" as const,
            isFinal: true,
            warnings: [] as string[],
          },
        })),
      }),
    });
    const tool = captured.find(
      (entry) => entry.name === "debug_workflow_execution",
    );

    const response = await tool?.handler({ executionId: "execution-1" });

    expect(response.structuredContent.nextActions[1]).toMatchObject({
      tool: "trace_get_span",
      arguments: {
        executionId: "execution-1",
        spanId: "span-with-issue",
      },
    });
  });

  it("rejects ambiguous LLM selectors before calling the port", async () => {
    const useCases = diagnostics();
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, { principal, diagnostics: useCases });
    const tool = captured.find((entry) => entry.name === "trace_get_llm_turn");

    const response = await tool?.handler({
      executionId: "execution-1",
      spanId: "span-1",
      sessionId: "session-1",
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent.error).toMatchObject({
      code: "invalid_trace_selector",
      retryable: false,
    });
    expect(useCases.getLlmTurns).not.toHaveBeenCalled();
  });

  it("propagates a downstream degraded telemetry contract", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        searchSpans: vi.fn(async () => ({
          spans: [],
          telemetry: {
            state: "pending",
            isFinal: false,
            warnings: ["Trace ingestion is still catching up"],
            refreshAfterMs: 1_750,
          },
        })),
      }),
    });
    const tool = captured.find((entry) => entry.name === "trace_search_spans");

    const response = await tool?.handler({ executionId: "execution-1" });

    expect(response.structuredContent.telemetry).toEqual({
      state: "pending",
      isFinal: false,
      warnings: ["Trace ingestion is still catching up"],
      refreshAfterMs: 1_750,
    });
  });

  it("uses exact execution and cursor actions without placeholder arguments", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        listWorkflowExecutions: vi.fn(async () => ({
          executions: [{ executionId: "execution-exact" }],
          page: {
            limit: 1,
            count: 1,
            truncated: true,
            nextCursor: "cursor-2",
          },
        })),
      }),
    });
    const tool = captured.find(
      (entry) => entry.name === "list_workflow_executions",
    );

    const response = await tool?.handler({
      workflowName: "Animation workflow",
      status: "error",
      limit: 1,
    });

    expect(response.structuredContent.nextActions).toEqual([
      expect.objectContaining({
        tool: "debug_workflow_execution",
        arguments: { executionId: "execution-exact" },
      }),
      expect.objectContaining({
        tool: "list_workflow_executions",
        arguments: {
          workflowName: "Animation workflow",
          status: "error",
          limit: 1,
          cursor: "cursor-2",
        },
      }),
    ]);
    expect(JSON.stringify(response.structuredContent)).not.toContain(
      "<executionId",
    );
  });

  it("does not guess an execution when a list page contains several runs", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        listWorkflowExecutions: vi.fn(async () => ({
          executions: [{ id: "execution-1" }, { id: "execution-2" }],
          page: { nextCursor: null },
        })),
      }),
    });
    const tool = captured.find(
      (entry) => entry.name === "list_workflow_executions",
    );

    const response = await tool?.handler({});

    expect(response.structuredContent.nextActions).toEqual([]);
  });

  it("continues span searches and only proposes LLM evidence for LLM spans", async () => {
    const generic = diagnostics({
      searchSpans: vi.fn(async () => ({
        spans: [{ spanId: "http-span", name: "HTTP GET", service: "api" }],
        page: { nextCursor: "span-cursor-2" },
      })),
    });
    const firstServer = fakeServer();
    registerTraceTools(firstServer.server as any, {
      principal,
      diagnostics: generic,
    });
    const firstTool = firstServer.captured.find(
      (entry) => entry.name === "trace_search_spans",
    );

    const genericResponse = await firstTool?.handler({
      executionId: "execution-1",
      query: "http",
      errorsOnly: true,
      limit: 10,
    });

    expect(
      genericResponse.structuredContent.nextActions.map(
        (action: { tool: string }) => action.tool,
      ),
    ).toEqual(["trace_get_span", "trace_search_spans"]);
    expect(genericResponse.structuredContent.nextActions[1].arguments).toEqual({
      executionId: "execution-1",
      query: "http",
      errorsOnly: true,
      limit: 10,
      cursor: "span-cursor-2",
    });

    const llmServer = fakeServer();
    registerTraceTools(llmServer.server as any, {
      principal,
      diagnostics: diagnostics({
        searchSpans: vi.fn(async () => ({
          spans: [
            {
              spanId: "llm-span",
              name: "gen_ai.chat.completions",
              service: "agent-runtime",
              sessionId: "session-llm",
            },
          ],
        })),
      }),
    });
    const llmTool = llmServer.captured.find(
      (entry) => entry.name === "trace_search_spans",
    );
    const llmResponse = await llmTool?.handler({ executionId: "execution-1" });
    expect(
      llmResponse.structuredContent.nextActions.map(
        (action: { tool: string }) => action.tool,
      ),
    ).toEqual(["trace_get_span", "trace_get_llm_turn"]);
    expect(llmResponse.structuredContent.nextActions[1].arguments).toEqual({
      executionId: "execution-1",
      spanId: "llm-span",
    });
  });

  it("returns the span tree with a tool-call drilldown suggestion", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        getSpanTree: vi.fn(async () => ({
          nodes: [{ spanId: "root", depth: 0, name: "workflow" }],
          renderedCount: 1,
          truncated: { spans: false, nodes: false, siblings: false },
        })),
      }),
    });
    const tool = captured.find((entry) => entry.name === "trace_get_tree");

    const response = await tool?.handler({
      executionId: "execution-1",
      maxNodes: 100,
    });

    expect(response.structuredContent.ok).toBe(true);
    expect(response.structuredContent.data.nodes).toHaveLength(1);
    expect(
      response.structuredContent.nextActions.map(
        (action: { tool: string }) => action.tool,
      ),
    ).toContain("trace_get_tool_calls");
  });

  it("pages tool calls and correlates a failing call with logs", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        getToolCalls: vi.fn(async () => ({
          toolCalls: [
            { spanId: "tool-span-1", toolName: "run_command", status: "Error" },
          ],
          page: { limit: 20, count: 1, truncated: true, nextCursor: "cur-2" },
        })),
      }),
    });
    const tool = captured.find(
      (entry) => entry.name === "trace_get_tool_calls",
    );

    const response = await tool?.handler({
      executionId: "execution-1",
      errorsOnly: true,
    });

    const actions = response.structuredContent.nextActions as Array<{
      tool: string;
      arguments: Record<string, unknown>;
    }>;
    expect(actions[0]).toMatchObject({
      tool: "trace_get_logs",
      arguments: { executionId: "execution-1", spanId: "tool-span-1" },
    });
    expect(actions[1]).toMatchObject({
      tool: "trace_get_tool_calls",
      arguments: { executionId: "execution-1", cursor: "cur-2" },
    });
  });

  it("falls back to the exact span for LLM search results without a session", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        searchSpans: vi.fn(async () => ({
          spans: [
            {
              spanId: "llm-span",
              name: "claude_code.llm_request",
              service: "dapr-agent-py",
            },
          ],
        })),
      }),
    });
    const tool = captured.find(
      (entry) => entry.name === "trace_search_spans",
    );

    const response = await tool?.handler({ executionId: "execution-1" });

    expect(response.structuredContent.nextActions[1]).toMatchObject({
      tool: "trace_get_llm_turn",
      arguments: { executionId: "execution-1", spanId: "llm-span" },
    });
  });

  it("only proposes LLM drill-down from LLM-related span detail", async () => {
    const genericServer = fakeServer();
    registerTraceTools(genericServer.server as any, {
      principal,
      diagnostics: diagnostics({
        getSpan: vi.fn(async () => ({
          span: {
            spanId: "db-span",
            name: "SELECT workflow_executions",
            service: "postgres",
          },
        })),
      }),
    });
    const genericTool = genericServer.captured.find(
      (entry) => entry.name === "trace_get_span",
    );
    const genericResponse = await genericTool?.handler({
      executionId: "execution-1",
      spanId: "db-span",
    });
    expect(
      genericResponse.structuredContent.nextActions.map(
        (action: { tool: string }) => action.tool,
      ),
    ).toEqual(["trace_get_logs"]);

    const llmServer = fakeServer();
    registerTraceTools(llmServer.server as any, {
      principal,
      diagnostics: diagnostics({
        getSpan: vi.fn(async () => ({
          span: {
            spanId: "model-span",
            name: "agent inference",
            service: "runtime",
            attributes: {
              "gen_ai.request.model": "kimi-k3",
              "session.id": "session-model",
            },
          },
        })),
      }),
    });
    const llmTool = llmServer.captured.find(
      (entry) => entry.name === "trace_get_span",
    );
    const llmResponse = await llmTool?.handler({
      executionId: "execution-1",
      spanId: "model-span",
    });
    expect(
      llmResponse.structuredContent.nextActions.map(
        (action: { tool: string }) => action.tool,
      ),
    ).toEqual(["trace_get_logs", "trace_get_llm_turn"]);
    // spanId is preferred even when the span carries a session.id attribute:
    // daprd/collector-stamped session ids are k8s-label-sanitized (lowercased,
    // truncated) and never match the curated obs.llm_spans SessionId values.
    expect(llmResponse.structuredContent.nextActions[1].arguments).toEqual({
      executionId: "execution-1",
      spanId: "model-span",
    });
  });

  it("falls back to the requested span for LLM detail without a session", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        getSpan: vi.fn(async () => ({
          span: {
            spanId: "model-span",
            name: "agent inference",
            attributes: { "gen_ai.request.model": "kimi-k3" },
          },
        })),
      }),
    });
    const tool = captured.find((entry) => entry.name === "trace_get_span");

    const response = await tool?.handler({
      executionId: "execution-1",
      spanId: "model-span",
    });

    expect(response.structuredContent.nextActions[1]).toMatchObject({
      tool: "trace_get_llm_turn",
      arguments: { executionId: "execution-1", spanId: "model-span" },
    });
  });

  it("proposes only directly authorized screenshot assets", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        debugWorkflowExecution: vi.fn(async () => ({
          overview: {
            execution: { status: "error" },
            browserArtifacts: [
              { assets: [{ kind: "dom", storageRef: "dom.json" }] },
              {
                assets: [
                  { kind: "screenshot", storageRef: "screenshots/later.png" },
                ],
                steps: [
                  { screenshotStorageRef: "screenshots/step.png" },
                  { screenshotStorageRef: "screenshots/later.png" },
                ],
              },
            ],
          },
          digest: {},
          errorSpans: { spans: [] },
          errorLogs: { logs: [] },
          evidenceCoverage: {
            overview: "available",
            digest: "available",
            spans: "available",
            logs: "available",
          } as const,
          warnings: [],
          telemetry: {
            state: "complete" as const,
            isFinal: true,
            warnings: [] as string[],
          },
        })),
      }),
    });
    const tool = captured.find(
      (entry) => entry.name === "debug_workflow_execution",
    );

    const response = await tool?.handler({ executionId: "execution-1" });

    const screenshotActions = response.structuredContent.nextActions.filter(
      (action: { tool: string }) =>
        action.tool === "trace_get_browser_screenshot",
    );
    expect(
      screenshotActions.map(
        (action: { arguments: unknown }) => action.arguments,
      ),
    ).toEqual([
      {
        executionId: "execution-1",
        storageRef: "screenshots/later.png",
      },
    ]);
  });

  it("provides cursor continuations for LLM turns and logs", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        getLlmTurns: vi.fn(async () => ({
          turns: [{ spanId: "llm-span", inputMessages: "sensitive prompt" }],
          page: { nextCursor: "turn-cursor-2" },
        })),
        searchLogs: vi.fn(async () => ({
          logs: [{ body: "sensitive log body" }],
          page: { nextCursor: "log-cursor-2" },
        })),
      }),
    });
    const llmTool = captured.find(
      (entry) => entry.name === "trace_get_llm_turn",
    );
    const logTool = captured.find((entry) => entry.name === "trace_get_logs");

    const llmResponse = await llmTool?.handler({
      executionId: "execution-1",
      sessionId: "session-1",
      limit: 3,
    });
    const logResponse = await logTool?.handler({
      executionId: "execution-1",
      query: "failure",
      limit: 20,
    });

    expect(llmResponse.structuredContent.nextActions.at(-1)).toMatchObject({
      tool: "trace_get_llm_turn",
      arguments: {
        executionId: "execution-1",
        sessionId: "session-1",
        limit: 3,
        cursor: "turn-cursor-2",
      },
    });
    expect(logResponse.structuredContent.nextActions).toEqual([
      expect.objectContaining({
        tool: "trace_get_logs",
        arguments: {
          executionId: "execution-1",
          query: "failure",
          limit: 20,
          cursor: "log-cursor-2",
        },
      }),
    ]);
    expect(JSON.stringify(setSpanOutputMock.mock.calls)).not.toContain(
      "sensitive prompt",
    );
    expect(JSON.stringify(setSpanOutputMock.mock.calls)).not.toContain(
      "sensitive log body",
    );
  });

  it("does not trace diagnostic error messages", async () => {
    const { server, captured } = fakeServer();
    registerTraceTools(server as any, {
      principal,
      diagnostics: diagnostics({
        getDigest: vi.fn(async () => {
          throw Object.assign(new Error("Bearer secret-token-value"), {
            status: 503,
            code: "upstream_unavailable",
          });
        }),
      }),
    });
    const tool = captured.find((entry) => entry.name === "trace_get_digest");

    const response = await tool?.handler({ executionId: "execution-1" });

    expect(response.structuredContent.error.message).toBe(
      "Bearer secret-token-value",
    );
    expect(JSON.stringify(setSpanOutputMock.mock.calls)).not.toContain(
      "secret-token-value",
    );
  });
});
