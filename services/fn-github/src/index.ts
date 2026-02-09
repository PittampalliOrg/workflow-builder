/**
 * fn-github OpenFunction
 *
 * A scale-to-zero function that handles GitHub operations.
 * Receives requests from the function-router with pre-fetched credentials.
 */

import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import {
  type CreateIssueInput,
  createIssueStep,
} from "./steps/create-issue.js";
import { type GetIssueInput, getIssueStep } from "./steps/get-issue.js";
import { type ListIssuesInput, listIssuesStep } from "./steps/list-issues.js";
import type {
  ExecuteRequest,
  ExecuteResponse,
  GitHubCredentials,
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

    console.log(`[fn-github] Received request for step: ${body.step}`);
    console.log(
      `[fn-github] Workflow: ${body.workflow_id}, Node: ${body.node_id}`
    );

    const credentials: GitHubCredentials = {
      GITHUB_TOKEN: body.credentials?.GITHUB_TOKEN,
    };

    const input = body.input as Record<string, unknown>;

    let result: { success: boolean; data?: unknown; error?: string };

    switch (body.step) {
      case "create-issue": {
        const createResult = await createIssueStep(
          input as CreateIssueInput,
          credentials
        );
        if (createResult.success) {
          result = {
            success: true,
            data: {
              id: createResult.id,
              number: createResult.number,
              title: createResult.title,
              url: createResult.url,
              state: createResult.state,
            },
          };
        } else {
          result = { success: false, error: createResult.error };
        }
        break;
      }

      case "list-issues": {
        const listResult = await listIssuesStep(
          input as ListIssuesInput,
          credentials
        );
        if (listResult.success) {
          result = {
            success: true,
            data: { issues: listResult.issues, count: listResult.count },
          };
        } else {
          result = { success: false, error: listResult.error };
        }
        break;
      }

      case "get-issue": {
        const getResult = await getIssueStep(
          input as GetIssueInput,
          credentials
        );
        if (getResult.success) {
          result = {
            success: true,
            data: {
              id: getResult.id,
              number: getResult.number,
              title: getResult.title,
              url: getResult.url,
              state: getResult.state,
              body: getResult.body,
              labels: getResult.labels,
              assignees: getResult.assignees,
              author: getResult.author,
              createdAt: getResult.createdAt,
              updatedAt: getResult.updatedAt,
              closedAt: getResult.closedAt,
              commentsCount: getResult.commentsCount,
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
          error: `Unknown step: ${body.step}. Available steps: create-issue, list-issues, get-issue`,
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
      `[fn-github] Step ${body.step} completed: success=${result.success}, duration=${duration_ms}ms`
    );

    const statusCode = result.success ? 200 : 500;
    return reply.status(statusCode).send(response);
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`fn-github listening on ${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
