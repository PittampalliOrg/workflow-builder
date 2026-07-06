/**
 * script-evaluator HTTP server.
 *
 * Stateless Node service that re-runs dynamic workflow scripts in a vm sandbox.
 * Called over plain HTTP by the workflow-orchestrator's evaluate_script activity
 * (no Dapr sidecar).
 *
 * ENV:
 *   PORT                    (default 3300)
 *   HOST                    (default 0.0.0.0)
 *   SCRIPT_MAX_BYTES        (default 262144) — /evaluate + /validate script cap
 *   SCRIPT_EVAL_TIMEOUT_MS  (default 10000)  — per-evaluation host deadline
 *   OTEL_*                  — standard OpenTelemetry exporter config
 */
import "./otel.js";

import http from "node:http";
import {
	EVALUATOR_VERSION,
	evaluateScript,
	validateScript,
	type EvaluateRequest,
} from "./sandbox.js";

const PORT = parseInt(process.env.PORT || "3300", 10);
const HOST = process.env.HOST || "0.0.0.0";
const SCRIPT_MAX_BYTES = parseInt(process.env.SCRIPT_MAX_BYTES || "262144", 10);
const REQUEST_MAX_BYTES = 24 * 1024 * 1024; // 24 MB request body limit

function sendJson(
	res: http.ServerResponse,
	status: number,
	data: unknown,
): void {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

class RequestTooLargeError extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > REQUEST_MAX_BYTES) {
				reject(new RequestTooLargeError("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

async function handleEvaluate(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	let raw: string;
	try {
		raw = await readBody(req);
	} catch (err) {
		if (err instanceof RequestTooLargeError) {
			sendJson(res, 413, { error: "request_too_large" });
			return;
		}
		sendJson(res, 400, { error: "read_error" });
		return;
	}

	let body: EvaluateRequest;
	try {
		body = JSON.parse(raw);
	} catch {
		sendJson(res, 400, { error: "invalid_json" });
		return;
	}

	if (typeof body?.script !== "string") {
		sendJson(res, 400, { error: "missing_script" });
		return;
	}
	if (Buffer.byteLength(body.script, "utf8") > SCRIPT_MAX_BYTES) {
		sendJson(res, 413, { error: "script_too_large" });
		return;
	}

	try {
		const result = await evaluateScript(body);
		sendJson(res, 200, result);
	} catch (err) {
		// Unexpected evaluator crash → 5xx (retryable per contract).
		console.error("[script-evaluator] evaluate crashed:", err);
		sendJson(res, 500, {
			error: "evaluator_error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

async function handleValidate(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	let raw: string;
	try {
		raw = await readBody(req);
	} catch (err) {
		if (err instanceof RequestTooLargeError) {
			sendJson(res, 413, { error: "request_too_large" });
			return;
		}
		sendJson(res, 400, { error: "read_error" });
		return;
	}

	let body: { script?: unknown };
	try {
		body = JSON.parse(raw);
	} catch {
		sendJson(res, 400, { error: "invalid_json" });
		return;
	}

	if (typeof body?.script !== "string") {
		sendJson(res, 400, { error: "missing_script" });
		return;
	}
	if (Buffer.byteLength(body.script, "utf8") > SCRIPT_MAX_BYTES) {
		sendJson(res, 413, { error: "script_too_large" });
		return;
	}

	try {
		const result = await validateScript(body.script);
		sendJson(res, 200, result);
	} catch (err) {
		console.error("[script-evaluator] validate crashed:", err);
		sendJson(res, 500, {
			error: "evaluator_error",
			message: err instanceof Error ? err.message : String(err),
		});
	}
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";
	const path = url.split("?")[0];

	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (path === "/healthz" && method === "GET") {
		sendJson(res, 200, { ok: true, evaluatorVersion: EVALUATOR_VERSION });
		return;
	}

	if (path === "/evaluate" && method === "POST") {
		await handleEvaluate(req, res);
		return;
	}

	if (path === "/validate" && method === "POST") {
		await handleValidate(req, res);
		return;
	}

	sendJson(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
	handleRequest(req, res).catch((err) => {
		console.error("[script-evaluator] unhandled error:", err);
		if (!res.headersSent) {
			sendJson(res, 500, { error: "internal_error" });
		}
	});
});

server.listen(PORT, HOST, () => {
	console.log(
		`[script-evaluator] listening on ${HOST}:${PORT} (evaluatorVersion=${EVALUATOR_VERSION})`,
	);
});

const shutdown = () => {
	server.close(() => process.exit(0));
	// Force-exit if connections linger past a grace period.
	setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
