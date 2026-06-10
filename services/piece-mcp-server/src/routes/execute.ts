/**
 * POST /execute — deterministic action execution for SW 1.0 workflow
 * activities (orchestrator → function-router → this service).
 *
 * Auth resolution priority:
 *  1. X-Connection-External-Id header (reference-forwarding; resolved
 *     via auth-resolver against the BFF decrypt endpoint — same path
 *     the MCP tools use)
 *  2. body.credentials_raw — raw AppConnectionValue (legacy router contract)
 *  3. body.credentials — env-var-mapped credentials (legacy, wrapped as
 *     SECRET_TEXT when single-valued)
 */

import type http from "node:http";
import { z } from "zod";
import type { Piece } from "@activepieces/pieces-framework";
import { resolveAuth } from "../auth-resolver.js";
import { resolveRuntimeAction, runPieceAction } from "../executor.js";
import { normalizePieceName } from "../piece-registry.js";
import type { PieceMetadataRow } from "../piece-to-mcp.js";
import { setSpanInput, setSpanOutput } from "../observability/content.js";

const ExecuteRequestSchema = z.object({
	step: z.string().min(1),
	execution_id: z.string().min(1),
	workflow_id: z.string().min(1),
	node_id: z.string().min(1),
	input: z.record(z.string(), z.unknown()).default({}),
	node_outputs: z
		.record(z.string(), z.object({ label: z.string(), data: z.unknown() }))
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

export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

type ExecuteDeps = {
	piece: Piece;
	pieceName: string;
	metadata: PieceMetadataRow;
};

function sendJson(
	res: http.ServerResponse,
	status: number,
	data: unknown,
): void {
	setSpanOutput(data);
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

/**
 * Resolve pieceName/actionName from the request.
 * Priority: explicit metadata > "pieceName/actionName" step format >
 * metadata.pieceName + step as actionName.
 */
function resolveNames(request: ExecuteRequest): {
	pieceName: string;
	actionName: string;
} {
	if (request.metadata?.pieceName && request.metadata?.actionName) {
		return {
			pieceName: request.metadata.pieceName,
			actionName: request.metadata.actionName,
		};
	}

	const slashIdx = request.step.indexOf("/");
	if (slashIdx > 0) {
		return {
			pieceName: request.step.slice(0, slashIdx),
			actionName: request.step.slice(slashIdx + 1),
		};
	}

	if (request.metadata?.pieceName) {
		return {
			pieceName: request.metadata.pieceName,
			actionName: request.step,
		};
	}

	throw new Error(
		`Cannot resolve piece and action names from step "${request.step}". ` +
			`Provide metadata.pieceName/actionName or use "pieceName/actionName" format.`,
	);
}

/**
 * Resolve auth for the deterministic path. The header-scoped connection
 * reference (already in AsyncLocalStorage via runWithRequestAuthContext)
 * wins; legacy body credentials are accepted for rollout compatibility.
 */
async function resolveExecuteAuth(request: ExecuteRequest): Promise<unknown> {
	const fromConnection = await resolveAuth();
	if (fromConnection != null) {
		return fromConnection;
	}

	if (request.credentials_raw != null) {
		return request.credentials_raw;
	}

	if (request.credentials && Object.keys(request.credentials).length > 0) {
		const values = Object.values(request.credentials);
		if (values.length === 1) {
			return { type: "SECRET_TEXT", secret_text: values[0] };
		}
		return request.credentials;
	}

	return undefined;
}

export async function handleExecute(
	_req: http.IncomingMessage,
	res: http.ServerResponse,
	body: unknown,
	deps: ExecuteDeps,
): Promise<void> {
	const startTime = Date.now();

	const parseResult = ExecuteRequestSchema.safeParse(body);
	if (!parseResult.success) {
		sendJson(res, 400, {
			success: false,
			error: "Validation failed",
			details: parseResult.error.issues,
			duration_ms: 0,
		});
		return;
	}

	const request = parseResult.data;
	setSpanInput({
		step: request.step,
		workflow_id: request.workflow_id,
		node_id: request.node_id,
		input: request.input,
		metadata: request.metadata,
	});

	if (request.step.startsWith("_code/")) {
		sendJson(res, 400, {
			success: false,
			error:
				"CODE steps are not executed by the piece-runtime; route _code/* to code-runtime.",
			duration_ms: Date.now() - startTime,
		});
		return;
	}

	let names: { pieceName: string; actionName: string };
	try {
		names = resolveNames(request);
	} catch (error) {
		sendJson(res, 400, {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			duration_ms: Date.now() - startTime,
		});
		return;
	}

	// This service hosts exactly ONE piece (PIECE_NAME); reject cross-piece steps.
	if (normalizePieceName(names.pieceName) !== normalizePieceName(deps.pieceName)) {
		sendJson(res, 400, {
			success: false,
			error:
				`Step targets piece "${names.pieceName}" but this runtime serves "${deps.pieceName}". ` +
				"function-router should dispatch to the matching ap-<piece>-service.",
			duration_ms: Date.now() - startTime,
		});
		return;
	}

	const resolved = resolveRuntimeAction(
		deps.piece,
		normalizePieceName(deps.pieceName),
		names.actionName,
	);
	if (!resolved) {
		sendJson(res, 404, {
			success: false,
			error:
				`Action "${names.actionName}" not found in piece "${deps.pieceName}". ` +
				"Check the piece metadata for available action names.",
			duration_ms: Date.now() - startTime,
		});
		return;
	}

	// Metadata actions JSONB is the schema SSOT — let it override requireAuth
	// when present (extensions stay always-auth).
	const actionDef = deps.metadata.actions?.[names.actionName];
	const requireAuth = resolved.isExtension
		? true
		: (actionDef?.requireAuth ?? resolved.requireAuth) !== false;

	const auth = await resolveExecuteAuth(request);

	console.log(
		`[piece-runtime] Executing ${names.pieceName}/${names.actionName} ` +
			`(workflow=${request.workflow_id}, node=${request.node_id}, ` +
			`authSource=${auth == null ? "none" : "resolved"})`,
	);

	const result = await runPieceAction({
		runtimeAction: resolved.runtimeAction,
		actionName: names.actionName,
		auth,
		requireAuth,
		input: request.input,
		executionId: request.execution_id,
	});

	const duration_ms = Date.now() - startTime;
	const response: Record<string, unknown> = {
		success: result.success,
		data: result.data,
		error: result.error,
		duration_ms,
		pieceVersion: deps.metadata.version ?? undefined,
	};
	if (result.pause) {
		response.pause = result.pause;
	}

	console.log(
		`[piece-runtime] Step ${request.step} completed: success=${result.success}, duration=${duration_ms}ms`,
	);

	sendJson(res, result.success ? 200 : 500, response);
}
