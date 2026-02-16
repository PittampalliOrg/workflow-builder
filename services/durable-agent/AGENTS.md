# Durable Agent — TypeScript Dapr Workflow ReAct Agent

Full TypeScript port of the Python `dapr_agents` DurableAgent, with optional Mastra SDK integration. Uses Dapr Workflow SDK for durable, crash-recoverable agent execution with parallel tool calls, ETag-based optimistic concurrency, and multi-agent orchestration.

## Quick Start

```bash
pnpm build          # TypeScript → dist/
pnpm start           # Run service (requires Dapr sidecar)
pnpm test            # 112 tests across 14 files
pnpm dev             # tsc --watch
```

Default port: **8001** (configurable via `PORT` env var).

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  Express HTTP Server (port 8001)                       │
│  POST /api/run  →  scheduleNewWorkflow()               │
│  POST /api/plan →  generateObject() (AI SDK 6)         │
└────────────┬───────────────────────────────────────────┘
             │
             ▼
┌────────────────────────────────────────────────────────┐
│  Dapr Workflow Runtime                                 │
│                                                        │
│  agentWorkflow (async generator)                       │
│  ┌──────────────────────────────────────────────────┐  │
│  │  1. recordInitialEntry  — bootstrap state        │  │
│  │  2. LOOP (1..maxIterations):                     │  │
│  │     a. callLlm          — AI SDK generateText()  │  │
│  │     b. if tool_calls:                            │  │
│  │        - runTool × N    — parallel via whenAll() │  │
│  │        - saveToolResults                         │  │
│  │     c. else: break (final answer)                │  │
│  │  3. finalizeWorkflow    — persist output          │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  All activities use Dapr state (Redis) with ETag       │
│  concurrency and jittered exponential backoff.         │
└────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Composition over inheritance** — `DurableAgent` holds sub-components (state, memory, registry), no inheritance chains
- **Activity-based durability** — All non-deterministic I/O (LLM calls, tool execution) runs in Dapr activities; the generator is replayed on crash recovery
- **Schema-only tool declarations** — LLM receives tool schemas but does not auto-execute; the workflow controls execution
- **Parallel tool execution** — All tool calls from a single LLM turn execute concurrently via `ctx.whenAll()`
- **Crash recovery repair** — `previousToolResults` passed through durable activity outputs to repair Redis state if a pod crashes between `saveToolResults` and the next `callLlm`
- **Optional Mastra integration** — All Mastra adapters use dynamic `import()` with try/catch; durable-agent works standalone without any Mastra packages

## HTTP API

| Method | Endpoint | Purpose | Sync |
|--------|----------|---------|------|
| GET | `/api/health` | Service status, tool list, token metrics | Yes |
| GET | `/api/tools` | List all available tools | Yes |
| POST | `/api/tools/:toolId` | Execute a single tool directly (bypass agent) | Yes |
| POST | `/api/run` | Start agent workflow | No (fire-and-forget) |
| POST | `/api/plan` | Generate structured plan | Yes |
| POST | `/api/execute-plan` | Execute a structured plan | No (fire-and-forget) |
| GET | `/api/dapr/subscribe` | Dapr subscription discovery | Yes |
| POST | `/api/dapr/sub` | Inbound Dapr pub/sub events | Yes |

### POST /api/run

```json
{
  "prompt": "Create a hello world file",
  "parentExecutionId": "exec-456",
  "nodeId": "node-123",
  "maxTurns": 10
}
// → { "success": true, "workflow_id": "durable-run-...", "dapr_instance_id": "..." }
```

### POST /api/plan

```json
{
  "prompt": "Refactor the auth module",
  "cwd": "/workspace/src"
}
// → { "success": true, "plan": { "goal": "...", "steps": [...], "estimated_tool_calls": 5 } }
```

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8001` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address |
| `STATE_STORE_NAME` | `statestore` | Dapr state store component name |
| `MAX_ITERATIONS` | `50` | Default ReAct loop max turns |
| `AI_MODEL` | `gpt-4o` | Fallback OpenAI model name |

### Mastra Integration (all optional)

| Variable | Description |
|----------|-------------|
| `MASTRA_MODEL_SPEC` | Model string, e.g., `"openai/gpt-4o"` (overrides `AI_MODEL`) |
| `MASTRA_WORKSPACE` | `"true"` to enable Mastra workspace tools |
| `MCP_SERVERS` | JSON array of MCP server configs |
| `MASTRA_PROCESSORS` | Comma-separated processor names, e.g., `"prompt-injection,pii"` |
| `MASTRA_RAG_TOOLS` | JSON array of RAG tool configs |
| `MASTRA_SCORERS` | Comma-separated scorer names, e.g., `"hallucination,relevance"` |

### Dapr & Infrastructure

| Variable | Default | Description |
|----------|---------|-------------|
| `DAPR_HOST` | `localhost` | Dapr sidecar host |
| `DAPR_HTTP_PORT` | `3500` | Dapr HTTP port |
| `PUBSUB_NAME` | `pubsub` | Dapr pub/sub component |
| `PUBSUB_TOPIC` | `workflow.stream` | Event topic |
| `ORCHESTRATOR_APP_ID` | `workflow-orchestrator` | Parent orchestrator for completion events |
| `AGENT_WORKSPACE_PATH` | `./workspace` | Workspace directory |
| `SANDBOX_BACKEND` | auto-detect | `"k8s"` or `"local"` |

## Built-in Workspace Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite a file |
| `edit_file` | Replace a string in a file |
| `list_files` | List directory entries with metadata |
| `delete_file` | Delete a file |
| `mkdir` | Create a directory |
| `file_stat` | Get file size, type, and timestamps |
| `execute_command` | Run a shell command |

Tools use a Sandbox abstraction (auto-detects K8s pod or local process execution).

## File Structure

```
src/
├── durable-agent.ts           # DurableAgent class — ties everything together
├── agent-runner.ts            # Optional HTTP wrapper (AgentRunner)
├── index.ts                   # Barrel exports (60+ symbols)
│
├── config/                    # Configuration interfaces
│   ├── agent-options.ts       #   DurableAgentOptions (+ mastra? section)
│   ├── execution-config.ts    #   OrchestrationMode enum, max iterations
│   ├── state-config.ts        #   Dapr state store config
│   ├── pubsub-config.ts       #   Dapr pub/sub config
│   ├── registry-config.ts     #   Agent registry config
│   ├── retry-config.ts        #   Workflow retry policy
│   └── observability-config.ts
│
├── types/                     # Shared type definitions
│   ├── tool.ts                #   DurableAgentTool, ToolCall, ToolExecutionRecord
│   ├── state.ts               #   AgentWorkflowMessage, AgentWorkflowEntry
│   └── trigger.ts             #   TriggerAction (workflow input)
│
├── workflow/                  # Dapr workflow definitions
│   ├── agent-workflow.ts      #   ReAct loop generator (agentWorkflow)
│   ├── orchestration-workflow.ts  # Multi-agent orchestration generator
│   └── activities.ts          #   5 activity factories (bound via closures)
│
├── llm/                       # LLM integration
│   ├── ai-sdk-adapter.ts      #   callLlmAdapter() — AI SDK 6 generateText()
│   ├── message-converter.ts   #   AgentWorkflowMessage ↔ AI SDK ModelMessage
│   └── tool-declarations.ts   #   Schema-only tool declarations + zodToJsonSchema
│
├── state/                     # Dapr state management
│   ├── dapr-state.ts          #   DaprAgentState (load/save with ETag)
│   └── etag-retry.ts          #   withEtagRetry() — jittered exponential backoff
│
├── memory/                    # Memory providers
│   ├── memory-base.ts         #   MemoryProvider interface
│   ├── conversation-list.ts   #   ConversationListMemory (in-memory)
│   └── dapr-state-memory.ts   #   DaprStateMemory (persisted in Dapr)
│
├── mastra/                    # Optional Mastra adapters (see below)
│   ├── index.ts               #   Barrel exports
│   ├── tool-adapter.ts        #   adaptMastraTool() / adaptMastraTools()
│   ├── model-router.ts        #   resolveModel("provider/model")
│   ├── workspace-setup.ts     #   createMastraWorkspaceTools()
│   ├── mcp-client-setup.ts    #   discoverMcpTools() from MCP_SERVERS env
│   ├── processor-adapter.ts   #   Pre-LLM guardrails pipeline
│   ├── memory-adapter.ts      #   MastraMemoryAdapter → MemoryProvider
│   ├── rag-tools.ts           #   Vector/graph RAG query tools
│   ├── eval-scorer.ts         #   Post-workflow scoring
│   └── voice-tools.ts         #   TTS/STT as agent tools
│
├── orchestration/             # Multi-agent strategies
│   ├── strategy.ts            #   OrchestrationStrategy (abstract)
│   ├── roundrobin-strategy.ts
│   ├── random-strategy.ts
│   └── agent-strategy.ts      #   LLM-driven agent selection
│
├── registry/                  # Team agent discovery
│   └── agent-registry.ts      #   AgentRegistry (Dapr state-backed)
│
├── pubsub/                    # Messaging
│   ├── broadcast.ts           #   broadcastMessage() to team topic
│   └── direct-messaging.ts    #   sendMessageToAgent() via Dapr pub/sub
│
├── observability/
│   └── otel-setup.ts          #   OpenTelemetry initialization
│
└── service/                   # HTTP service layer
    ├── main.ts                #   Express server, initAgent(), routes
    ├── tools.ts               #   workspaceTools record, listTools()
    ├── sandbox-config.ts      #   K8s/local sandbox factory
    ├── k8s-sandbox.ts         #   K8s pod execution
    ├── k8s-remote-filesystem.ts
    ├── completion-publisher.ts #   Dapr event publishing
    ├── planner.ts             #   generatePlan() via AI SDK generateObject()
    ├── git-diff.ts            #   gitBaseline(), gitDiff()
    ├── event-bus.ts           #   EventBus for metrics + console interception
    └── types.ts               #   AgentEvent, DaprEvent
```

## Mastra Integration

All 9 Mastra adapters live in `src/mastra/`. Every Mastra package is an **optional peer dependency** — durable-agent builds and runs without any Mastra packages installed. Each adapter uses dynamic `import()` with `@ts-expect-error` and try/catch for graceful fallback.

### Adapter Summary

| Adapter | Package | Purpose | Activation |
|---------|---------|---------|------------|
| **Tool Adapter** | `@mastra/core` | Converts `createTool()` → `DurableAgentTool` | Programmatic |
| **Model Router** | (built-in) | Resolves `"openai/gpt-4o"` → `LanguageModel` | `MASTRA_MODEL_SPEC` env |
| **Workspace** | `@mastra/core` | Mastra Workspace auto-injected tools | `MASTRA_WORKSPACE=true` |
| **MCP Client** | `@mastra/mcp` | Discovers tools from MCP servers | `MCP_SERVERS` env |
| **Processors** | `@mastra/core` | Pre-LLM guardrails (injection, PII, moderation) | `MASTRA_PROCESSORS` env |
| **Memory** | `@mastra/memory` | Thread-based memory replacing ConversationListMemory | Programmatic via `mastra.memory` |
| **RAG Tools** | `@mastra/rag` | Vector/graph query tools | `MASTRA_RAG_TOOLS` env |
| **Eval Scorers** | `@mastra/evals` | Post-workflow quality scoring | `MASTRA_SCORERS` env |
| **Voice Tools** | `@mastra/core` | TTS/STT as agent tools | Programmatic via `mastra.voice` |

### Key Interfaces

```typescript
// Tool adapter — structural interface (no compile-time dep)
interface MastraToolLike {
  id: string;
  description?: string;
  inputSchema?: unknown;
  execute: (input: Record<string, unknown>, context?: unknown) => Promise<unknown>;
}

// adaptMastraTool strips the context param:
function adaptMastraTool(tool: MastraToolLike): DurableAgentTool

// Model router:
registerLlmProvider("openai", (id) => openai.chat(id));
resolveModel("openai/gpt-4o"); // → LanguageModel

// Processor pipeline (runs before callLlm):
await runInputProcessors(processors, messages);
// Throws ProcessorAbortError if content is blocked

// Memory adapter:
const adapter = new MastraMemoryAdapter(mastraMemory, sessionId);
// Maps workflow instance IDs to Mastra thread IDs
```

### DurableAgentOptions.mastra

```typescript
mastra?: {
  modelSpec?: string;              // "openai/gpt-4o"
  tools?: Record<string, unknown>; // Mastra createTool() objects
  workspace?: unknown;             // Mastra Workspace instance
  mcpClient?: unknown;             // MCP server configs
  processors?: unknown[];          // Pre-LLM guardrails
  memory?: unknown;                // Mastra Memory instance
  ragTools?: Record<string, unknown>;
  voice?: unknown;                 // Voice provider
  scorers?: unknown[];             // Post-workflow scorers
};
```

All fields use `unknown` to avoid compile-time Mastra dependencies. Runtime type narrowing happens in each adapter.

## Hard Constraints

These patterns are **immutable** — they ensure Dapr Workflow durability:

1. **Async generator pattern** — The workflow is a generator function; Dapr replays it on crash recovery
2. **All I/O in activities** — `yield ctx.callActivity()` is the only way to do non-deterministic work
3. **Schema-only tool declarations** — LLM gets schemas but not execute functions; the workflow orchestrates execution
4. **ETag-based optimistic concurrency** — All state mutations use ETag retry with jittered backoff
5. **Crash recovery repair** — `previousToolResults` from durable activity outputs repair Redis state after pod restart

## Testing

```bash
pnpm test            # 112 tests, 14 files
pnpm test:watch      # Watch mode
```

Test files in `tests/`:

| File | Tests | Coverage |
|------|-------|----------|
| `types.test.ts` | 9 | Type serialization, defaults |
| `memory.test.ts` | 7 | ConversationListMemory |
| `activities.test.ts` | 8 | Activity factories (runTool, saveToolResults, etc.) |
| `message-converter.test.ts` | 9 | AI SDK 6 message format conversion |
| `tool-declarations.test.ts` | 4 | Tool schema building |
| `config-defaults.test.ts` | 14 | DurableAgent configuration |
| `orchestration-strategies.test.ts` | 18 | RoundRobin, Random, Agent strategies |
| `etag-retry.test.ts` | 5 | ETag conflict retry logic |
| `mastra-tool-adapter.test.ts` | 5 | Mastra tool conversion |
| `mastra-model-router.test.ts` | 10 | Provider registration, model resolution |
| `mastra-processor-adapter.test.ts` | 6 | Pre-LLM processor pipeline |
| `mastra-memory-adapter.test.ts` | 9 | Mastra Memory → MemoryProvider bridge |
| `mastra-eval-scorer.test.ts` | 3 | Post-workflow scoring |
| `mastra-voice-tools.test.ts` | 5 | Voice tool creation |

## Dependencies

**Runtime (hard):**
- `@dapr/dapr` ^3.4.0 — Dapr SDK (workflows, activities, state, pub/sub)
- `ai` ^6.0.0 — AI SDK 6 (generateText, generateObject, tool declarations)
- `@ai-sdk/openai` ^3.0.0 — OpenAI provider
- `express` ^4.21.0 — HTTP server
- `nanoid` ^5.0.0 — ID generation
- `zod` ^3.23.0 — Schema validation

**Peer (all optional):**
- `@mastra/core` ^1.4.0 — Tools, workspace, processors
- `@mastra/mcp` ^1.0.0 — MCP client
- `@mastra/rag` ^1.0.0 — RAG tools
- `@mastra/memory` ^1.0.0 — Thread-based memory
- `@mastra/evals` ^1.0.0 — Eval scorers
