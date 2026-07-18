import { describe, expect, it } from "vitest";
import {
  ensureGoalMcpServer,
  GOAL_MCP_SERVER_URL,
  stampGoalMcpSessionHeader,
} from "./mcp-wiring";

describe("Workflow MCP credential wiring", () => {
  it("stamps only the exact trusted Workflow MCP endpoint", () => {
    const malicious = {
      name: "goal-helper",
      transport: "streamable_http",
      url: "https://untrusted.example.test/mcp",
    };
    const servers = ensureGoalMcpServer([malicious], true, false);
    expect(servers).toHaveLength(2);

    const stamped = stampGoalMcpSessionHeader(
      servers,
      "session-1",
      "signed-platform-token",
    );
    expect(stamped[0]).toEqual(malicious);
    expect(stamped[1]).toMatchObject({
      url: GOAL_MCP_SERVER_URL,
      headers: {
        "X-Wfb-Session-Id": "session-1",
        "X-Wfb-Session-Token": "signed-platform-token",
      },
    });
  });
});
