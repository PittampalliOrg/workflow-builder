/**
 * LLM-planned orchestration strategy.
 * Mirrors Python dapr_agents/agents/orchestration/agent_strategy.py.
 *
 * In the TypeScript version, the LLM plan generation and progress checking
 * are handled directly in the orchestration workflow. This strategy class
 * serves as a marker and configuration holder, with placeholder methods
 * since most logic is in the orchestration workflow itself.
 */

import {
  OrchestrationStrategy,
  type OrchestrationAction,
  type OrchestrationProcessResult,
  type OrchestrationFinalMessage,
} from "./strategy.js";

export class AgentOrchestrationStrategy extends OrchestrationStrategy {
  /**
   * Agent strategy initialization is handled in the orchestration workflow
   * via LLM plan generation. This placeholder returns minimal state.
   */
  initialize(
    task: string,
    _agents: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      task,
      plan: [],
      task_history: [],
      verdict: null,
    };
  }

  /**
   * Agent selection is handled in the orchestration workflow via LLM
   * next-step decision. This placeholder should not be called directly.
   */
  selectNextAgent(
    _state: Record<string, unknown>,
    _turn: number,
  ): OrchestrationAction {
    throw new Error(
      "AgentOrchestrationStrategy.selectNextAgent should not be called directly. " +
        "Agent selection is handled by the orchestration workflow via LLM calls.",
    );
  }

  /**
   * Response processing is handled in the orchestration workflow via LLM
   * progress checking. This placeholder should not be called directly.
   */
  processResponse(
    _state: Record<string, unknown>,
    _response: Record<string, unknown>,
  ): OrchestrationProcessResult {
    throw new Error(
      "AgentOrchestrationStrategy.processResponse should not be called directly. " +
        "Response processing is handled by the orchestration workflow.",
    );
  }

  shouldContinue(
    state: Record<string, unknown>,
    turn: number,
    maxIterations: number,
  ): boolean {
    const verdict = state.verdict as string | null;
    return verdict === "continue" && turn < maxIterations;
  }

  finalize(state: Record<string, unknown>): OrchestrationFinalMessage {
    const orchestratorName = this.orchestratorName || "AgentOrchestrator";
    const lastResult = (state.last_result as string) || "";
    return {
      role: "assistant",
      content: lastResult || "Orchestration completed.",
      name: orchestratorName,
    };
  }
}
