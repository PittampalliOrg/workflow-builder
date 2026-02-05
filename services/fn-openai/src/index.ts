/**
 * fn-openai OpenFunction
 *
 * A scale-to-zero function that handles OpenAI text and image generation.
 * Receives requests from the function-router with pre-fetched credentials.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { generateTextStep, type GenerateTextInput } from "./steps/generate-text.js";
import { generateImageStep, type GenerateImageInput } from "./steps/generate-image.js";
import type { ExecuteRequest, ExecuteResponse, OpenAICredentials } from "./types.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Request schema
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

// Normalize input field names (handle aliases)
function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };

  // Handle prompt aliases
  if (normalized.prompt && !normalized.aiPrompt) {
    normalized.aiPrompt = normalized.prompt;
  }
  if (normalized.prompt && !normalized.imagePrompt) {
    normalized.imagePrompt = normalized.prompt;
  }

  // Handle model aliases
  if (normalized.model && !normalized.aiModel) {
    normalized.aiModel = normalized.model;
  }
  if (normalized.model && !normalized.imageModel) {
    normalized.imageModel = normalized.model;
  }

  return normalized;
}

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
  });

  // Register CORS
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  });

  // Health routes
  app.get("/healthz", async (_request, reply) => {
    return reply.status(200).send({ status: "healthy" });
  });

  app.get("/readyz", async (_request, reply) => {
    return reply.status(200).send({ status: "ready" });
  });

  app.get("/health", async (_request, reply) => {
    return reply.status(200).send({ status: "healthy" });
  });

  // Execute route
  app.post<{ Body: ExecuteRequest }>("/execute", async (request, reply) => {
    // Validate request body
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

    console.log(`[fn-openai] Received request for step: ${body.step}`);
    console.log(`[fn-openai] Workflow: ${body.workflow_id}, Node: ${body.node_id}`);

    // Extract credentials
    const credentials: OpenAICredentials = {
      OPENAI_API_KEY: body.credentials?.OPENAI_API_KEY,
    };

    // Normalize input
    const normalizedInput = normalizeInput(body.input as Record<string, unknown>);

    let result: { success: boolean; data?: unknown; error?: string };

    switch (body.step) {
      case "generate-text":
        const textResult = await generateTextStep(
          normalizedInput as GenerateTextInput,
          credentials
        );
        if (textResult.success) {
          result = {
            success: true,
            data: "text" in textResult ? textResult.text : textResult.object,
          };
        } else {
          result = { success: false, error: textResult.error };
        }
        break;

      case "generate-image":
        const imageResult = await generateImageStep(
          normalizedInput as GenerateImageInput,
          credentials
        );
        if (imageResult.success) {
          result = { success: true, data: imageResult.base64 };
        } else {
          result = { success: false, error: imageResult.error };
        }
        break;

      default:
        result = {
          success: false,
          error: `Unknown step: ${body.step}. Available steps: generate-text, generate-image`,
        };
    }

    const duration_ms = Date.now() - startTime;
    const response: ExecuteResponse = {
      success: result.success,
      data: result.data,
      error: result.error,
      duration_ms,
    };

    console.log(`[fn-openai] Step ${body.step} completed: success=${result.success}, duration=${duration_ms}ms`);

    const statusCode = result.success ? 200 : 500;
    return reply.status(statusCode).send(response);
  });

  // Start server
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`fn-openai listening on ${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
