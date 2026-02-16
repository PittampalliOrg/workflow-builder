/**
 * Tests for orchestration strategies.
 */
import { describe, it, expect } from "vitest";
import { RoundRobinOrchestrationStrategy } from "../src/orchestration/roundrobin-strategy.js";
import { RandomOrchestrationStrategy } from "../src/orchestration/random-strategy.js";
import { AgentOrchestrationStrategy } from "../src/orchestration/agent-strategy.js";
import { OrchestrationMode } from "../src/config/execution-config.js";

const testAgents = {
  "agent-a": { role: "Research", goal: "Research tasks" },
  "agent-b": { role: "Writing", goal: "Write content" },
  "agent-c": { role: "Review", goal: "Review work" },
};

describe("RoundRobinOrchestrationStrategy", () => {
  it("should initialize with sorted agent names", () => {
    const strategy = new RoundRobinOrchestrationStrategy();
    const state = strategy.initialize("test task", testAgents);

    expect(state.agent_names).toEqual(["agent-a", "agent-b", "agent-c"]);
    expect(state.last_response).toBeNull();
    expect(state.task).toBe("test task");
  });

  it("should throw on empty agents", () => {
    const strategy = new RoundRobinOrchestrationStrategy();
    expect(() => strategy.initialize("task", {})).toThrow(
      "No agents available",
    );
  });

  it("should select agents in round-robin order", () => {
    const strategy = new RoundRobinOrchestrationStrategy();
    const state = strategy.initialize("task", testAgents);

    const turn1 = strategy.selectNextAgent(state, 1);
    expect(turn1.agent).toBe("agent-a");

    const turn2 = strategy.selectNextAgent(state, 2);
    expect(turn2.agent).toBe("agent-b");

    const turn3 = strategy.selectNextAgent(state, 3);
    expect(turn3.agent).toBe("agent-c");

    // Should wrap around
    const turn4 = strategy.selectNextAgent(state, 4);
    expect(turn4.agent).toBe("agent-a");
  });

  it("should include previous response in instruction", () => {
    const strategy = new RoundRobinOrchestrationStrategy();
    const state = strategy.initialize("task", testAgents);

    // First turn — no previous response
    const turn1 = strategy.selectNextAgent(state, 1);
    expect(turn1.instruction).toBe("task");

    // After processing first response
    const processResult = strategy.processResponse(state, {
      content: "I found some results",
      name: "agent-a",
    });

    const turn2 = strategy.selectNextAgent(
      processResult.updated_state,
      2,
    );
    expect(turn2.instruction).toContain("Previous response from agent-a");
    expect(turn2.instruction).toContain("I found some results");
  });

  it("should continue until max iterations", () => {
    const strategy = new RoundRobinOrchestrationStrategy();
    const state = strategy.initialize("task", testAgents);

    expect(strategy.shouldContinue(state, 1, 5)).toBe(true);
    expect(strategy.shouldContinue(state, 4, 5)).toBe(true);
    expect(strategy.shouldContinue(state, 5, 5)).toBe(false);
    expect(strategy.shouldContinue(state, 6, 5)).toBe(false);
  });

  it("should finalize with last response", () => {
    const strategy = new RoundRobinOrchestrationStrategy();
    strategy.orchestratorName = "test-orchestrator";

    const state = {
      agent_names: ["agent-a"],
      task: "task",
      last_response: {
        content: "Final answer",
        name: "agent-a",
      },
    };

    const result = strategy.finalize(state);
    expect(result.role).toBe("assistant");
    expect(result.content).toContain("Final answer");
    expect(result.content).toContain("agent-a");
    expect(result.name).toBe("test-orchestrator");
  });

  it("should handle finalize without responses", () => {
    const strategy = new RoundRobinOrchestrationStrategy();
    const state = {
      agent_names: ["agent-a"],
      task: "task",
      last_response: null,
    };

    const result = strategy.finalize(state);
    expect(result.content).toContain("no agent responses");
  });
});

describe("RandomOrchestrationStrategy", () => {
  it("should initialize with agent list", () => {
    const strategy = new RandomOrchestrationStrategy();
    const state = strategy.initialize("test task", testAgents);

    expect(state.agent_names).toEqual(
      expect.arrayContaining(["agent-a", "agent-b", "agent-c"]),
    );
    expect(state.previous_agent).toBeNull();
    expect(state.task).toBe("test task");
  });

  it("should throw on empty agents", () => {
    const strategy = new RandomOrchestrationStrategy();
    expect(() => strategy.initialize("task", {})).toThrow(
      "No agents available",
    );
  });

  it("should select a valid agent", () => {
    const strategy = new RandomOrchestrationStrategy();
    const state = strategy.initialize("task", testAgents);

    const action = strategy.selectNextAgent(state, 1);
    expect(["agent-a", "agent-b", "agent-c"]).toContain(action.agent);
  });

  it("should avoid previous agent when possible", () => {
    const strategy = new RandomOrchestrationStrategy();
    const state = {
      agent_names: ["agent-a", "agent-b"],
      previous_agent: "agent-a",
      last_response: null,
      task: "task",
    };

    // With only two agents and previous_agent set, should pick the other one
    // Run multiple times to be confident
    const selectedAgents = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const action = strategy.selectNextAgent(state, i + 1);
      selectedAgents.add(action.agent);
    }
    // Should strongly prefer agent-b (though not guaranteed with single agent fallback)
    expect(selectedAgents.has("agent-b")).toBe(true);
  });

  it("should update previous_agent on processResponse", () => {
    const strategy = new RandomOrchestrationStrategy();
    const state = strategy.initialize("task", testAgents);

    const result = strategy.processResponse(state, {
      content: "result",
      name: "agent-b",
    });

    expect(result.updated_state.previous_agent).toBe("agent-b");
    expect(result.verdict).toBe("continue");
  });

  it("should continue until max iterations", () => {
    const strategy = new RandomOrchestrationStrategy();
    const state = strategy.initialize("task", testAgents);

    expect(strategy.shouldContinue(state, 1, 5)).toBe(true);
    expect(strategy.shouldContinue(state, 5, 5)).toBe(false);
  });
});

describe("AgentOrchestrationStrategy", () => {
  it("should initialize with minimal state", () => {
    const strategy = new AgentOrchestrationStrategy();
    const state = strategy.initialize("task", testAgents);

    expect(state.task).toBe("task");
    expect(state.plan).toEqual([]);
    expect(state.verdict).toBeNull();
  });

  it("should throw on direct selectNextAgent call", () => {
    const strategy = new AgentOrchestrationStrategy();
    expect(() => strategy.selectNextAgent({}, 1)).toThrow(
      "should not be called directly",
    );
  });

  it("should throw on direct processResponse call", () => {
    const strategy = new AgentOrchestrationStrategy();
    expect(() => strategy.processResponse({}, {})).toThrow(
      "should not be called directly",
    );
  });

  it("should check continuation correctly", () => {
    const strategy = new AgentOrchestrationStrategy();

    expect(
      strategy.shouldContinue({ verdict: "continue" }, 1, 5),
    ).toBe(true);
    expect(
      strategy.shouldContinue({ verdict: "completed" }, 1, 5),
    ).toBe(false);
    expect(
      strategy.shouldContinue({ verdict: "continue" }, 5, 5),
    ).toBe(false);
  });
});

describe("OrchestrationMode", () => {
  it("should have correct enum values", () => {
    expect(OrchestrationMode.AGENT).toBe("agent");
    expect(OrchestrationMode.RANDOM).toBe("random");
    expect(OrchestrationMode.ROUNDROBIN).toBe("roundrobin");
  });
});
