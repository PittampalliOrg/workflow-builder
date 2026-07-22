import { describe, expect, it, vi } from "vitest";
import { HttpWorkspaceRetentionAdapter } from "./workspace-retention-http";

const input = {
  identity: {
    durableExecutionId: "durable-1",
    databaseExecutionId: "database-1",
  },
  terminalAt: new Date("2026-07-21T18:30:00.000Z"),
};

describe("HttpWorkspaceRetentionAdapter", () => {
  it("sends typed durable and database identity to the configured provider", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          terminalAt: "2026-07-21T18:30:00Z",
          results: [{ status: "armed" }],
        }),
        { status: 200 },
      ),
    );
    const adapter = new HttpWorkspaceRetentionAdapter({
      baseUrl: "http://retention-provider/",
      fetcher,
    });

    await expect(adapter.armTerminalRetention(input)).resolves.toEqual({
      terminalAt: "2026-07-21T18:30:00Z",
      resultCount: 1,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://retention-provider/api/workspaces/retain",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          executionId: "durable-1",
          dbExecutionId: "database-1",
          terminalAt: "2026-07-21T18:30:00.000Z",
        }),
      }),
    );
  });

  it("rejects an HTTP 200 semantic failure", async () => {
    const adapter = new HttpWorkspaceRetentionAdapter({
      baseUrl: "http://retention-provider",
      fetcher: async () =>
        new Response(
          JSON.stringify({ success: false, error: "compare-and-set rejected" }),
          { status: 200 },
        ),
    });

    await expect(adapter.armTerminalRetention(input)).rejects.toThrow(
      "compare-and-set rejected",
    );
  });

  it("rejects a successful HTTP response without semantic acknowledgement", async () => {
    const adapter = new HttpWorkspaceRetentionAdapter({
      baseUrl: "http://retention-provider",
      fetcher: async () => new Response(JSON.stringify({}), { status: 200 }),
    });

    await expect(adapter.armTerminalRetention(input)).rejects.toThrow(
      "no positive acknowledgement",
    );
  });
});
