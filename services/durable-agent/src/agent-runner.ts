/**
 * AgentRunner — Express HTTP server + lifecycle management.
 *
 * Provides the HTTP interface for scheduling and querying workflows.
 * Mirrors Python AgentRunner.
 */

import express, { type Request, type Response } from "express";
import { DaprWorkflowClient } from "@dapr/dapr";
import type { DurableAgent } from "./durable-agent.js";

export interface AgentRunnerOptions {
  /** HTTP server port. Default: 8001. */
  port?: number;
}

export class AgentRunner {
  private agent: DurableAgent;
  private port: number;
  private workflowClient: DaprWorkflowClient | null = null;
  private server: ReturnType<typeof express> | null = null;

  constructor(agent: DurableAgent, options?: AgentRunnerOptions) {
    this.agent = agent;
    this.port = options?.port ?? 8001;
  }

  /**
   * Start the agent runtime and HTTP server.
   */
  async start(): Promise<void> {
    // Start the agent workflow runtime
    await this.agent.start();

    // Create workflow client for scheduling/querying
    this.workflowClient = new DaprWorkflowClient();

    // Create Express server
    const app = express();
    app.use(express.json());

    // POST /run — schedule a new workflow
    app.post("/run", async (req: Request, res: Response) => {
      try {
        const task: string | undefined = req.body?.task;
        if (!task) {
          res.status(400).json({ error: "Missing 'task' in request body" });
          return;
        }

        const instanceId = await this.workflowClient!.scheduleNewWorkflow(
          this.agent.agentWorkflow,
          { task },
        );

        console.log(
          `[AgentRunner] Scheduled workflow instance=${instanceId} task="${task}"`,
        );
        res.status(202).json({
          instance_id: instanceId,
          status: "running",
          status_url: `/run/${instanceId}`,
        });
      } catch (err) {
        console.error("[AgentRunner] Failed to schedule workflow:", err);
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /run/:id — check workflow status / get result
    app.get("/run/:id", async (req: Request, res: Response) => {
      try {
        const instanceId = req.params.id;
        const state = await this.workflowClient!.getWorkflowState(
          instanceId,
          true,
        );

        if (!state) {
          res.status(404).json({ error: "Workflow not found" });
          return;
        }

        res.json({
          instance_id: instanceId,
          status: state.runtimeStatus,
          created_at: state.createdAt,
          last_updated: state.lastUpdatedAt,
          result: state.serializedOutput
            ? JSON.parse(state.serializedOutput)
            : null,
        });
      } catch (err) {
        console.error("[AgentRunner] Failed to get workflow state:", err);
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /health — liveness probe
    app.get("/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        agent: this.agent.name,
        started: this.agent.isStarted,
      });
    });

    // Start listening
    await new Promise<void>((resolve) => {
      this.server = app;
      app.listen(this.port, () => {
        console.log(
          `[AgentRunner] '${this.agent.name}' listening on http://localhost:${this.port}`,
        );
        console.log(
          `[AgentRunner]   POST http://localhost:${this.port}/run       — start workflow`,
        );
        console.log(
          `[AgentRunner]   GET  http://localhost:${this.port}/run/:id   — check status`,
        );
        console.log(
          `[AgentRunner]   GET  http://localhost:${this.port}/health    — health check`,
        );
        resolve();
      });
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log(`\n[AgentRunner] Shutting down '${this.agent.name}'...`);
      await this.agent.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  /**
   * Stop the agent and HTTP server.
   */
  async stop(): Promise<void> {
    await this.agent.stop();
    console.log(`[AgentRunner] '${this.agent.name}' stopped`);
  }
}
