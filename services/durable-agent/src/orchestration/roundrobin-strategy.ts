/**
 * Round-robin orchestration strategy.
 * Mirrors Python dapr_agents/agents/orchestration/roundrobin_strategy.py.
 */

import {
  OrchestrationStrategy,
  type OrchestrationAction,
  type OrchestrationProcessResult,
  type OrchestrationFinalMessage,
} from "./strategy.js";

export class RoundRobinOrchestrationStrategy extends OrchestrationStrategy {
  initialize(
    task: string,
    agents: Record<string, unknown>,
  ): Record<string, unknown> {
    const agentNames = Object.keys(agents).sort();
    if (agentNames.length === 0) {
      throw new Error("No agents available for round-robin orchestration");
    }
    return {
      agent_names: agentNames,
      last_response: null,
      task,
    };
  }

  selectNextAgent(
    state: Record<string, unknown>,
    turn: number,
  ): OrchestrationAction {
    const agentNames = state.agent_names as string[];
    const task = state.task as string;

    if (!agentNames || agentNames.length === 0) {
      throw new Error("No agent names in round-robin state");
    }

    // Select agent using modulo for circular pattern (turn is 1-indexed)
    const agentIndex = (turn - 1) % agentNames.length;
    const nextAgent = agentNames[agentIndex];

    // Build instruction with context from previous response
    const lastResponse = state.last_response as Record<string, unknown> | null;
    let instruction: string;
    if (lastResponse) {
      const previousAgent = (lastResponse.name as string) || "previous agent";
      const previousContent = (lastResponse.content as string) || "";
      instruction =
        `Task: ${task}\n\n` +
        `Previous response from ${previousAgent}:\n${previousContent}\n\n` +
        `Continue working on this task based on the above context.`;
    } else {
      instruction = task;
    }

    return {
      agent: nextAgent,
      instruction,
      metadata: {
        turn,
        agent_index: agentIndex,
        total_agents: agentNames.length,
      },
    };
  }

  processResponse(
    state: Record<string, unknown>,
    response: Record<string, unknown>,
  ): OrchestrationProcessResult {
    return {
      updated_state: {
        ...state,
        last_response: response,
      },
      verdict: "continue",
    };
  }

  shouldContinue(
    _state: Record<string, unknown>,
    turn: number,
    maxIterations: number,
  ): boolean {
    return turn < maxIterations;
  }

  finalize(state: Record<string, unknown>): OrchestrationFinalMessage {
    const lastResponse = state.last_response as Record<string, unknown> | null;
    const orchestratorName =
      this.orchestratorName || "RoundRobinOrchestrator";

    let content: string;
    if (lastResponse) {
      const lastAgent = (lastResponse.name as string) || "unknown";
      const lastContent = (lastResponse.content as string) || "";
      content =
        `Round-robin orchestration completed.\n\n` +
        `Final response from ${lastAgent}:\n${lastContent}`;
    } else {
      content =
        "Round-robin orchestration completed with no agent responses.";
    }

    return {
      role: "assistant",
      content,
      name: orchestratorName,
    };
  }
}
