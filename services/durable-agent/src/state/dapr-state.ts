/**
 * Dapr state management with ETag-based optimistic concurrency.
 * Mirrors Python DaprInfra state methods at components.py:199-296.
 */

import { DaprClient } from "@dapr/dapr";
import type {
  AgentWorkflowState,
  AgentWorkflowEntry,
} from "../types/state.js";
import { withEtagRetry } from "./etag-retry.js";

/** Default empty state. */
function defaultState(): AgentWorkflowState {
  return { instances: {} };
}

/** Default workflow entry factory. */
function defaultEntry(
  instanceId: string,
  inputValue: string,
  triggeringWorkflowInstanceId?: string | null,
): AgentWorkflowEntry {
  return {
    input_value: inputValue,
    output: null,
    start_time: new Date().toISOString(),
    end_time: null,
    messages: [],
    system_messages: [],
    last_message: null,
    tool_history: [],
    source: null,
    workflow_instance_id: instanceId,
    triggering_workflow_instance_id: triggeringWorkflowInstanceId ?? null,
    workflow_name: "agentWorkflow",
    session_id: null,
    trace_context: null,
    status: "running",
  };
}

export class DaprAgentState {
  private client: DaprClient;
  private storeName: string;
  private stateKey: string;
  private maxEtagAttempts: number;

  constructor(
    client: DaprClient,
    storeName: string,
    stateKey: string,
    maxEtagAttempts: number = 10,
  ) {
    this.client = client;
    this.storeName = storeName;
    this.stateKey = stateKey;
    this.maxEtagAttempts = maxEtagAttempts;
  }

  /** Load the full agent state from the Dapr state store. */
  async loadState(): Promise<AgentWorkflowState> {
    const raw = await this.client.state.get(this.storeName, this.stateKey);
    if (raw) {
      return raw as AgentWorkflowState;
    }
    return defaultState();
  }

  /**
   * Persist the full agent state with optimistic concurrency.
   * Uses ETag retry loop to handle concurrent modifications.
   * Mirrors Python save_state at components.py:225-288.
   */
  async saveState(state: AgentWorkflowState): Promise<void> {
    await withEtagRetry(async () => {
      await this.client.state.save(this.storeName, [
        { key: this.stateKey, value: state },
      ]);
    }, this.maxEtagAttempts);
  }

  /**
   * Ensure an instance entry exists for the given workflow instance ID.
   * Creates a new entry if one doesn't exist; no-op if it already does.
   * Mirrors Python ensure_instance_exists at components.py:298-348.
   */
  async ensureInstance(
    instanceId: string,
    inputValue: string,
    triggeringWorkflowInstanceId?: string | null,
  ): Promise<AgentWorkflowState> {
    const state = await this.loadState();
    if (!state.instances[instanceId]) {
      state.instances[instanceId] = defaultEntry(
        instanceId,
        inputValue,
        triggeringWorkflowInstanceId,
      );
      await this.saveState(state);
    }
    return state;
  }
}
