/**
 * fn-stripe OpenFunction
 *
 * A scale-to-zero function that handles Stripe customer operations.
 * Receives requests from the function-router with pre-fetched credentials.
 */

import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import {
  type CreateCustomerInput,
  createCustomerStep,
} from "./steps/create-customer.js";
import {
  type GetCustomerInput,
  getCustomerStep,
} from "./steps/get-customer.js";
import type {
  ExecuteRequest,
  ExecuteResponse,
  StripeCredentials,
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

    console.log(`[fn-stripe] Received request for step: ${body.step}`);
    console.log(
      `[fn-stripe] Workflow: ${body.workflow_id}, Node: ${body.node_id}`
    );

    const credentials: StripeCredentials = {
      STRIPE_SECRET_KEY: body.credentials?.STRIPE_SECRET_KEY,
    };

    const input = body.input as Record<string, unknown>;

    let result: { success: boolean; data?: unknown; error?: string };

    switch (body.step) {
      case "create-customer": {
        const createResult = await createCustomerStep(
          input as CreateCustomerInput,
          credentials
        );
        if (createResult.success) {
          result = {
            success: true,
            data: { id: createResult.id, email: createResult.email },
          };
        } else {
          result = { success: false, error: createResult.error };
        }
        break;
      }

      case "get-customer": {
        const getResult = await getCustomerStep(
          input as GetCustomerInput,
          credentials
        );
        if (getResult.success) {
          result = {
            success: true,
            data: {
              id: getResult.id,
              email: getResult.email,
              name: getResult.name,
              created: getResult.created,
            },
          };
        } else {
          result = { success: false, error: getResult.error };
        }
        break;
      }

      default:
        result = {
          success: false,
          error: `Unknown step: ${body.step}. Available steps: create-customer, get-customer`,
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
      `[fn-stripe] Step ${body.step} completed: success=${result.success}, duration=${duration_ms}ms`
    );

    const statusCode = result.success ? 200 : 500;
    return reply.status(statusCode).send(response);
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`fn-stripe listening on ${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
