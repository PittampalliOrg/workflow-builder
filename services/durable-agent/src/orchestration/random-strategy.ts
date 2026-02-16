/**
 * Random orchestration strategy with previous-speaker avoidance.
 * Mirrors Python dapr_agents/agents/orchestration/random_strategy.py.
 */

import {
  OrchestrationStrategy,
  type OrchestrationAction,
  type OrchestrationProcessResult,
  type OrchestrationFinalMessage,
} from "./strategy.js";

export class RandomOrchestrationStrategy extends OrchestrationStrategy {
  initialize(
    task: string,
    agents: Record<string, unknown>,
  ): Record<string, unknown> {
    const agentNames = Object.keys(agents);
    if (agentNames.length === 0) {
      throw new Error("No agents available for random orchestration");
    }
    return {
      agent_names: agentNames,
      previous_agent: null,
      last_response: null,
      task,
    };
  }

  selectNextAgent(
    state: Record<string, unknown>,
    turn: number,
  ): OrchestrationAction {
    const agentNames = state.agent_names as string[];
    const previousAgent = state.previous_agent as string | null;
    const task = state.task as string;

    if (!agentNames || agentNames.length === 0) {
      throw new Error("No agent names in random orchestration state");
    }

    const nextAgent = this.selectRandomAgent(agentNames, previousAgent);

    const lastResponse = state.last_response as Record<string, unknown> | null;
    let instruction: string;
    if (lastResponse) {
      const previousSpeaker =
        (lastResponse.name as string) || "previous agent";
      const previousContent = (lastResponse.content as string) || "";
      instruction =
        `Task: ${task}\n\n` +
        `Previous response from ${previousSpeaker}:\n${previousContent}\n\n` +
        `Continue working on this task based on the above context.`;
    } else {
      instruction = task;
    }

    return {
      agent: nextAgent,
      instruction,
      metadata: {
        turn,
        previous_agent: previousAgent,
        selection_method: "random",
      },
    };
  }

  private selectRandomAgent(
    agentNames: string[],
    previousAgent: string | null,
  ): string {
    if (agentNames.length === 1 || previousAgent === null) {
      return agentNames[Math.floor(Math.random() * agentNames.length)];
    }
    const candidates = agentNames.filter((n) => n !== previousAgent);
    const pool = candidates.length > 0 ? candidates : agentNames;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  processResponse(
    state: Record<string, unknown>,
    response: Record<string, unknown>,
  ): OrchestrationProcessResult {
    const agentName = (response.name as string) || "unknown";
    return {
      updated_state: {
        ...state,
        last_response: response,
        previous_agent: agentName,
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
    const orchestratorName = this.orchestratorName || "RandomOrchestrator";

    let content: string;
    if (lastResponse) {
      const lastAgent = (lastResponse.name as string) || "unknown";
      const lastContent = (lastResponse.content as string) || "";
      content =
        `Random orchestration completed.\n\n` +
        `Final response from ${lastAgent}:\n${lastContent}`;
    } else {
      content = "Random orchestration completed with no agent responses.";
    }

    return {
      role: "assistant",
      content,
      name: orchestratorName,
    };
  }
}
