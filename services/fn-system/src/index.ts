/**
 * fn-system
 *
 * Built-in system actions executed as a scale-to-zero Knative Service.
 *
 * Supported steps:
 * - http-request
 * - database-query
 * - condition
 */

import { otelLogMixin } from "./otel.js";

import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import { conditionStep, ConditionInputSchema } from "./steps/condition.js";
import {
	databaseQueryStep,
	DatabaseQueryInputSchema,
} from "./steps/database-query.js";
import {
	httpRequestStep,
	HttpRequestInputSchema,
} from "./steps/http-request.js";
import type { ExecuteRequest, ExecuteResponse } from "./types.js";

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
			}),
		)
		.optional(),
	credentials: z.record(z.string(), z.string()).optional(),
});

async function main() {
	const app = Fastify({
		logger: {
			level: process.env.LOG_LEVEL || "info",
			mixin: otelLogMixin,
		},
	});

	await app.register(cors, {
		origin: true,
		methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		credentials: true,
	});

	app.get("/healthz", async (_request, reply) =>
		reply.status(200).send({ status: "healthy" }),
	);

	app.get("/readyz", async (_request, reply) =>
		reply.status(200).send({ status: "ready" }),
	);

	app.get("/health", async (_request, reply) =>
		reply.status(200).send({ status: "healthy" }),
	);

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

		const body = parseResult.data as ExecuteRequest;
		const startTime = Date.now();

		let result: { success: boolean; data?: unknown; error?: string };

		switch (body.step) {
			case "http-request": {
				const input = HttpRequestInputSchema.safeParse(body.input);
				if (!input.success) {
					result = { success: false, error: "Invalid input for http-request" };
					break;
				}
				const r = await httpRequestStep(input.data);
				result = r.success
					? { success: true, data: r.data }
					: { success: false, error: r.error };
				break;
			}

			case "database-query": {
				const input = DatabaseQueryInputSchema.safeParse(body.input);
				if (!input.success) {
					result = {
						success: false,
						error: "Invalid input for database-query",
					};
					break;
				}
				const r = await databaseQueryStep(input.data, body.credentials);
				result = r.success
					? { success: true, data: r.data }
					: { success: false, error: r.error };
				break;
			}

			case "condition": {
				const input = ConditionInputSchema.safeParse(body.input);
				if (!input.success) {
					result = { success: false, error: "Invalid input for condition" };
					break;
				}
				const r = await conditionStep(input.data);
				result = r.success
					? { success: true, data: r.data }
					: { success: false, error: r.error };
				break;
			}

			default:
				result = {
					success: false,
					error: `Unknown step: ${body.step}. Available steps: http-request, database-query, condition`,
				};
		}

		const duration_ms = Date.now() - startTime;
		const response: ExecuteResponse = {
			success: result.success,
			data: result.data,
			error: result.error,
			duration_ms,
		};

		const statusCode = result.success ? 200 : 500;
		return reply.status(statusCode).send(response);
	});

	try {
		await app.listen({ port: PORT, host: HOST });
		console.log(`fn-system listening on ${HOST}:${PORT}`);
	} catch (err) {
		app.log.error(err);
		process.exit(1);
	}
}

main();
