/**
 * Abstract orchestration strategy interface.
 * Mirrors Python dapr_agents/agents/orchestration/strategy.py.
 *
 * All methods receive state as a parameter and return updated state,
 * making strategies stateless and replay-safe for Dapr Workflows.
 */

export interface OrchestrationAction {
  agent: string;
  instruction: string;
  metadata?: Record<string, unknown>;
}

export interface OrchestrationProcessResult {
  updated_state: Record<string, unknown>;
  verdict?: "continue" | "completed" | "failed";
}

export interface OrchestrationFinalMessage {
  role: "assistant";
  content: string;
  name?: string;
}

export abstract class OrchestrationStrategy {
  orchestratorName?: string;

  /** Initialize orchestration state for a new workflow. */
  abstract initialize(
    task: string,
    agents: Record<string, unknown>,
  ): Record<string, unknown>;

  /** Select the next agent to execute and prepare their instruction. */
  abstract selectNextAgent(
    state: Record<string, unknown>,
    turn: number,
  ): OrchestrationAction;

  /** Process an agent's response and update orchestration state. */
  abstract processResponse(
    state: Record<string, unknown>,
    response: Record<string, unknown>,
  ): OrchestrationProcessResult;

  /** Determine if orchestration should continue for another turn. */
  abstract shouldContinue(
    state: Record<string, unknown>,
    turn: number,
    maxIterations: number,
  ): boolean;

  /** Generate final summary/output message for the caller. */
  abstract finalize(
    state: Record<string, unknown>,
  ): OrchestrationFinalMessage;
}
