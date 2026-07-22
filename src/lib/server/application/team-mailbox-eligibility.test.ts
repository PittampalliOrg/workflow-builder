import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegistryTeamMailboxRuntimeEligibilityAdapter } from "$lib/server/application/adapters/team-mailbox-runtime-eligibility";
import { ApplicationTeamMailboxEligibilityService } from "$lib/server/application/team-mailbox-eligibility";
import type {
  SessionAgentResolver,
  SessionRepository,
} from "$lib/server/application/ports";

describe("team mailbox runtime eligibility", () => {
  let sessions: Pick<SessionRepository, "getSession">;
  let agents: Pick<SessionAgentResolver, "resolveSessionAgent">;
  let service: ApplicationTeamMailboxEligibilityService;

  beforeEach(() => {
    sessions = {
      getSession: vi.fn(async () => null),
    };
    agents = {
      resolveSessionAgent: vi.fn(async () => null),
    };
    service = new ApplicationTeamMailboxEligibilityService(
      new RegistryTeamMailboxRuntimeEligibilityAdapter({ sessions, agents }),
    );
  });

  it("accepts a runtime only when the registry declares mailbox receipts", async () => {
    vi.mocked(agents.resolveSessionAgent).mockResolvedValueOnce(
      resolvedAgent("pydantic-ai-agent-py", 7, "pydantic-ai-agent-py"),
    );

    await expect(
      service.checkAgent({ agentId: "agent-1", agentVersion: 7 }),
    ).resolves.toEqual({
      status: "ok",
      runtimeId: "pydantic-ai-agent-py",
      agentVersion: 7,
    });
    expect(agents.resolveSessionAgent).toHaveBeenCalledWith({
      agentId: "agent-1",
      agentVersion: 7,
    });
  });

  it("fails closed for an unsupported or unknown runtime", async () => {
    vi.mocked(agents.resolveSessionAgent)
      .mockResolvedValueOnce(
        resolvedAgent("claude-agent-py", 1, "claude-agent-py"),
      )
      .mockResolvedValueOnce(
        resolvedAgent("future-runtime", 1, "future-runtime"),
      );

    await expect(service.checkAgent({ agentId: "agent-1" })).resolves.toEqual({
      status: "error",
      httpStatus: 400,
      message:
        "agent runtime 'claude-agent-py' does not support durable team mailbox receipts",
    });
    await expect(service.checkAgent({ agentId: "agent-2" })).resolves.toEqual(
      expect.objectContaining({ status: "error", httpStatus: 400 }),
    );
  });

  it("checks a lead session against the runtime in its pinned agent version", async () => {
    vi.mocked(sessions.getSession).mockResolvedValueOnce({
      agentId: "lead-agent",
      agentVersion: 12,
    } as never);
    vi.mocked(agents.resolveSessionAgent).mockResolvedValueOnce(
      resolvedAgent("claude-agent-py", 12, "dapr-agent-py"),
    );

    await expect(
      service.checkSession({ sessionId: "lead-session" }),
    ).resolves.toEqual({
      status: "ok",
      runtimeId: "dapr-agent-py",
      agentVersion: 12,
    });
    expect(agents.resolveSessionAgent).toHaveBeenCalledWith({
      agentId: "lead-agent",
      agentVersion: 12,
    });
  });

  it("rejects an unsupported historical runtime even when the agent row is now supported", async () => {
    vi.mocked(agents.resolveSessionAgent).mockResolvedValueOnce(
      resolvedAgent("dapr-agent-py", 7, "claude-agent-py"),
    );

    await expect(
      service.checkAgent({ agentId: "agent-1", agentVersion: 7 }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 400,
      message:
        "agent runtime 'claude-agent-py' does not support durable team mailbox receipts",
    });
  });

  it("falls back to the agent row runtime for legacy versions without config.runtime", async () => {
    vi.mocked(agents.resolveSessionAgent).mockResolvedValueOnce(
      resolvedAgent("dapr-agent-py", 3),
    );

    await expect(
      service.checkAgent({ agentId: "agent-1", agentVersion: 3 }),
    ).resolves.toEqual({
      status: "ok",
      runtimeId: "dapr-agent-py",
      agentVersion: 3,
    });
  });

  it("fails closed instead of falling back for a present but invalid version runtime", async () => {
    vi.mocked(agents.resolveSessionAgent).mockResolvedValueOnce(
      resolvedAgent("dapr-agent-py", 3, ""),
    );

    await expect(
      service.checkAgent({ agentId: "agent-1", agentVersion: 3 }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 400,
      message:
        "agent runtime 'unknown' does not support durable team mailbox receipts",
    });
  });

  it("returns a closed 503 result when registry resolution is unavailable", async () => {
    vi.mocked(agents.resolveSessionAgent).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(service.checkAgent({ agentId: "agent-1" })).resolves.toEqual({
      status: "error",
      httpStatus: 503,
      message: "team mailbox runtime eligibility could not be verified",
    });
  });

  it("rejects a resolver response that does not match the requested version", async () => {
    vi.mocked(agents.resolveSessionAgent).mockResolvedValueOnce(
      resolvedAgent("dapr-agent-py", 8),
    );

    await expect(
      service.checkAgent({ agentId: "agent-1", agentVersion: 7 }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message:
        "agent 'agent-1' changed version while team eligibility was being checked",
    });
  });
});

function resolvedAgent(
  runtime: string,
  version = 1,
  resolvedVersionRuntime?: string,
) {
  return {
    id: "agent-1",
    name: "Agent",
    slug: "agent",
    version,
    config:
      resolvedVersionRuntime === undefined
        ? {}
        : { runtime: resolvedVersionRuntime },
    runtime,
    runtimeAppId: null,
    mlflowModelVersion: null,
    mlflowModelName: null,
    mlflowUri: null,
  } as never;
}
