import { describe, expect, it } from "vitest";
import {
  stampScriptGuardHeader,
  stampWorkflowMcpSessionAuth,
} from "./mcp-wiring";

describe("Workflow MCP header wiring", () => {
  it("stamps the script-depth guard on Workflow MCP entries only", () => {
    const workflowMcp = {
      name: "wfb_script",
      transport: "streamable_http",
      url: "http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp",
    };
    const thirdParty = {
      name: "other",
      transport: "streamable_http",
      url: "https://untrusted.example.test/mcp",
    };
    const stamped = stampScriptGuardHeader([thirdParty, workflowMcp]);
    // third-party server is untouched (no session/depth leakage)
    expect(stamped[0]).toEqual(thirdParty);
    // the Workflow MCP entry carries the recursion-guard header
    expect(stamped[1]).toMatchObject({
      headers: { "X-Wfb-Script-Depth": "1" },
    });
  });

  it("no longer auto-wires any goal MCP server", async () => {
    // The goal MCP surface (ensureGoalMcpServer / GOAL_MCP_SERVER_URL /
    // stampGoalMcpSessionHeader) was removed — goals are authored in code.
    const mod = await import("./mcp-wiring");
    expect("ensureGoalMcpServer" in mod).toBe(false);
    expect("GOAL_MCP_SERVER_URL" in mod).toBe(false);
    expect("stampGoalMcpSessionHeader" in mod).toBe(false);
  });

  it("stamps signed session auth only onto the exact Workflow MCP URL", () => {
    const trusted = {
      name: "trace",
      url: "http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp/",
      headers: {
        "x-wfb-session-id": "caller-session",
        "X-WFB-SESSION-TOKEN": "caller-token",
        "X-Existing": "kept",
      },
    };
    const lookalike = {
      name: "workflow-mcp-server",
      url: "https://workflow-mcp-server.example.test/mcp",
    };

    const stamped = stampWorkflowMcpSessionAuth(
      [lookalike, trusted],
      "server-session",
      "signed-session-token",
    );

    expect(stamped[0]).toEqual(lookalike);
    expect(stamped[1]).toMatchObject({
      headers: {
        "X-Existing": "kept",
        "X-Wfb-Session-Id": "server-session",
        "X-Wfb-Session-Token": "signed-session-token",
      },
    });
    const trustedHeaders = (
      stamped[1] as unknown as { headers: Record<string, unknown> }
    ).headers;
    expect(trustedHeaders).not.toHaveProperty("x-wfb-session-id");
    expect(trustedHeaders).not.toHaveProperty("X-WFB-SESSION-TOKEN");
  });
});
