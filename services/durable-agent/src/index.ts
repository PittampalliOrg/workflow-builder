/**
 * @dapr-agents/durable-agent
 *
 * Reusable durable agent library for Dapr Workflows.
 * Full TypeScript port of the Python dapr_agents DurableAgent.
 */

// Main classes
export { DurableAgent } from "./durable-agent.js";
export { AgentRunner } from "./agent-runner.js";
export type { AgentRunnerOptions } from "./agent-runner.js";

// Types
export type {
	WorkflowStatus,
	ToolCall,
	ToolExecutionRecord,
	DurableAgentTool,
	AgentWorkflowMessage,
	AgentWorkflowEntry,
	AgentWorkflowState,
	TriggerAction,
	BroadcastMessage,
	AgentTaskResponse,
	LoopToolChoice,
	LoopStopCondition,
	LoopPrepareStepRule,
	LoopPrepareStepPolicy,
	LoopDoneToolConfig,
	LoopPolicy,
	LoopUsage,
	LoopStepRecord,
	LoopDeclarationOnlyTool,
	LoopPreparedStep,
} from "./types/index.js";

// Config
export type {
	DurableAgentOptions,
	AgentStateConfig,
	AgentPubSubConfig,
	AgentRegistryConfig,
	AgentExecutionConfig,
	WorkflowRetryPolicy,
	AgentObservabilityConfig,
} from "./config/index.js";
export { OrchestrationMode } from "./config/index.js";

// State
export { DaprAgentState } from "./state/index.js";
export { withEtagRetry } from "./state/index.js";

// Memory
export type { MemoryProvider, MemoryMessage } from "./memory/index.js";
export { ConversationListMemory } from "./memory/index.js";
export { DaprStateMemory } from "./memory/index.js";

// LLM
export {
	callLlmAdapter,
	toAiSdkMessages,
	buildToolDeclarations,
} from "./llm/index.js";
export type { LlmCallResult } from "./llm/index.js";

// Workflow
export {
	createAgentWorkflow,
	createOrchestrationWorkflow,
} from "./workflow/index.js";
export type {
	AgentActivities,
	OrchestrationActivities,
} from "./workflow/index.js";
export {
	createRecordInitialEntry,
	createCallLlm,
	createRunTool,
	createSaveToolResults,
	createFinalizeWorkflow,
} from "./workflow/index.js";

// PubSub
export { broadcastMessage, sendMessageToAgent } from "./pubsub/index.js";
export type { AgentRegistryEntry } from "./pubsub/index.js";

// Registry
export { AgentRegistry } from "./registry/index.js";

// Orchestration
export {
	OrchestrationStrategy,
	RoundRobinOrchestrationStrategy,
	RandomOrchestrationStrategy,
	AgentOrchestrationStrategy,
} from "./orchestration/index.js";
export type {
	OrchestrationAction,
	OrchestrationProcessResult,
	OrchestrationFinalMessage,
} from "./orchestration/index.js";

// Observability
export {
	initOtel,
	otelLogMixin,
	extractTraceContext,
	injectTraceContext,
} from "./observability/index.js";

// Mastra adapters (optional — all graceful fallback if packages not installed)
export {
	adaptMastraTool,
	adaptMastraTools,
	type MastraToolLike,
	registerLlmProvider,
	registerEmbeddingProvider,
	resolveModel,
	resolveEmbeddingModel,
	registerBuiltinProviders,
	createMastraWorkspaceTools,
	parseMcpServersConfig,
	discoverMcpTools,
	type McpServerConfig,
	runInputProcessors,
	createProcessors,
	ProcessorAbortError,
	type ProcessorLike,
	MastraMemoryAdapter,
	createMastraMemoryAdapter,
	type MastraMemoryLike,
	createRagTools,
	parseRagToolsConfig,
	type RagToolConfig,
	runScorers,
	createScorers,
	type ScorerLike,
	type ScoringResult,
	createVoiceTools,
	type VoiceProviderLike,
} from "./mastra/index.js";
