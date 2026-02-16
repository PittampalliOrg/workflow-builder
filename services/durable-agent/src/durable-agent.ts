/**
 * DurableAgent — the main class that ties everything together.
 *
 * Composition-based design: holds references to DaprAgentState,
 * LlmAdapter, MemoryProvider, ToolRegistry, OrchestrationStrategy.
 *
 * Activities are bound via closures in the constructor.
 *
 * Mirrors Python DurableAgent at durable.py:72-1808.
 */

import {
  DaprClient,
  WorkflowRuntime,
  type WorkflowActivityContext,
} from "@dapr/dapr";
import type { LanguageModelV1 } from "ai";

import type { DurableAgentOptions } from "./config/agent-options.js";
import { OrchestrationMode } from "./config/execution-config.js";
import type { DurableAgentTool } from "./types/tool.js";

import { DaprAgentState } from "./state/dapr-state.js";
import { ConversationListMemory } from "./memory/conversation-list.js";
import type { MemoryProvider } from "./memory/memory-base.js";

import {
  createRecordInitialEntry,
  createCallLlm,
  createRunTool,
  createSaveToolResults,
  createFinalizeWorkflow,
} from "./workflow/activities.js";
import { createAgentWorkflow, type AgentActivities } from "./workflow/agent-workflow.js";
import { createOrchestrationWorkflow, type OrchestrationActivities } from "./workflow/orchestration-workflow.js";

import { OrchestrationStrategy } from "./orchestration/strategy.js";
import { RoundRobinOrchestrationStrategy } from "./orchestration/roundrobin-strategy.js";
import { RandomOrchestrationStrategy } from "./orchestration/random-strategy.js";
import { AgentOrchestrationStrategy } from "./orchestration/agent-strategy.js";

import { AgentRegistry } from "./registry/agent-registry.js";
import { broadcastMessage } from "./pubsub/broadcast.js";
import { sendMessageToAgent } from "./pubsub/direct-messaging.js";
import type { AgentRegistryEntry } from "./pubsub/direct-messaging.js";

import { initObservability } from "./observability/otel-setup.js";

export class DurableAgent {
  // Configuration
  readonly name: string;
  readonly role: string;
  readonly goal: string;
  readonly instructions: string;
  readonly model: LanguageModelV1;
  readonly tools: Record<string, DurableAgentTool>;
  readonly maxIterations: number;

  // Sub-components (composition)
  readonly stateManager: DaprAgentState;
  readonly memory: MemoryProvider;
  readonly registry: AgentRegistry | null;
  private orchestrationStrategy: OrchestrationStrategy | null = null;

  // Dapr infrastructure
  private daprClient: DaprClient;
  private storeName: string;
  private pubsubName: string | null;
  private agentTopic: string | null;
  private broadcastTopic: string | null;

  // Bound activities (closures over this agent instance)
  private boundRecordInitialEntry: ReturnType<typeof createRecordInitialEntry>;
  private boundCallLlm: ReturnType<typeof createCallLlm>;
  private boundRunTool: ReturnType<typeof createRunTool>;
  private boundSaveToolResults: ReturnType<typeof createSaveToolResults>;
  private boundFinalizeWorkflow: ReturnType<typeof createFinalizeWorkflow>;

  // Workflow generators
  readonly agentWorkflow: ReturnType<typeof createAgentWorkflow>;
  readonly orchestrationWorkflow: ReturnType<typeof createOrchestrationWorkflow> | null;

  // Runtime state
  private _runtime: WorkflowRuntime | null = null;
  private _registered = false;
  private _started = false;

  constructor(options: DurableAgentOptions) {
    // Validate required fields
    if (!options.name) throw new Error("DurableAgent requires a name");
    if (!options.model) throw new Error("DurableAgent requires a model");

    // Profile
    this.name = options.name;
    this.role = options.role ?? "assistant";
    this.goal = options.goal ?? "";
    this.instructions = options.instructions ?? "You are a helpful assistant.";
    this.model = options.model;
    this.tools = options.tools ?? {};
    this.maxIterations = options.execution?.maxIterations ?? 10;

    // Dapr infrastructure
    this.daprClient = new DaprClient();
    this.storeName = options.state?.storeName ?? "statestore";
    const stateKey =
      options.state?.stateKey ?? `${this.name}:workflow_state`;

    this.pubsubName = options.pubsub?.pubsubName ?? null;
    this.agentTopic = options.pubsub?.agentTopic ?? this.name;
    this.broadcastTopic = options.pubsub?.broadcastTopic ?? null;

    // State manager
    this.stateManager = new DaprAgentState(
      this.daprClient,
      this.storeName,
      stateKey,
    );

    // Memory (default: in-memory list)
    this.memory = new ConversationListMemory();

    // Registry
    if (options.registry) {
      this.registry = new AgentRegistry(
        this.daprClient,
        options.registry.storeName,
        options.registry.teamName,
      );
    } else {
      this.registry = null;
    }

    // Orchestration strategy
    if (options.execution?.orchestrationMode) {
      switch (options.execution.orchestrationMode) {
        case OrchestrationMode.ROUNDROBIN:
          this.orchestrationStrategy =
            new RoundRobinOrchestrationStrategy();
          break;
        case OrchestrationMode.RANDOM:
          this.orchestrationStrategy = new RandomOrchestrationStrategy();
          break;
        case OrchestrationMode.AGENT:
          this.orchestrationStrategy = new AgentOrchestrationStrategy();
          break;
        default:
          throw new Error(
            `Invalid orchestration mode: ${options.execution.orchestrationMode}`,
          );
      }
      this.orchestrationStrategy.orchestratorName = this.name;
    }

    // Observability
    initObservability(options.observability, this.name);

    // Bind activities via closures (replacing fragile initActivities pattern)
    this.boundRecordInitialEntry = createRecordInitialEntry(this.stateManager);
    this.boundCallLlm = createCallLlm(
      this.stateManager,
      this.model,
      this.instructions,
      this.tools,
      this.memory,
    );
    this.boundRunTool = createRunTool(this.tools);
    this.boundSaveToolResults = createSaveToolResults(
      this.stateManager,
      this.memory,
    );
    this.boundFinalizeWorkflow = createFinalizeWorkflow(this.stateManager);

    // Create agent workflow
    const activities: AgentActivities = {
      recordInitialEntry: this.boundRecordInitialEntry,
      callLlm: this.boundCallLlm,
      runTool: this.boundRunTool,
      saveToolResults: this.boundSaveToolResults,
      finalizeWorkflow: this.boundFinalizeWorkflow,
    };
    this.agentWorkflow = createAgentWorkflow(activities, this.maxIterations);

    // Create orchestration workflow if strategy is configured
    if (this.orchestrationStrategy) {
      const strategy = this.orchestrationStrategy;
      const agent = this;

      const orchestrationActivities: OrchestrationActivities = {
        ...activities,
        getAvailableAgents: this._createGetAvailableAgents(),
        initializeOrchestration: this._createInitializeOrchestration(strategy),
        selectNextAction: this._createSelectNextAction(strategy),
        processOrchestrationResponse:
          this._createProcessOrchestrationResponse(strategy),
        shouldContinueOrchestration:
          this._createShouldContinueOrchestration(strategy),
        finalizeOrchestration: this._createFinalizeOrchestration(strategy),
        invokeRemoteAgent: this._createInvokeRemoteAgent(),
      };

      this.orchestrationWorkflow = createOrchestrationWorkflow(
        orchestrationActivities,
        strategy,
        this.maxIterations,
      );
    } else {
      this.orchestrationWorkflow = null;
    }
  }

  // ------------------------------------------------------------------
  // Orchestration activity factories
  // ------------------------------------------------------------------

  private _createGetAvailableAgents() {
    const agent = this;
    return async function getAvailableAgents(
      _ctx: WorkflowActivityContext,
      _payload: Record<string, never>,
    ): Promise<{ metadata: Record<string, unknown>; formatted: string }> {
      if (!agent.registry) {
        return {
          metadata: {},
          formatted: "No available agents to assign tasks.",
        };
      }

      const agentsMetadata = await agent.registry.listTeamAgents(agent.name);
      if (Object.keys(agentsMetadata).length === 0) {
        return {
          metadata: {},
          formatted: "No available agents to assign tasks.",
        };
      }

      const lines: string[] = [];
      for (const [name, meta] of Object.entries(agentsMetadata)) {
        const role =
          (meta as AgentRegistryEntry).agent?.role ?? "Unknown role";
        const goal = (meta as AgentRegistryEntry).agent?.goal ?? "Unknown";
        lines.push(`- ${name}: ${role} (Goal: ${goal})`);
      }

      return {
        metadata: agentsMetadata as Record<string, unknown>,
        formatted: lines.join("\n"),
      };
    };
  }

  private _createInitializeOrchestration(strategy: OrchestrationStrategy) {
    return async function initializeOrchestration(
      _ctx: WorkflowActivityContext,
      payload: {
        task: string;
        agents: Record<string, unknown>;
        instanceId: string;
      },
    ): Promise<Record<string, unknown>> {
      return strategy.initialize(payload.task, payload.agents);
    };
  }

  private _createSelectNextAction(strategy: OrchestrationStrategy) {
    return async function selectNextAction(
      _ctx: WorkflowActivityContext,
      payload: {
        state: Record<string, unknown>;
        turn: number;
        task: string;
      },
    ): Promise<{
      agent: string;
      instruction: string;
      metadata?: Record<string, unknown>;
    }> {
      return strategy.selectNextAgent(payload.state, payload.turn);
    };
  }

  private _createProcessOrchestrationResponse(
    strategy: OrchestrationStrategy,
  ) {
    return async function processOrchestrationResponse(
      _ctx: WorkflowActivityContext,
      payload: {
        state: Record<string, unknown>;
        response: Record<string, unknown>;
        action: Record<string, unknown>;
        task: string;
      },
    ): Promise<{
      updated_state: Record<string, unknown>;
      verdict?: string;
    }> {
      return strategy.processResponse(payload.state, payload.response);
    };
  }

  private _createShouldContinueOrchestration(
    strategy: OrchestrationStrategy,
  ) {
    const maxIterations = this.maxIterations;
    return async function shouldContinueOrchestration(
      _ctx: WorkflowActivityContext,
      payload: { state: Record<string, unknown>; turn: number },
    ): Promise<boolean> {
      return strategy.shouldContinue(
        payload.state,
        payload.turn,
        maxIterations,
      );
    };
  }

  private _createFinalizeOrchestration(strategy: OrchestrationStrategy) {
    return async function finalizeOrchestration(
      _ctx: WorkflowActivityContext,
      payload: {
        state: Record<string, unknown>;
        task: string;
        instanceId: string;
      },
    ): Promise<{ role: string; content: string; name?: string }> {
      return strategy.finalize(payload.state);
    };
  }

  private _createInvokeRemoteAgent() {
    const daprClient = this.daprClient;
    return async function invokeRemoteAgent(
      _ctx: WorkflowActivityContext,
      payload: { appId: string; task: string },
    ): Promise<Record<string, unknown>> {
      // Use Dapr Service Invocation API for cross-service multi-agent
      // since JS SDK's callChildWorkflow doesn't support app_id
      try {
        const result = await daprClient.invoker.invoke(
          payload.appId,
          "run",
          { method: "POST", body: { task: payload.task } } as any,
        );
        return (result as Record<string, unknown>) ?? {
          role: "assistant",
          content: "Agent invocation completed.",
        };
      } catch (err) {
        console.error(
          `[invokeRemoteAgent] Failed to invoke ${payload.appId}: ${err}`,
        );
        return {
          role: "assistant",
          content: `Error invoking agent ${payload.appId}: ${String(err)}`,
        };
      }
    };
  }

  // ------------------------------------------------------------------
  // Runtime control (mirrors Python durable.py:1690-1808)
  // ------------------------------------------------------------------

  /**
   * Register this agent's workflows and activities with a runtime.
   */
  register(runtime: WorkflowRuntime): void {
    // Register the primary agent workflow
    runtime.registerWorkflow(this.agentWorkflow);

    // Register all standard activities
    runtime.registerActivity(this.boundRecordInitialEntry);
    runtime.registerActivity(this.boundCallLlm);
    runtime.registerActivity(this.boundRunTool);
    runtime.registerActivity(this.boundSaveToolResults);
    runtime.registerActivity(this.boundFinalizeWorkflow);

    // Register orchestration if configured
    if (this.orchestrationWorkflow && this.orchestrationStrategy) {
      runtime.registerWorkflow(this.orchestrationWorkflow);

      // Register orchestration activities
      const orchActivities = [
        this._createGetAvailableAgents(),
        this._createInitializeOrchestration(this.orchestrationStrategy),
        this._createSelectNextAction(this.orchestrationStrategy),
        this._createProcessOrchestrationResponse(this.orchestrationStrategy),
        this._createShouldContinueOrchestration(this.orchestrationStrategy),
        this._createFinalizeOrchestration(this.orchestrationStrategy),
        this._createInvokeRemoteAgent(),
      ];
      for (const activity of orchActivities) {
        runtime.registerActivity(activity);
      }
    }

    this._runtime = runtime;
    this._registered = true;
    console.log(
      `[DurableAgent] Registered '${this.name}' workflows and activities`,
    );
  }

  /**
   * Start the workflow runtime.
   * Creates a new runtime if none was provided via register().
   */
  async start(): Promise<void> {
    if (this._started) {
      throw new Error(`Agent '${this.name}' has already been started.`);
    }

    if (!this._runtime) {
      this._runtime = new WorkflowRuntime();
    }

    if (!this._registered) {
      this.register(this._runtime);
    }

    await this._runtime.start();
    this._started = true;
    console.log(`[DurableAgent] '${this.name}' workflow runtime started`);

    // Register with team registry if configured
    if (this.registry) {
      try {
        const metadata: AgentRegistryEntry = {
          agent: {
            type: "DurableAgent",
            role: this.role,
            goal: this.goal,
          },
        };
        if (this.pubsubName) {
          metadata.pubsub = {
            name: this.pubsubName,
            agent_topic: this.agentTopic ?? this.name,
            broadcast_topic: this.broadcastTopic ?? undefined,
          };
        }
        await this.registry.registerAgent(this.name, metadata);
      } catch (err) {
        console.warn(
          `[DurableAgent] Failed to register in team registry: ${err}`,
        );
      }
    }
  }

  /**
   * Stop the workflow runtime.
   */
  async stop(): Promise<void> {
    if (!this._started) return;

    // Deregister from team registry
    if (this.registry) {
      try {
        await this.registry.deregisterAgent(this.name);
      } catch (err) {
        console.warn(
          `[DurableAgent] Failed to deregister from team registry: ${err}`,
        );
      }
    }

    if (this._runtime) {
      try {
        await this._runtime.stop();
      } catch (err) {
        console.warn(`[DurableAgent] Error stopping runtime: ${err}`);
      }
    }

    this._started = false;
    console.log(`[DurableAgent] '${this.name}' stopped`);
  }

  /** Whether the runtime has been started. */
  get isStarted(): boolean {
    return this._started;
  }

  /** Get the underlying workflow runtime. */
  get runtime(): WorkflowRuntime | null {
    return this._runtime;
  }
}
