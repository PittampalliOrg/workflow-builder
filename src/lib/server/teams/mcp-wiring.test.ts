import { describe, expect, it } from "vitest";
import { ensureTeamMcpServer, stampTeamMcpHeaders } from "./mcp-wiring";

describe("team MCP server wiring", () => {
  it("injects the Workflow MCP entry for teammates (the team tools live there)", () => {
    const servers = ensureTeamMcpServer([] as Array<Record<string, unknown>>, { isTeammate: true });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: "wfb_team",
      transport: "streamable_http",
    });
    expect(String(servers[0].url)).toContain("workflow-mcp-server");
  });

  it("injects for opted-in leads (teamsEnabled) too", () => {
    expect(
      ensureTeamMcpServer([] as Array<Record<string, unknown>>, { isTeammate: false, teamsEnabled: true }),
    ).toHaveLength(1);
  });

  it("does NOT inject for non-team sessions", () => {
    expect(
      ensureTeamMcpServer([] as Array<Record<string, unknown>>, { isTeammate: false, teamsEnabled: false }),
    ).toEqual([]);
  });

  it("does NOT inject for CLI runtimes (they configure MCP via their adapter)", () => {
    expect(
      ensureTeamMcpServer([] as Array<Record<string, unknown>>, { isTeammate: true, isCliRuntime: true }),
    ).toEqual([]);
  });

  it("does not duplicate an already-present Workflow MCP entry", () => {
    const existing = [
      {
        name: "wfb_script",
        transport: "streamable_http",
        url: "http://workflow-mcp-server.workflow-builder.svc.cluster.local:3200/mcp",
      },
    ];
    expect(ensureTeamMcpServer(existing, { isTeammate: true })).toHaveLength(1);
  });

  it("inject → stamp gives teammates the team headers on the injected entry", () => {
    const injected = ensureTeamMcpServer([] as Array<Record<string, unknown>>, { isTeammate: true });
    const stamped = stampTeamMcpHeaders(injected, {
      teamId: "team-abc",
      isTeammate: true,
    });
    const headers = stamped[0].headers as Record<string, string>;
    expect(headers["X-Wfb-Team-Id"]).toBe("team-abc");
    expect(headers["X-Wfb-Team-Depth"]).toBe("1"); // teammate nesting guard
  });
});
