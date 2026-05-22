/**
 * fn-system
 *
 * Built-in system actions executed as a scale-to-zero Knative Service.
 *
 * Supported steps:
 * - http-request
 * - database-query
 * - condition
 * - dapr-converse-structured-output
 * - apns-send
 */

import { otelLogMixin } from "./otel.js";
import { setSpanInput, setSpanOutput } from "./observability/content.js";

import cors from "@fastify/cors";
import Fastify from "fastify";
import { z } from "zod";
import {
	APNS_SEND_ACTIONS,
	apnsSendStep,
	ApnsSendInputSchema,
} from "./steps/apns-send.js";
import { conditionStep, ConditionInputSchema } from "./steps/condition.js";
import {
	databaseQueryStep,
	DatabaseQueryInputSchema,
} from "./steps/database-query.js";
import {
	DAPR_CONVERSE_STRUCTURED_OUTPUT_ACTIONS,
	daprConverseStructuredOutputStep,
	DaprConverseStructuredOutputInputSchema,
} from "./steps/dapr-converse-structured-output.js";
import {
	httpRequestStep,
	HttpRequestInputSchema,
} from "./steps/http-request.js";
import type { ExecuteRequest, ExecuteResponse } from "./types.js";

const ALL_ACTIONS = [
	...DAPR_CONVERSE_STRUCTURED_OUTPUT_ACTIONS,
	...APNS_SEND_ACTIONS,
] as const;

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

	app.get("/api/runtime/introspect", async (_request, reply) =>
		reply.status(200).send({
			service: "fn-system",
			version: "1.0.0",
			runtime: "node-dapr-conversation",
			ready: true,
			features: [
				"system-actions",
				"dapr-conversation-alpha2",
				"structured-output",
				"apple-push-notifications",
			],
			registeredWorkflows: [],
			registeredActivities: ALL_ACTIONS.map((action) => ({
				id: action.id,
				name: action.name,
				displayName: action.displayName,
				description: action.description,
				doc: null,
				sourceCode: null,
				sourceHtml: null,
			})),
			additional: {
				steps: [
					"http-request",
					"database-query",
					"condition",
					"dapr-converse-structured-output",
					"apns-send",
				],
			},
		}),
	);

	app.get("/api/metadata/actions", async (_request, reply) =>
		reply.status(200).send({
			service: "fn-system",
			runtime: "node-dapr-conversation",
			ready: true,
			features: [
				"system-actions",
				"dapr-conversation-alpha2",
				"structured-output",
				"apple-push-notifications",
			],
			actions: ALL_ACTIONS,
			count: ALL_ACTIONS.length,
		}),
	);

	app.get<{ Params: { id: string } }>(
		"/api/metadata/actions/:id",
		async (request, reply) => {
			const action = ALL_ACTIONS.find(
				(item) => item.id === request.params.id || item.name === request.params.id,
			);
			if (!action) {
				return reply.status(404).send({
					error: `Action ${request.params.id} not found`,
				});
			}
			return reply.status(200).send({
				service: "fn-system",
				runtime: "node-dapr-conversation",
				action,
			});
		},
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
		// Stamp the step input as `input.value` (redacted) for the Service Graph drawer.
		setSpanInput(body.input);
		const startTime = Date.now();

		let result: { success: boolean; data?: unknown; error?: string };

		switch (body.step) {
			case "http-request": {
				const input = HttpRequestInputSchema.safeParse(body.input);
				if (!input.success) {
					result = { success: false, error: "Invalid input for http-request" };
					break;
				}
				const r = await httpRequestStep(input.data, body.credentials);
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

			case "dapr-converse-structured-output": {
				const input = DaprConverseStructuredOutputInputSchema.safeParse(
					body.input,
				);
				if (!input.success) {
					result = {
						success: false,
						error: `Invalid input for dapr-converse-structured-output: ${input.error.issues.map((issue) => issue.message).join("; ")}`,
					};
					break;
				}
				const r = await daprConverseStructuredOutputStep(input.data);
				result = r.success
					? { success: true, data: r.data }
					: { success: false, error: r.error };
				break;
			}

			case "apns-send": {
				const input = ApnsSendInputSchema.safeParse(body.input);
				if (!input.success) {
					result = {
						success: false,
						error: `Invalid input for apns-send: ${input.error.issues.map((issue) => issue.message).join("; ")}`,
					};
					break;
				}
				const r = await apnsSendStep(input.data);
				result = r.success
					? { success: true, data: r.data }
					: { success: false, error: r.error };
				break;
			}

			default:
				result = {
					success: false,
					error: `Unknown step: ${body.step}. Available steps: http-request, database-query, condition, dapr-converse-structured-output, apns-send`,
				};
		}

		const duration_ms = Date.now() - startTime;
		const response: ExecuteResponse = {
			success: result.success,
			data: result.data,
			error: result.error,
			duration_ms,
		};

		// Stamp the step result as `output.value` (redacted) for the drawer.
		setSpanOutput(response);
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
