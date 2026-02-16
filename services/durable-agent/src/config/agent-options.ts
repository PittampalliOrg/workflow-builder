/**
 * Main configuration interface for DurableAgent.
 */

import type { LanguageModelV1 } from "ai";
import type { DurableAgentTool } from "../types/tool.js";
import type { AgentStateConfig } from "./state-config.js";
import type { AgentPubSubConfig } from "./pubsub-config.js";
import type { AgentRegistryConfig } from "./registry-config.js";
import type { AgentExecutionConfig } from "./execution-config.js";
import type { WorkflowRetryPolicy } from "./retry-config.js";
import type { AgentObservabilityConfig } from "./observability-config.js";

export interface DurableAgentOptions {
  /** Agent name (unique identifier). */
  name: string;
  /** Agent role/persona label. */
  role?: string;
  /** High-level goal for prompting context. */
  goal?: string;
  /** System prompt / instructions for the LLM. */
  instructions?: string;

  /** AI SDK model instance (e.g., openai("gpt-4o")). */
  model: LanguageModelV1;

  /** Tool registry: name -> tool object with execute() + inputSchema. */
  tools?: Record<string, DurableAgentTool>;

  /** Dapr state store configuration. */
  state?: AgentStateConfig;
  /** Dapr pub/sub configuration. */
  pubsub?: AgentPubSubConfig;
  /** Agent registry configuration. */
  registry?: AgentRegistryConfig;
  /** Execution settings (max iterations, tool choice, orchestration). */
  execution?: AgentExecutionConfig;
  /** Workflow retry policy. */
  retry?: WorkflowRetryPolicy;
  /** Observability configuration. */
  observability?: AgentObservabilityConfig;

  /** Extra metadata to publish to the registry. */
  agentMetadata?: Record<string, unknown>;
}
