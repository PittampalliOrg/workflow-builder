/**
 * Tests for type definitions — serialization round-trips and defaults.
 */
import { describe, it, expect } from "vitest";
import type {
  AgentWorkflowMessage,
  AgentWorkflowEntry,
  AgentWorkflowState,
  ToolCall,
  ToolExecutionRecord,
  TriggerAction,
  BroadcastMessage,
  AgentTaskResponse,
  WorkflowStatus,
} from "../src/types/index.js";

describe("Type definitions", () => {
  describe("AgentWorkflowMessage", () => {
    it("should create a user message", () => {
      const msg: AgentWorkflowMessage = {
        id: "test-id",
        role: "user",
        content: "Hello",
        timestamp: new Date().toISOString(),
      };
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("Hello");
      expect(msg.tool_calls).toBeUndefined();
    });

    it("should create an assistant message with tool calls", () => {
      const tc: ToolCall = {
        id: "tc-1",
        type: "function",
        function: {
          name: "get-weather",
          arguments: '{"location":"NYC"}',
        },
      };
      const msg: AgentWorkflowMessage = {
        id: "test-id",
        role: "assistant",
        content: null,
        tool_calls: [tc],
        timestamp: new Date().toISOString(),
      };
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls![0].function.name).toBe("get-weather");
    });

    it("should create a tool result message", () => {
      const msg: AgentWorkflowMessage = {
        id: "test-id",
        role: "tool",
        content: '{"temperature":72}',
        tool_call_id: "tc-1",
        name: "get-weather",
        timestamp: new Date().toISOString(),
      };
      expect(msg.role).toBe("tool");
      expect(msg.tool_call_id).toBe("tc-1");
    });
  });

  describe("AgentWorkflowEntry", () => {
    it("should create with all required fields", () => {
      const entry: AgentWorkflowEntry = {
        input_value: "What is the weather?",
        output: null,
        start_time: new Date().toISOString(),
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
      };
      expect(entry.status).toBe("running");
      expect(entry.messages).toHaveLength(0);
      expect(entry.tool_history).toHaveLength(0);
    });
  });

  describe("AgentWorkflowState", () => {
    it("should JSON serialize and deserialize correctly", () => {
      const state: AgentWorkflowState = {
        instances: {
          "wf-1": {
            input_value: "test",
            output: "result",
            start_time: "2024-01-01T00:00:00Z",
            end_time: "2024-01-01T00:01:00Z",
            messages: [
              {
                id: "m1",
                role: "user",
                content: "test",
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
            status: "completed",
          },
        },
      };

      const json = JSON.stringify(state);
      const parsed = JSON.parse(json) as AgentWorkflowState;
      expect(parsed.instances["wf-1"].status).toBe("completed");
      expect(parsed.instances["wf-1"].messages).toHaveLength(1);
      expect(parsed.instances["wf-1"].messages[0].content).toBe("test");
    });
  });

  describe("ToolExecutionRecord", () => {
    it("should capture tool execution metadata", () => {
      const record: ToolExecutionRecord = {
        id: "rec-1",
        timestamp: new Date().toISOString(),
        tool_call_id: "tc-1",
        tool_name: "get-weather",
        tool_args: { location: "NYC" },
        execution_result: '{"temperature":72}',
      };
      expect(record.tool_name).toBe("get-weather");
      expect(record.tool_args.location).toBe("NYC");
    });
  });

  describe("TriggerAction", () => {
    it("should serialize with optional fields", () => {
      const trigger: TriggerAction = {
        task: "What's the weather in NYC?",
      };
      const json = JSON.stringify(trigger);
      const parsed = JSON.parse(json) as TriggerAction;
      expect(parsed.task).toBe("What's the weather in NYC?");
      expect(parsed.workflow_instance_id).toBeUndefined();
    });

    it("should support metadata and trace context", () => {
      const trigger: TriggerAction = {
        task: "test",
        workflow_instance_id: "parent-wf",
        _message_metadata: {
          source: "orchestrator",
          triggering_workflow_instance_id: "parent-wf",
        },
        _otel_span_context: { traceId: "abc123" },
      };
      expect(trigger._message_metadata?.source).toBe("orchestrator");
    });
  });

  describe("WorkflowStatus", () => {
    it("should only allow lowercase values", () => {
      const statuses: WorkflowStatus[] = ["running", "completed", "failed"];
      expect(statuses).toHaveLength(3);
      expect(statuses).toContain("running");
      expect(statuses).toContain("completed");
      expect(statuses).toContain("failed");
    });
  });
});
