import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  getWorkflowByRef: vi.fn(),
  createInteractiveSession: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    agentCatalog: {
      listAgents: mocks.listAgents,
      createAgent: mocks.createAgent,
    },
    workflowData: {
      getWorkflowByRef: mocks.getWorkflowByRef,
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

describe("workflow author session route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgents.mockResolvedValue([]);
    mocks.getWorkflowByRef.mockResolvedValue({
      id: "workflow-1",
      name: "Demo workflow",
      engineType: "dynamic-script",
      spec: { script: "" },
    });
    mocks.createAgent.mockResolvedValue({
      status: "created",
      agent: { id: "author-agent-1" },
    });
    mocks.createInteractiveSession.mockResolvedValue({
      status: "created",
      session: { id: "author-session-1" },
    });
  });

  it("uses Kimi K3 with max reasoning and one-million-token context for the agent and session", async () => {
    const response = await POST({
      params: { workflowId: "workflow-1" },
      request: new Request(
        "http://localhost/api/workflows/workflow-1/author-session",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ),
      locals: {
        session: { userId: "user-1", projectId: "project-1" },
      },
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      sessionId: "author-session-1",
      agentId: "author-agent-1",
      runtime: "dapr-agent-py",
    });
    expect(mocks.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          name: "Workflow Author (Kimi K3)",
          config: expect.objectContaining(kimiConfig),
        }),
      }),
    );
    expect(mocks.createInteractiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          agentId: "author-agent-1",
          agentConfig: expect.objectContaining(kimiConfig),
        }),
      }),
    );
  });
});
