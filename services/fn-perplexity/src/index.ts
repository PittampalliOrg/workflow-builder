/**
 * fn-perplexity OpenFunction
 *
 * A scale-to-zero function that handles Perplexity AI queries.
 * Receives requests from the function-router with pre-fetched credentials.
 */

import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { type AskInput, askStep } from "./steps/ask.js";
import { type SearchInput, searchStep } from "./steps/search.js";
import type {
  ExecuteRequest,
  ExecuteResponse,
  PerplexityCredentials,
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

    console.log(`[fn-perplexity] Received request for step: ${body.step}`);
    console.log(
      `[fn-perplexity] Workflow: ${body.workflow_id}, Node: ${body.node_id}`
    );

    const credentials: PerplexityCredentials = {
      PERPLEXITY_API_KEY: body.credentials?.PERPLEXITY_API_KEY,
    };

    const input = body.input as Record<string, unknown>;

    let result: { success: boolean; data?: unknown; error?: string };

    switch (body.step) {
      case "search": {
        const searchResult = await searchStep(
          input as SearchInput,
          credentials
        );
        if (searchResult.success) {
          result = {
            success: true,
            data: {
              answer: searchResult.answer,
              citations: searchResult.citations,
              model: searchResult.model,
            },
          };
        } else {
          result = { success: false, error: searchResult.error };
        }
        break;
      }

      case "ask": {
        const askResult = await askStep(input as AskInput, credentials);
        if (askResult.success) {
          result = {
            success: true,
            data: {
              answer: askResult.answer,
              citations: askResult.citations,
              model: askResult.model,
            },
          };
        } else {
          result = { success: false, error: askResult.error };
        }
        break;
      }

      default:
        result = {
          success: false,
          error: `Unknown step: ${body.step}. Available steps: search, ask`,
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
      `[fn-perplexity] Step ${body.step} completed: success=${result.success}, duration=${duration_ms}ms`
    );

    const statusCode = result.success ? 200 : 500;
    return reply.status(statusCode).send(response);
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`fn-perplexity listening on ${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
