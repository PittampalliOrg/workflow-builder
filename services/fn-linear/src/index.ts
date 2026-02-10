/**
 * fn-linear OpenFunction
 *
 * A scale-to-zero function that handles Linear ticket operations.
 * Receives requests from the function-router with pre-fetched credentials.
 */

import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import {
  type CreateTicketInput,
  createTicketStep,
} from "./steps/create-ticket.js";
import { type FindIssuesInput, findIssuesStep } from "./steps/find-issues.js";
import type {
  ExecuteRequest,
  ExecuteResponse,
  LinearCredentials,
} from "./types.js";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";

const ExecuteRequestSchema = z.object({
  step: z.string().min(1),
  execution_id: z.string().min(1),
  workflow_id: z.string().min(1),
  node_id: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  node_outputs: z
    .record(
      z.string(),
      z.object({
        label: z.string(),
        data: z.unknown(),
      })
    )
    .optional(),
  credentials: z.record(z.string(), z.string()).optional(),
});

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
  });

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  });

  // Health routes
  app.get("/healthz", async (_request, reply) =>
    reply.status(200).send({ status: "healthy" })
  );

  app.get("/readyz", async (_request, reply) =>
    reply.status(200).send({ status: "ready" })
  );

  app.get("/health", async (_request, reply) =>
    reply.status(200).send({ status: "healthy" })
  );

  // Execute route
  app.post<{ Body: ExecuteRequest }>("/execute", async (request, reply) => {
    const parseResult = ExecuteRequestSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: "Validation failed",
        details: parseResult.error.issues,
        duration_ms: 0,
      } as ExecuteResponse);
    }

    const body = parseResult.data;
    const startTime = Date.now();

    console.log(`[fn-linear] Received request for step: ${body.step}`);
    console.log(
      `[fn-linear] Workflow: ${body.workflow_id}, Node: ${body.node_id}`
    );

    const credentials: LinearCredentials = {
      LINEAR_API_KEY: body.credentials?.LINEAR_API_KEY,
      LINEAR_TEAM_ID: body.credentials?.LINEAR_TEAM_ID,
    };

    const input = body.input as Record<string, unknown>;

    let result: { success: boolean; data?: unknown; error?: string };

    switch (body.step) {
      case "create-ticket": {
        const createResult = await createTicketStep(
          input as CreateTicketInput,
          credentials
        );
        if (createResult.success) {
          result = {
            success: true,
            data: {
              id: createResult.id,
              url: createResult.url,
              title: createResult.title,
            },
          };
        } else {
          result = { success: false, error: createResult.error };
        }
        break;
      }

      case "find-issues": {
        const findResult = await findIssuesStep(
          input as FindIssuesInput,
          credentials
        );
        if (findResult.success) {
          result = {
            success: true,
            data: { issues: findResult.issues, count: findResult.count },
          };
        } else {
          result = { success: false, error: findResult.error };
        }
        break;
      }

      default:
        result = {
          success: false,
          error: `Unknown step: ${body.step}. Available steps: create-ticket, find-issues`,
        };
    }

    const duration_ms = Date.now() - startTime;
    const response: ExecuteResponse = {
      success: result.success,
      data: result.data,
      error: result.error,
      duration_ms,
    };

    console.log(
      `[fn-linear] Step ${body.step} completed: success=${result.success}, duration=${duration_ms}ms`
    );

    const statusCode = result.success ? 200 : 500;
    return reply.status(statusCode).send(response);
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`fn-linear listening on ${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
