/**
 * Main configuration interface for DurableAgent.
 */

import type { LanguageModel } from "ai";
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
	model: LanguageModel;
	/** Optional model resolver for per-step model overrides (e.g., CEL prepareStep rules). */
	modelResolver?: (modelSpec: string) => LanguageModel;

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

	/**
	 * Optional Mastra integration config.
	 * All fields are `unknown` to avoid compile-time Mastra dependencies.
	 * Adapters in src/mastra/ handle type narrowing at runtime.
	 */
	mastra?: {
		/** Model spec string, e.g., "openai/gpt-4o". Resolved via model-router. */
		modelSpec?: string;
		/** Mastra tools record (createTool objects). Adapted via tool-adapter. */
		tools?: Record<string, unknown>;
		/** Mastra Workspace instance. */
		workspace?: unknown;
		/** MCP server configs or MCPClient instance. */
		mcpClient?: unknown;
		/** Mastra processors for pre-LLM guardrails. */
		processors?: unknown[];
		/** Mastra Memory instance. Replaces default ConversationListMemory. */
		memory?: unknown;
		/** RAG tool configs or pre-built RAG tools. */
		ragTools?: Record<string, unknown>;
		/** Mastra voice provider instance. */
		voice?: unknown;
		/** Mastra eval scorers for post-workflow scoring. */
		scorers?: unknown[];
	};
}
