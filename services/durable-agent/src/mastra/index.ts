/**
 * Mastra integration adapters for durable-agent.
 *
 * All adapters are optional — durable-agent works without any Mastra
 * packages installed. Each adapter uses dynamic import() with try/catch
 * for graceful fallback.
 */

// Phase 1: Tool Adapter + Model Router
export {
  adaptMastraTool,
  adaptMastraTools,
  type MastraToolLike,
} from "./tool-adapter.js";

export {
  registerLlmProvider,
  registerEmbeddingProvider,
  resolveModel,
  resolveEmbeddingModel,
  registerBuiltinProviders,
} from "./model-router.js";

// Phase 2: Workspace + MCP Client
export {
  createMastraWorkspaceTools,
} from "./workspace-setup.js";

export {
  parseMcpServersConfig,
  discoverMcpTools,
  type McpServerConfig,
} from "./mcp-client-setup.js";

// Phase 3: Processors
export {
  runInputProcessors,
  createProcessors,
  ProcessorAbortError,
  type ProcessorLike,
} from "./processor-adapter.js";

// Phase 4: Memory Adapter
export {
  MastraMemoryAdapter,
  createMastraMemoryAdapter,
  type MastraMemoryLike,
} from "./memory-adapter.js";

// Phase 5: RAG Tools
export {
  createRagTools,
  parseRagToolsConfig,
  type RagToolConfig,
} from "./rag-tools.js";

// Phase 6: Eval Scorer
export {
  runScorers,
  createScorers,
  type ScorerLike,
  type ScoringResult,
} from "./eval-scorer.js";

// Phase 7: Voice Tools
export {
  createVoiceTools,
  type VoiceProviderLike,
} from "./voice-tools.js";
