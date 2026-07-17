import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  getObservabilityServiceGraphContext: vi.fn(),
  createInteractiveSession: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    agentCatalog: {
      listAgents: mocks.listAgents,
      createAgent: mocks.createAgent,
    },
    workflowData: {
      getObservabilityServiceGraphContext:
        mocks.getObservabilityServiceGraphContext,
    },
    sessionCommands: {
      createInteractiveSession: mocks.createInteractiveSession,
    },
  }),
}));

import { POST } from "./+server";

const kimiConfig = {
  model: "kimi/kimi-k3",
  modelSpec: "kimi/kimi-k3",
  reasoningEffort: "max",
  contextWindowTokens: 1_048_576,
  runtime: "dapr-agent-py",
};

describe("workflow execution analyst session route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgents.mockResolvedValue([]);
    mocks.getObservabilityServiceGraphContext.mockResolvedValue({
      execution: { id: "execution-12345678" },
    });
    mocks.createAgent.mockResolvedValue({
      status: "created",
      agent: { id: "analyst-agent-1" },
    });
    mocks.createInteractiveSession.mockResolvedValue({
      status: "created",
      session: { id: "analyst-session-1" },
    });
  });

  it("uses Kimi K3 with max reasoning and one-million-token context for the agent and session", async () => {
    const response = await POST({
      params: { executionId: "execution-12345678" },
      locals: {
        session: { userId: "user-1", projectId: "project-1" },
      },
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      sessionId: "analyst-session-1",
      agentId: "analyst-agent-1",
    });
    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          name: "Trace Analyst (Kimi K3)",
          config: expect.objectContaining(kimiConfig),
        }),
      }),
    );
    expect(mocks.createInteractiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          agentId: "analyst-agent-1",
          agentConfig: expect.objectContaining(kimiConfig),
        }),
      }),
    );
  });
});
