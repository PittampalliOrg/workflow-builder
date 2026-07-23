import { describe, expect, it, vi } from "vitest";
import type { WorkflowMcpPrincipal } from "./auth-context.js";
import type { WorkflowPersistencePort } from "./ports/workflow-persistence.js";
import {
  normalizeAgentMcpServer,
  registerWorkflowTools,
} from "./workflow-tools.js";

const principal: WorkflowMcpPrincipal = {
  authMode: "workspace_api_key",
  userId: "user-1",
  projectId: "project-1",
  scopes: [
    "workflow:read",
    "workflow:write",
    "workflow:execute",
    "agent:write",
  ],
  principalAssertion: "signed-principal-assertion",
  capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
};

function fakeServer() {
  const captured: Array<{
    name: string;
    config: { inputSchema?: Record<string, unknown> };
    handler: (args?: unknown) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>;
  }> = [];
  const server = {
    registerTool(
      name: string,
      config: { inputSchema?: Record<string, unknown> },
      handler: never,
    ) {
      captured.push({ name, config, handler });
    },
  };
  return { server, captured };
}

function fakePersistence(
  overrides: Partial<WorkflowPersistencePort> = {},
): WorkflowPersistencePort {
  return {
    listWorkflows: vi.fn(async () => []),
    findWorkflow: vi.fn(async () => null),
    listAvailableActions: vi.fn(async () => []),
    findExecution: vi.fn(async () => null),
    listExecutionLogs: vi.fn(async () => []),
    ...overrides,
  };
}

describe("workflow tools registration", () => {
	it("normalizes MCP names and drops caller-controlled auth configuration", () => {
		expect(
			normalizeAgentMcpServer({
				name: "browser-tools",
				transport: "streamable_http",
				url: "http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp",
				target_auth_host: "Workflow-Builder.Workflow-Builder.svc.cluster.local",
				headers: { Authorization: "Bearer must-not-persist" },
			}),
		).toEqual({
			name: "browser_tools",
			transport: "streamable_http",
			url: "http://agent-browser-mcp.workflow-builder.svc.cluster.local:8000/mcp",
		});
	});

	it("exposes only current workflow operational tools", () => {
		const { server, captured } = fakeServer();
    const tools = registerWorkflowTools(server as any, {
      persistence: fakePersistence(),
      principal,
    });
		const names = tools.map((tool) => tool.name);

		expect(captured.map((tool) => tool.name)).toEqual(names);
		expect(names).toEqual([
			"list_workflows",
			"get_workflow",
			"list_available_actions",
			"create_agent",
			"execute_workflow",
			"get_execution_status",
			"get_execution_results",
		]);
		expect(names).toContain("create_agent");
		expect(names).not.toContain("create_workflow");
		expect(names).not.toContain("add_node");
		expect(names).not.toContain("approve_workflow");
		expect(names).not.toContain("get_workflow_observability");
	});

  it("documents Kimi K3 low, high, and max effort on create_agent", () => {
    const { server, captured } = fakeServer();
    registerWorkflowTools(server as any, {
      persistence: fakePersistence(),
      principal,
    });

    const createAgent = captured.find((tool) => tool.name === "create_agent");
    const effortSchema = createAgent?.config.inputSchema?.reasoning_effort as
      | {
          description?: string;
          safeParse(value: unknown): { success: boolean };
        }
      | undefined;

    expect(effortSchema?.description).toContain(
      "Kimi K3 accepts 'low', 'high', and 'max'",
    );
    expect(effortSchema?.description).toContain(
      "unset or unsupported K3 values use the deployed 'max' default",
    );
    for (const effort of ["low", "high", "max"]) {
      expect(effortSchema?.safeParse(effort).success).toBe(true);
    }
  });

  it("registers only tools granted by the connection scopes", () => {
    const { server, captured } = fakeServer();
    registerWorkflowTools(server as any, {
      persistence: fakePersistence(),
      principal: { ...principal, scopes: ["workflow:read"] },
    });

    expect(captured.map((tool) => tool.name)).toEqual([
      "list_workflows",
      "get_workflow",
      "list_available_actions",
      "get_execution_status",
      "get_execution_results",
    ]);
  });

  it("registers no workflow data tools without a principal", () => {
    const { server, captured } = fakeServer();
    registerWorkflowTools(server as any, { persistence: fakePersistence() });
    expect(captured).toEqual([]);
  });

  it("suppresses saved workflow execution for script-spawned sessions", () => {
    const { server, captured } = fakeServer();
    registerWorkflowTools(server as any, {
      persistence: fakePersistence(),
      principal: {
        ...principal,
        capabilities: {
          ...principal.capabilities,
          scriptDepth: 1,
        },
      },
    });

    expect(captured.map((tool) => tool.name)).not.toContain("execute_workflow");
  });

  it("queries workflows through the port with the authenticated project", async () => {
    const listWorkflows = vi.fn(async () => [
      {
        id: "wf-1",
        name: "Demo",
        description: null,
        visibility: "private",
        engineType: "dynamic-script",
        specVersion: "1.0",
        created_at: "2026-07-18T00:00:00.000Z",
        updated_at: "2026-07-18T00:00:00.000Z",
        node_count: 0,
        edge_count: 0,
      },
    ]);
    const { server, captured } = fakeServer();
    registerWorkflowTools(server as any, {
      persistence: fakePersistence({ listWorkflows }),
      principal,
    });

    const tool = captured.find(
      (candidate) => candidate.name === "list_workflows",
    );
    const result = await tool?.handler({ limit: 7, summary: false });

    expect(listWorkflows).toHaveBeenCalledWith("project-1", 7);
    expect(JSON.parse(result?.content[0].text ?? "null")).toEqual([
      expect.objectContaining({ id: "wf-1", name: "Demo" }),
    ]);
  });
});
