/**
 * fn-activepieces
 *
 * Generic executor for Activepieces piece actions.
 * Ships with 25 AP piece npm packages pre-installed.
 * Receives requests from the function-router with pre-fetched credentials.
 */

import { otelLogMixin } from "./otel.js";

import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { executeAction } from "./executor.js";
import { fetchOptions, type OptionsRequest } from "./options-executor.js";
import { listPieceNames } from "./piece-registry.js";
import type { ExecuteRequest, ExecuteResponse } from "./types.js";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const OPTIONS_TIMEOUT_MS = Number.parseInt(
	process.env.OPTIONS_TIMEOUT_MS || "20000",
	10,
);

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
			}),
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

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

async function main() {
	const app = Fastify({
		logger: {
			level: process.env.LOG_LEVEL || "info",
			mixin: otelLogMixin,
		},
	});

	// Register CORS
	await app.register(cors, {
		origin: true,
		methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		credentials: true,
	});

	// Health routes
	app.get("/healthz", async (_request, reply) =>
		reply.status(200).send({ status: "healthy" }),
	);

	app.get("/readyz", async (_request, reply) =>
		reply.status(200).send({ status: "ready" }),
	);

	app.get("/health", async (_request, reply) =>
		reply.status(200).send({ status: "healthy" }),
	);

	// List installed pieces
	app.get("/pieces", async (_request, reply) =>
		reply.status(200).send({
			pieces: listPieceNames(),
			count: listPieceNames().length,
		}),
	);

	// Options route — fetch dynamic dropdown options for a prop
	const OptionsRequestSchema = z.object({
		pieceName: z.string().min(1),
		actionName: z.string().min(1),
		propertyName: z.string().min(1),
		auth: z.unknown().optional(),
		input: z.record(z.string(), z.unknown()).default({}),
		searchValue: z.string().optional(),
	});

	app.post<{ Body: OptionsRequest }>("/options", async (request, reply) => {
		const parseResult = OptionsRequestSchema.safeParse(request.body);
		if (!parseResult.success) {
			return reply.status(400).send({
				error: "Validation failed",
				details: parseResult.error.issues,
			});
		}

		const body = parseResult.data as OptionsRequest;
		console.log(
			`[fn-activepieces] Fetching options for ${body.pieceName}/${body.actionName}.${body.propertyName}`,
		);

		try {
			const result = await withTimeout(
				fetchOptions(body),
				OPTIONS_TIMEOUT_MS,
				`Options resolver for ${body.pieceName}/${body.actionName}.${body.propertyName}`,
			);
			console.log(
				`[fn-activepieces] Options for ${body.propertyName}: ${result.options.length} items`,
			);
			return reply.status(200).send(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isTimeout = message.includes("timed out");
			console.error(
				`[fn-activepieces] Options fetch failed for ${body.pieceName}/${body.actionName}.${body.propertyName}:`,
				error,
			);
			return reply.status(isTimeout ? 504 : 500).send({
				error: message,
				options: [],
			});
		}
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

		const body = parseResult.data as ExecuteRequest;
		const startTime = Date.now();

		console.log(`[fn-activepieces] Received request for step: ${body.step}`);
		console.log(
			`[fn-activepieces] Workflow: ${body.workflow_id}, Node: ${body.node_id}`,
		);

		const result = await executeAction(body);

		const duration_ms = Date.now() - startTime;
		const response: ExecuteResponse & { pause?: unknown } = {
			success: result.success,
			data: result.data,
			error: result.error,
			duration_ms,
		};

		// Forward pause metadata (DELAY/WEBHOOK) for Dapr workflow handling
		if (result.pause) {
			response.pause = result.pause;
		}

		console.log(
			`[fn-activepieces] Step ${body.step} completed: success=${result.success}, duration=${duration_ms}ms`,
		);

		const statusCode = result.success ? 200 : 500;
		return reply.status(statusCode).send(response);
	});

	// Start server
	try {
		await app.listen({ port: PORT, host: HOST });
		console.log(`fn-activepieces listening on ${HOST}:${PORT}`);
		console.log(
			`Installed pieces: ${listPieceNames().join(", ")} (${listPieceNames().length} total)`,
		);
	} catch (err) {
		app.log.error(err);
		process.exit(1);
	}
}

main();
