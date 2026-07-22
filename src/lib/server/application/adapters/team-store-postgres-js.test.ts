import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import { PostgresTeamStore } from "./team-store";
import type { TeamMemberPeerDispatchRecipe } from "$lib/server/application/ports";

describe("PostgresTeamStore postgres-js timestamp parameters", () => {
  it("preserves a raw child generation timestamp in the cleanup fence", async () => {
    const timestamp = "2026-07-22 01:02:03.456";
    const recipe: TeamMemberPeerDispatchRecipe = {
      version: 1,
      teamId: "team-1",
      principal: {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "lead-1",
        capabilities: {
          scriptDepth: 0,
          teamId: "team-1",
          teamRole: "lead",
        },
      },
      request: {
        sessionId: "child-1",
        peerAgentId: "worker-agent",
        peerAgentVersion: 1,
        prompt: "Do the work",
        parentSessionId: "lead-1",
        title: null,
        skipSpawn: false,
        provisionSandbox: true,
        sandboxTemplate: null,
      },
    };
    const results: unknown[][] = [
      [
        {
          team_id: "team-1",
          workflow_execution_id: "workflow-1",
          lead_session_id: "lead-1",
          project_id: "project-1",
        },
      ],
      [
        {
          id: "child-1",
          parent_execution_id: "lead-1",
          workflow_execution_id: "workflow-1",
          status: "rescheduling",
          stop_requested_at: null,
          completed_at: null,
          dapr_instance_id: "child-instance",
          runtime_app_id: "child-runtime",
          runtime_provisioning_started_at: timestamp,
          agent_id: "worker-agent",
          agent_version: 1,
          user_id: "user-1",
          project_id: "project-1",
        },
      ],
      [{ launch_cleanup_action: null, launch_dispatch_recipe: recipe }],
      [{ id: "child-1" }],
      [{ launch_cleanup_action: "purge" }],
    ];
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const postgresClient = {
      options: { parsers: {}, serializers: {} },
      unsafe: (query: string, params: unknown[]) => {
        calls.push({ sql: query, params: [...params] });
        return results.shift() ?? [];
      },
      begin: async <T>(run: (client: unknown) => Promise<T>) =>
        run(postgresClient),
    };
    const database = drizzlePostgresJs(postgresClient as never);
    const store = new PostgresTeamStore(() => database as never);

    await expect(
      store.requestMemberLaunchCleanup({
        memberId: "member-1",
        sessionId: "child-1",
        operationId: "operation-1",
      }),
    ).resolves.toEqual({ action: "purge" });

    const childFence = calls.find(
      (call) =>
        call.sql.includes("WITH stop_intent") &&
        call.sql.includes("UPDATE sessions"),
    );
    expect(childFence).toBeDefined();
    expect(childFence?.params).toContain(timestamp);
    expect(calls.flatMap((call) => call.params)).not.toContainEqual(
      expect.any(Date),
    );
  });
});
