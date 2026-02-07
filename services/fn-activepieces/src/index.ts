/**
 * fn-activepieces
 *
 * Generic executor for Activepieces piece actions.
 * Ships with 25 AP piece npm packages pre-installed.
 * Receives requests from the function-router with pre-fetched credentials.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { executeAction } from './executor.js';
import { fetchOptions, type OptionsRequest } from './options-executor.js';
import { listPieceNames } from './piece-registry.js';
import type { ExecuteRequest, ExecuteResponse } from './types.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

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
  credentials_raw: z.unknown().optional(),
  metadata: z
    .object({
      pieceName: z.string(),
      actionName: z.string(),
    })
    .optional(),
});

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // Register CORS
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // Health routes
  app.get('/healthz', async (_request, reply) => {
    return reply.status(200).send({ status: 'healthy' });
  });

  app.get('/readyz', async (_request, reply) => {
    return reply.status(200).send({ status: 'ready' });
  });

  app.get('/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'healthy' });
  });

  // List installed pieces
  app.get('/pieces', async (_request, reply) => {
    return reply.status(200).send({
      pieces: listPieceNames(),
      count: listPieceNames().length,
    });
  });

  // Options route — fetch dynamic dropdown options for a prop
  const OptionsRequestSchema = z.object({
    pieceName: z.string().min(1),
    actionName: z.string().min(1),
    propertyName: z.string().min(1),
    auth: z.unknown().optional(),
    input: z.record(z.string(), z.unknown()).default({}),
    searchValue: z.string().optional(),
  });

  app.post<{ Body: OptionsRequest }>('/options', async (request, reply) => {
    const parseResult = OptionsRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    const body = parseResult.data as OptionsRequest;
    console.log(
      `[fn-activepieces] Fetching options for ${body.pieceName}/${body.actionName}.${body.propertyName}`
    );

    try {
      const result = await fetchOptions(body);
      console.log(
        `[fn-activepieces] Options for ${body.propertyName}: ${result.options.length} items`
      );
      return reply.status(200).send(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[fn-activepieces] Options fetch failed for ${body.pieceName}/${body.actionName}.${body.propertyName}:`,
        error
      );
      return reply.status(500).send({
        error: message,
        options: [],
      });
    }
  });

  // Execute route
  app.post<{ Body: ExecuteRequest }>('/execute', async (request, reply) => {
    // Validate request body
    const parseResult = ExecuteRequestSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'Validation failed',
        details: parseResult.error.issues,
        duration_ms: 0,
      } as ExecuteResponse);
    }

    const body = parseResult.data as ExecuteRequest;
    const startTime = Date.now();

    console.log(`[fn-activepieces] Received request for step: ${body.step}`);
    console.log(
      `[fn-activepieces] Workflow: ${body.workflow_id}, Node: ${body.node_id}`
    );

    const result = await executeAction(body);

    const duration_ms = Date.now() - startTime;
    const response: ExecuteResponse = {
      success: result.success,
      data: result.data,
      error: result.error,
      duration_ms,
    };

    console.log(
      `[fn-activepieces] Step ${body.step} completed: success=${result.success}, duration=${duration_ms}ms`
    );

    const statusCode = result.success ? 200 : 500;
    return reply.status(statusCode).send(response);
  });

  // Start server
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`fn-activepieces listening on ${HOST}:${PORT}`);
    console.log(
      `Installed pieces: ${listPieceNames().join(', ')} (${listPieceNames().length} total)`
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
