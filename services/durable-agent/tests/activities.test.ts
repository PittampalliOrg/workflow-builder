/**
 * Tests for activity factory functions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRunTool,
  createSaveToolResults,
  createFinalizeWorkflow,
  createRecordInitialEntry,
} from "../src/workflow/activities.js";
import type { DurableAgentTool } from "../src/types/tool.js";
import type { AgentWorkflowState } from "../src/types/state.js";

// Mock WorkflowActivityContext
const mockCtx = {} as any;

// Mock DaprAgentState
function createMockStateManager(initialState?: AgentWorkflowState) {
  const state: AgentWorkflowState = initialState ?? { instances: {} };
  return {
    loadState: vi.fn().mockResolvedValue(state),
    saveState: vi.fn().mockResolvedValue(undefined),
    ensureInstance: vi.fn().mockImplementation(async (id: string, input: string) => {
      if (!state.instances[id]) {
        state.instances[id] = {
          input_value: input,
          output: null,
          start_time: new Date().toISOString(),
          end_time: null,
          messages: [],
          system_messages: [],
          last_message: null,
          tool_history: [],
          source: null,
          workflow_instance_id: id,
          triggering_workflow_instance_id: null,
          workflow_name: "agentWorkflow",
          session_id: null,
          trace_context: null,
          status: "running",
        };
      }
      return state;
    }),
  } as any;
}

describe("createRunTool", () => {
  it("should execute a tool and return result", async () => {
    const tools: Record<string, DurableAgentTool> = {
      "get-weather": {
        description: "Get weather",
        inputSchema: { type: "object" },
        execute: async (args: Record<string, unknown>) => ({
          temperature: 72,
          location: args.location,
        }),
      },
    };

    const runTool = createRunTool(tools);
    const result = await runTool(mockCtx, {
      toolCall: {
        id: "tc-1",
        type: "function",
        function: {
          name: "get-weather",
          arguments: '{"location":"NYC"}',
        },
      },
      instanceId: "wf-1",
      order: 0,
    });

    expect(result.role).toBe("tool");
    expect(result.tool_call_id).toBe("tc-1");
    expect(result.name).toBe("get-weather");
    const parsed = JSON.parse(result.content);
    expect(parsed.temperature).toBe(72);
    expect(parsed.location).toBe("NYC");
  });

  it("should handle unknown tool gracefully", async () => {
    const runTool = createRunTool({});
    const result = await runTool(mockCtx, {
      toolCall: {
        id: "tc-1",
        type: "function",
        function: {
          name: "unknown-tool",
          arguments: "{}",
        },
      },
      instanceId: "wf-1",
      order: 0,
    });

    expect(result.role).toBe("tool");
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("Unknown tool");
  });

  it("should catch tool execution errors", async () => {
    const tools: Record<string, DurableAgentTool> = {
      "failing-tool": {
        description: "A tool that fails",
        inputSchema: { type: "object" },
        execute: async () => {
          throw new Error("Tool execution failed");
        },
      },
    };

    const runTool = createRunTool(tools);
    const result = await runTool(mockCtx, {
      toolCall: {
        id: "tc-1",
        type: "function",
        function: {
          name: "failing-tool",
          arguments: "{}",
        },
      },
      instanceId: "wf-1",
      order: 0,
    });

    expect(result.role).toBe("tool");
    const parsed = JSON.parse(result.content);
    expect(parsed.error).toContain("Tool execution failed");
  });
});

describe("createSaveToolResults", () => {
  it("should save tool results to state", async () => {
    const state: AgentWorkflowState = {
      instances: {
        "wf-1": {
          input_value: "test",
          output: null,
          start_time: "2024-01-01T00:00:00Z",
          end_time: null,
          messages: [],
          system_messages: [],
          last_message: null,
          tool_history: [],
          source: "direct",
          workflow_instance_id: "wf-1",
          triggering_workflow_instance_id: null,
          workflow_name: "agentWorkflow",
          session_id: null,
          trace_context: null,
          status: "running",
        },
      },
    };

    const stateManager = createMockStateManager(state);
    const mockMemory = {
      addMessage: vi.fn(),
      getMessages: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
    };

    const saveToolResults = createSaveToolResults(
      stateManager,
      mockMemory,
    );

    await saveToolResults(mockCtx, {
      toolResults: [
        {
          role: "tool",
          content: '{"temperature":72}',
          tool_call_id: "tc-1",
          name: "get-weather",
        },
      ],
      instanceId: "wf-1",
    });

    expect(stateManager.saveState).toHaveBeenCalledTimes(1);
    expect(state.instances["wf-1"].messages).toHaveLength(1);
    expect(state.instances["wf-1"].messages[0].role).toBe("tool");
    expect(state.instances["wf-1"].tool_history).toHaveLength(1);
    expect(mockMemory.addMessage).toHaveBeenCalledTimes(1);
  });

  it("should deduplicate by tool_call_id", async () => {
    const state: AgentWorkflowState = {
      instances: {
        "wf-1": {
          input_value: "test",
          output: null,
          start_time: "2024-01-01T00:00:00Z",
          end_time: null,
          messages: [
            {
              id: "existing",
              role: "tool",
              content: '{"temperature":72}',
              tool_call_id: "tc-1",
              name: "get-weather",
              timestamp: "2024-01-01T00:00:00Z",
            },
          ],
          system_messages: [],
          last_message: null,
          tool_history: [],
          source: "direct",
          workflow_instance_id: "wf-1",
          triggering_workflow_instance_id: null,
          workflow_name: "agentWorkflow",
          session_id: null,
          trace_context: null,
          status: "running",
        },
      },
    };

    const stateManager = createMockStateManager(state);
    const mockMemory = {
      addMessage: vi.fn(),
      getMessages: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
    };

    const saveToolResults = createSaveToolResults(
      stateManager,
      mockMemory,
    );

    await saveToolResults(mockCtx, {
      toolResults: [
        {
          role: "tool",
          content: '{"temperature":72}',
          tool_call_id: "tc-1", // duplicate
          name: "get-weather",
        },
        {
          role: "tool",
          content: '{"result":"new"}',
          tool_call_id: "tc-2", // new
          name: "another-tool",
        },
      ],
      instanceId: "wf-1",
    });

    // Should only have 2 messages (1 existing + 1 new, skipping duplicate)
    expect(state.instances["wf-1"].messages).toHaveLength(2);
  });
});

describe("createRecordInitialEntry", () => {
  it("should create initial entry in state", async () => {
    const stateManager = createMockStateManager();

    const recordInitialEntry = createRecordInitialEntry(stateManager);
    await recordInitialEntry(mockCtx, {
      instanceId: "wf-1",
      inputValue: "What's the weather?",
      source: "direct",
      startTime: "2024-01-01T00:00:00Z",
    });

    expect(stateManager.ensureInstance).toHaveBeenCalledWith(
      "wf-1",
      "What's the weather?",
      undefined,
    );
    expect(stateManager.saveState).toHaveBeenCalled();
  });
});

describe("createFinalizeWorkflow", () => {
  it("should mark workflow as completed", async () => {
    const state: AgentWorkflowState = {
      instances: {
        "wf-1": {
          input_value: "test",
          output: null,
          start_time: "2024-01-01T00:00:00Z",
          end_time: null,
          messages: [],
          system_messages: [],
          last_message: null,
          tool_history: [],
          source: "direct",
          workflow_instance_id: "wf-1",
          triggering_workflow_instance_id: null,
          workflow_name: "agentWorkflow",
          session_id: null,
          trace_context: null,
          status: "running",
        },
      },
    };

    const stateManager = createMockStateManager(state);
    const finalizeWorkflow = createFinalizeWorkflow(stateManager);

    await finalizeWorkflow(mockCtx, {
      instanceId: "wf-1",
      finalOutput: "The weather is sunny!",
      endTime: "2024-01-01T00:01:00Z",
    });

    expect(stateManager.saveState).toHaveBeenCalled();
    expect(state.instances["wf-1"].status).toBe("completed");
    expect(state.instances["wf-1"].output).toBe("The weather is sunny!");
    expect(state.instances["wf-1"].end_time).toBe("2024-01-01T00:01:00Z");
  });

  it("should mark workflow as failed when no output", async () => {
    const state: AgentWorkflowState = {
      instances: {
        "wf-1": {
          input_value: "test",
          output: null,
          start_time: "2024-01-01T00:00:00Z",
          end_time: null,
          messages: [],
          system_messages: [],
          last_message: null,
          tool_history: [],
          source: "direct",
          workflow_instance_id: "wf-1",
          triggering_workflow_instance_id: null,
          workflow_name: "agentWorkflow",
          session_id: null,
          trace_context: null,
          status: "running",
        },
      },
    };

    const stateManager = createMockStateManager(state);
    const finalizeWorkflow = createFinalizeWorkflow(stateManager);

    await finalizeWorkflow(mockCtx, {
      instanceId: "wf-1",
    });

    expect(state.instances["wf-1"].status).toBe("failed");
  });
});
