import { describe, expect, it } from "vitest";
import {
  diagnosticEnvelopeTraceMetadata,
  diagnosticMcpRequestTrace,
  diagnosticMcpResponseTrace,
} from "./content.js";

describe("diagnostic observability content", () => {
  it("records diagnostic request shape without selector or query values", () => {
    const metadata = diagnosticMcpRequestTrace({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "trace_get_logs",
        arguments: {
          executionId: "private-execution-id",
          spanId: "private-span-id",
          query: "Authorization: Bearer secret-value",
          cursor: "private-cursor",
          errorsOnly: true,
          limit: 25,
        },
      },
    });

    expect(metadata).toEqual({
      kind: "workflow_diagnostic_mcp_request",
      tool: "trace_get_logs",
      argumentNames: [
        "cursor",
        "errorsOnly",
        "executionId",
        "limit",
        "query",
        "spanId",
      ],
      pagination: { hasCursor: true, limit: 25 },
    });
    expect(JSON.stringify(metadata)).not.toContain("secret-value");
    expect(JSON.stringify(metadata)).not.toContain("private-execution-id");
    expect(JSON.stringify(metadata)).not.toContain("private-span-id");
    expect(JSON.stringify(metadata)).not.toContain("private-cursor");
  });

  it("does not classify unrelated MCP tools as diagnostic calls", () => {
    expect(
      diagnosticMcpRequestTrace({
        method: "tools/call",
        params: {
          name: "save_workflow",
          arguments: { workflow: "sensitive workflow body" },
        },
      }),
    ).toBeNull();
  });

  it("summarizes envelopes without warnings, evidence, identifiers, or images", () => {
    const metadata = diagnosticEnvelopeTraceMetadata(
      {
        ok: true,
        telemetry: {
          state: "partial",
          isFinal: false,
          warnings: ["Bearer secret-warning"],
          refreshAfterMs: 2_000,
        },
        data: {
          turns: [
            {
              spanId: "private-span",
              inputMessages: "private prompt",
              outputMessages: "private response",
            },
          ],
          page: {
            limit: 10,
            count: 1,
            truncated: true,
            nextCursor: "private-cursor",
          },
          storageRef: "screenshots/private.png",
          contentType: "image/png",
          sizeBytes: 1_234,
          payloadBase64: "cHJpdmF0ZS1waXhlbHM=",
        },
        nextActions: [
          {
            tool: "trace_get_logs",
            arguments: { spanId: "private-span" },
            reason: "private reason",
          },
        ],
      },
      "trace_get_llm_turn",
    );

    expect(metadata).toMatchObject({
      kind: "workflow_diagnostic_mcp_response",
      tool: "trace_get_llm_turn",
      ok: true,
      telemetry: {
        state: "partial",
        isFinal: false,
        warningCount: 1,
        refreshAfterMs: 2_000,
      },
      data: {
        counts: { turns: 1 },
        page: {
          limit: 10,
          count: 1,
          truncated: true,
          hasNextCursor: true,
        },
        screenshot: { contentType: "image/png", sizeBytes: 1_234 },
      },
      nextActionTools: ["trace_get_logs"],
    });
    const serialized = JSON.stringify(metadata);
    for (const sensitive of [
      "secret-warning",
      "private-span",
      "private prompt",
      "private response",
      "private-cursor",
      "screenshots/private.png",
      "cHJpdmF0ZS1waXhlbHM=",
      "private reason",
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it("sanitizes complete JSON and truncated diagnostic responses", () => {
    const envelope = {
      ok: true,
      telemetry: {
        state: "complete",
        isFinal: true,
        warnings: [],
      },
      data: { logs: [{ body: "private log evidence" }] },
      nextActions: [],
    };
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [
          { type: "text", text: JSON.stringify(envelope) },
          { type: "image", data: "c2NyZWVuc2hvdC1ieXRlcw==" },
        ],
        structuredContent: envelope,
      },
    });

    const complete = diagnosticMcpResponseTrace(
      raw,
      "trace_get_browser_screenshot",
    );
    const truncated = diagnosticMcpResponseTrace(
      raw.slice(0, raw.indexOf("c2NyZWVuc2hvdC1ieXRlcw==") + 8),
      "trace_get_browser_screenshot",
    );

    expect(complete).toMatchObject({
      kind: "workflow_diagnostic_mcp_response",
      tool: "trace_get_browser_screenshot",
      ok: true,
      data: { counts: { logs: 1 } },
    });
    expect(truncated).toEqual({
      kind: "workflow_diagnostic_mcp_response",
      tool: "trace_get_browser_screenshot",
      parsedEnvelope: false,
    });
    expect(JSON.stringify(complete)).not.toContain("private log evidence");
    expect(JSON.stringify(complete)).not.toContain("c2NyZWVuc2hvdC1ieXRlcw==");
    expect(JSON.stringify(truncated)).not.toContain("c2NyZWVuc2hvdC1ieXRlcw==");
  });

  it("extracts metadata from an SSE diagnostic response", () => {
    const raw = [
      "event: message",
      `data: ${JSON.stringify({
        result: {
          structuredContent: {
            ok: false,
            telemetry: {
              state: "unavailable",
              isFinal: false,
              warnings: ["private upstream failure"],
            },
            error: {
              code: "diagnostics_unavailable",
              message: "private upstream failure",
              retryable: true,
            },
            nextActions: [],
          },
        },
      })}`,
      "",
    ].join("\n");

    const metadata = diagnosticMcpResponseTrace(raw, "trace_get_digest");

    expect(metadata).toMatchObject({
      tool: "trace_get_digest",
      ok: false,
      telemetry: { state: "unavailable", warningCount: 1 },
      error: { code: "diagnostics_unavailable", retryable: true },
    });
    expect(JSON.stringify(metadata)).not.toContain("private upstream failure");
  });
});
