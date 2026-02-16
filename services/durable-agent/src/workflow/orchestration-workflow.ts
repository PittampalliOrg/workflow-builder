/**
 * Orchestration workflow for multi-agent coordination.
 * Mirrors Python orchestration_workflow at durable.py:457-814.
 *
 * For cross-service multi-agent, uses Dapr Service Invocation API
 * wrapped as an activity (since JS SDK callChildWorkflow doesn't
 * support app_id like the Python SDK).
 */

import type { WorkflowContext } from "@dapr/dapr";
import type { OrchestrationStrategy } from "../orchestration/strategy.js";
import type { AgentActivities } from "./agent-workflow.js";

export interface OrchestrationActivities extends AgentActivities {
  getAvailableAgents: (
    ctx: any,
    payload: Record<string, never>,
  ) => Promise<{
    metadata: Record<string, unknown>;
    formatted: string;
  }>;
  initializeOrchestration: (
    ctx: any,
    payload: { task: string; agents: Record<string, unknown>; instanceId: string },
  ) => Promise<Record<string, unknown>>;
  selectNextAction: (
    ctx: any,
    payload: { state: Record<string, unknown>; turn: number; task: string },
  ) => Promise<{ agent: string; instruction: string; metadata?: Record<string, unknown> }>;
  processOrchestrationResponse: (
    ctx: any,
    payload: {
      state: Record<string, unknown>;
      response: Record<string, unknown>;
      action: Record<string, unknown>;
      task: string;
    },
  ) => Promise<{ updated_state: Record<string, unknown>; verdict?: string }>;
  shouldContinueOrchestration: (
    ctx: any,
    payload: { state: Record<string, unknown>; turn: number },
  ) => Promise<boolean>;
  finalizeOrchestration: (
    ctx: any,
    payload: { state: Record<string, unknown>; task: string; instanceId: string },
  ) => Promise<{ role: string; content: string; name?: string }>;
  invokeRemoteAgent: (
    ctx: any,
    payload: { appId: string; task: string },
  ) => Promise<Record<string, unknown>>;
}

/**
 * Create the orchestration workflow generator.
 *
 * For RoundRobin/Random strategies, uses strategy delegation activities.
 * For single-process multi-agent, uses callChildWorkflow.
 * For cross-service, uses Dapr Service Invocation via invokeRemoteAgent activity.
 */
export function createOrchestrationWorkflow(
  activities: OrchestrationActivities,
  strategy: OrchestrationStrategy,
  maxIterations: number,
) {
  return async function* orchestrationWorkflow(
    ctx: WorkflowContext,
    input: {
      task: string;
      instance_id: string;
      triggering_workflow_instance_id?: string;
      start_time?: string;
    },
  ): AsyncGenerator<unknown, unknown, any> {
    const { task, instance_id: instanceId } = input;

    console.log(
      `[orchestrationWorkflow] Started for instance ${instanceId} with task: ${task}`,
    );

    // Get available agents
    const agentsResult: {
      metadata: Record<string, unknown>;
      formatted: string;
    } = yield ctx.callActivity(activities.getAvailableAgents, {} as Record<string, never>);

    // Initialize orchestration state via strategy
    const orchState: Record<string, unknown> = yield ctx.callActivity(
      activities.initializeOrchestration,
      {
        task,
        agents: agentsResult.metadata,
        instanceId,
      },
    );

    let currentState = orchState;
    let finalMessage: { role: string; content: string; name?: string } | undefined;

    // Orchestration loop
    for (let turn = 1; turn <= maxIterations; turn++) {
      // Select next agent via strategy
      const action: {
        agent: string;
        instruction: string;
        metadata?: Record<string, unknown>;
      } = yield ctx.callActivity(activities.selectNextAction, {
        state: currentState,
        turn,
        task,
      });

      const nextAgent = action.agent;
      const instruction = action.instruction;

      console.log(
        `[orchestrationWorkflow] Turn ${turn}: Selected agent '${nextAgent}'`,
      );

      // Invoke the agent — use Dapr Service Invocation for cross-service
      const agentsMeta = agentsResult.metadata as Record<
        string,
        { agent?: { appid?: string } }
      >;
      const agentMeta = agentsMeta[nextAgent];
      const appId = agentMeta?.agent?.appid;

      let result: Record<string, unknown>;
      if (appId) {
        // Cross-service: use Dapr Service Invocation API
        result = yield ctx.callActivity(activities.invokeRemoteAgent, {
          appId,
          task: instruction,
        });
      } else {
        // Same-process fallback: call LLM directly
        const llmResult = yield ctx.callActivity(activities.callLlm, {
          instanceId,
          task: instruction,
        });
        result = llmResult as Record<string, unknown>;
      }

      console.log(
        `[orchestrationWorkflow] Turn ${turn}: Agent '${nextAgent}' responded`,
      );

      // Process response via strategy
      const processResult: {
        updated_state: Record<string, unknown>;
        verdict?: string;
      } = yield ctx.callActivity(activities.processOrchestrationResponse, {
        state: currentState,
        response: result,
        action,
        task,
      });

      currentState = processResult.updated_state;

      // Check if we should continue
      const shouldContinue: boolean = yield ctx.callActivity(
        activities.shouldContinueOrchestration,
        {
          state: currentState,
          turn,
        },
      );

      if (!shouldContinue) {
        console.log(
          `[orchestrationWorkflow] Stopping after turn ${turn}`,
        );
        break;
      }
    }

    // Finalize orchestration
    finalMessage = yield ctx.callActivity(activities.finalizeOrchestration, {
      state: currentState,
      task,
      instanceId,
    });

    console.log(
      `[orchestrationWorkflow] Completed for instance ${instanceId}`,
    );

    return finalMessage;
  };
}
