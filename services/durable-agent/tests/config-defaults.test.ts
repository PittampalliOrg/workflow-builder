/**
 * Tests for configuration defaults and validation.
 */
import { describe, it, expect } from "vitest";
import { DurableAgent } from "../src/durable-agent.js";
import { OrchestrationMode } from "../src/config/execution-config.js";

// Mock model for testing (minimal LanguageModelV1 interface)
const mockModel = {
  specificationVersion: "v1",
  provider: "test",
  modelId: "test-model",
  defaultObjectGenerationMode: "json",
  doGenerate: async () => ({
    text: "test",
    finishReason: "stop",
    usage: { promptTokens: 0, completionTokens: 0 },
    rawCall: { rawPrompt: "", rawSettings: {} },
  }),
  doStream: async () => ({
    stream: new ReadableStream(),
    rawCall: { rawPrompt: "", rawSettings: {} },
  }),
} as any;

describe("DurableAgent configuration", () => {
  it("should require name", () => {
    expect(
      () => new DurableAgent({ name: "", model: mockModel }),
    ).toThrow("requires a name");
  });

  it("should apply default values", () => {
    const agent = new DurableAgent({
      name: "test-agent",
      model: mockModel,
    });

    expect(agent.name).toBe("test-agent");
    expect(agent.role).toBe("assistant");
    expect(agent.goal).toBe("");
    expect(agent.instructions).toBe("You are a helpful assistant.");
    expect(agent.maxIterations).toBe(10);
    expect(agent.tools).toEqual({});
  });

  it("should accept custom configuration", () => {
    const agent = new DurableAgent({
      name: "custom-agent",
      role: "Weather Expert",
      goal: "Provide accurate weather information",
      instructions: "You are a weather expert.",
      model: mockModel,
      execution: { maxIterations: 5 },
    });

    expect(agent.role).toBe("Weather Expert");
    expect(agent.goal).toBe("Provide accurate weather information");
    expect(agent.instructions).toBe("You are a weather expert.");
    expect(agent.maxIterations).toBe(5);
  });

  it("should register tools", () => {
    const tool = {
      description: "Test tool",
      inputSchema: { type: "object" },
      execute: async () => "result",
    };

    const agent = new DurableAgent({
      name: "test-agent",
      model: mockModel,
      tools: { "test-tool": tool },
    });

    expect(Object.keys(agent.tools)).toHaveLength(1);
    expect(agent.tools["test-tool"].description).toBe("Test tool");
  });

  it("should configure state store", () => {
    const agent = new DurableAgent({
      name: "test-agent",
      model: mockModel,
      state: {
        storeName: "custom-store",
        stateKey: "custom-key",
      },
    });

    expect(agent.stateManager).toBeDefined();
  });

  it("should not have registry by default", () => {
    const agent = new DurableAgent({
      name: "test-agent",
      model: mockModel,
    });

    expect(agent.registry).toBeNull();
  });

  it("should create registry when configured", () => {
    const agent = new DurableAgent({
      name: "test-agent",
      model: mockModel,
      registry: {
        storeName: "registry-store",
        teamName: "team-alpha",
      },
    });

    expect(agent.registry).not.toBeNull();
  });

  it("should not start automatically", () => {
    const agent = new DurableAgent({
      name: "test-agent",
      model: mockModel,
    });

    expect(agent.isStarted).toBe(false);
    expect(agent.runtime).toBeNull();
  });

  it("should create agent workflow", () => {
    const agent = new DurableAgent({
      name: "test-agent",
      model: mockModel,
    });

    expect(agent.agentWorkflow).toBeDefined();
    expect(typeof agent.agentWorkflow).toBe("function");
  });

  it("should not create orchestration workflow without mode", () => {
    const agent = new DurableAgent({
      name: "test-agent",
      model: mockModel,
    });

    expect(agent.orchestrationWorkflow).toBeNull();
  });

  it("should create orchestration workflow with roundrobin mode", () => {
    const agent = new DurableAgent({
      name: "orchestrator",
      model: mockModel,
      execution: {
        orchestrationMode: OrchestrationMode.ROUNDROBIN,
      },
    });

    expect(agent.orchestrationWorkflow).not.toBeNull();
    expect(typeof agent.orchestrationWorkflow).toBe("function");
  });

  it("should create orchestration workflow with random mode", () => {
    const agent = new DurableAgent({
      name: "orchestrator",
      model: mockModel,
      execution: {
        orchestrationMode: OrchestrationMode.RANDOM,
      },
    });

    expect(agent.orchestrationWorkflow).not.toBeNull();
  });

  it("should create orchestration workflow with agent mode", () => {
    const agent = new DurableAgent({
      name: "orchestrator",
      model: mockModel,
      execution: {
        orchestrationMode: OrchestrationMode.AGENT,
      },
    });

    expect(agent.orchestrationWorkflow).not.toBeNull();
  });

  it("should provide ConversationListMemory by default", () => {
    const agent = new DurableAgent({
      name: "test-agent",
      model: mockModel,
    });

    expect(agent.memory).toBeDefined();
    // Verify it works
    agent.memory.addMessage({ role: "user", content: "hello" });
    const messages = agent.memory.getMessages();
    expect(messages).toHaveLength(1);
  });
});
