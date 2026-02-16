import { otelLogMixin } from "./otel.js";

/**
 * Function Router Service
 *
 * A thin dispatcher that routes function execution requests to:
 * - Knative Services (fn-openai, fn-slack, etc.) for scale-to-zero execution
 * - function-runner for builtin handler fallback
 *
 * The router also pre-fetches credentials from Dapr secret store
 * to avoid each function needing direct secret store access.
 */

import cors from "@fastify/cors";
import Fastify from "fastify";
import { executeRoutes } from "./routes/execute.js";
import { externalEventRoutes } from "./routes/external-event.js";
import { healthRoutes } from "./routes/health.js";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";

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

	// Register routes
	await app.register(healthRoutes);
	await app.register(executeRoutes);
	await app.register(externalEventRoutes);

	// Start server
	try {
		await app.listen({ port: PORT, host: HOST });
		console.log(`Function Router listening on ${HOST}:${PORT}`);
		console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
		console.log(`Dapr HTTP port: ${process.env.DAPR_HTTP_PORT || "3500"}`);
		console.log(
			`Registry file: ${process.env.REGISTRY_FILE_PATH || "/config/functions.json"}`,
		);
	} catch (err) {
		app.log.error(err);
		process.exit(1);
	}
}

main();
