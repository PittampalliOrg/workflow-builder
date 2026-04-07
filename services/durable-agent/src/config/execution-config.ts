/**
 * Execution and orchestration configuration.
 * Mirrors Python AgentExecutionConfig and OrchestrationMode.
 */

/** Orchestration mode for multi-agent coordination. */
export enum OrchestrationMode {
  AGENT = "agent",
  RANDOM = "random",
  ROUNDROBIN = "roundrobin",
}

/** Execution dials for the agent run. */
export interface AgentExecutionConfig {
  /** Maximum ReAct loop iterations. Default: 10. */
  maxIterations?: number;
  /**
   * Roll over long-running workflows with continue-as-new after this many
   * completed turns. Keeps workflow history bounded without losing loop state.
   */
  continueAsNewAfterTurns?: number;
  /** Tool choice mode. Default: "auto". */
  toolChoice?: string;
  /** Enable multi-agent orchestration. */
  orchestrationMode?: OrchestrationMode;
}
