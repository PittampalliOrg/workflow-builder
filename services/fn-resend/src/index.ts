/**
 * fn-resend OpenFunction
 *
 * A scale-to-zero function that handles email sending via Resend.
 * Receives requests from the function-router with pre-fetched credentials.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { sendEmailStep, type SendEmailInput } from "./steps/send-email.js";
import type { ExecuteRequest, ExecuteResponse, ResendCredentials } from "./types.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
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

function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };

  // Handle common aliases
  if (normalized.to && !normalized.emailTo) {
    normalized.emailTo = normalized.to;
  }
  if (normalized.from && !normalized.emailFrom) {
    normalized.emailFrom = normalized.from;
  }
  if (normalized.subject && !normalized.emailSubject) {
    normalized.emailSubject = normalized.subject;
  }
  if (normalized.body && !normalized.emailBody) {
    normalized.emailBody = normalized.body;
  }
  if (normalized.text && !normalized.emailBody) {
    normalized.emailBody = normalized.text;
  }

  return normalized;
}

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

    console.log(`[fn-resend] Received request for step: ${body.step}`);
    console.log(`[fn-resend] Workflow: ${body.workflow_id}, Node: ${body.node_id}`);

    const credentials: ResendCredentials = {
      RESEND_API_KEY: body.credentials?.RESEND_API_KEY,
      RESEND_FROM_EMAIL: body.credentials?.RESEND_FROM_EMAIL,
    };

    const normalizedInput = normalizeInput(body.input as Record<string, unknown>);

    // Add execution_id as idempotency key if not provided
    if (!normalizedInput.idempotencyKey) {
      normalizedInput.idempotencyKey = body.execution_id;
    }

    let result: { success: boolean; data?: unknown; error?: string };

    switch (body.step) {
      case "send-email":
        const sendResult = await sendEmailStep(
          normalizedInput as SendEmailInput,
          credentials
        );
        if (sendResult.success) {
          result = { success: true, data: { id: sendResult.id } };
        } else {
          result = { success: false, error: sendResult.error };
        }
        break;

      default:
        result = {
          success: false,
          error: `Unknown step: ${body.step}. Available steps: send-email`,
        };
    }

    const duration_ms = Date.now() - startTime;
    const response: ExecuteResponse = {
      success: result.success,
      data: result.data,
      error: result.error,
      duration_ms,
    };

    console.log(`[fn-resend] Step ${body.step} completed: success=${result.success}, duration=${duration_ms}ms`);

    const statusCode = result.success ? 200 : 500;
    return reply.status(statusCode).send(response);
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`fn-resend listening on ${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
