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
 *
 * Durability semantics (Phase 2 — docs/activepieces-integration-architecture.md
 * §2.4/§3.1; /execute only, never the MCP path):
 *  - Idempotency gate on `idempotency_key` (orchestrator-minted, stable
 *    across retries AND replay) when DATABASE_URL is set: completed rows
 *    return the cached result (`deduped: true`); permanent failures return
 *    the cached failure; running/paused/retryable-failed proceed
 *    (at-least-once on mid-flight crash). Gate DB failures fail CLOSED as
 *    `errorClass: "retryable"` so the orchestrator retries.
 *  - Failures carry `errorClass`: "retryable" (429/5xx/network) vs
 *    "permanent" (4xx/validation/auth/unknown).
 *  - Results > MAX_INLINE_RESULT_BYTES (default 4 MiB) are offloaded to the
 *    piece_execution row; the response carries
 *    `{ artifactRef, preview, truncated: true }` instead of the full data.
 *  - `execution_type: "RESUME"` re-invocations expose `resume_payload`
 *    as ctx.resumePayload; ctx.store is Postgres-backed when a DB exists.
 */

import type http from "node:http";
import { z } from "zod";
import type { Piece } from "@activepieces/pieces-framework";
import { getRequestConnectionExternalId, resolveAuth } from "../auth-resolver.js";
import { getPool } from "../db.js";
import {
	claimIdempotency,
	finalizeIdempotency,
	type PieceExecutionIdentity,
} from "../idempotency.js";
import { resolveRuntimeAction, runPieceAction } from "../executor.js";
import { normalizePieceName } from "../piece-registry.js";
import type { PieceMetadataRow } from "../piece-to-mcp.js";
import {
	buildArtifactRefData,
	decideResultOffload,
	getMaxInlineResultBytes,
} from "../result-offload.js";
import { createPgStore } from "../store-adapter.js";
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
	// ── AP durability contract (orchestrator → function-router passthrough) ──
	/** Orchestrator-minted, stable across activity retries and replay. */
	idempotency_key: z.string().min(1).nullable().optional(),
	/** BEGIN (default) or RESUME (re-invocation after a DELAY/WEBHOOK pause). */
	execution_type: z.enum(["BEGIN", "RESUME"]).optional(),
	/** Webhook payload for RESUME — exposed as ctx.resumePayload. */
	resume_payload: z.unknown().optional(),
	/** workflow_executions.id — audit rows + resume URLs. */
	db_execution_id: z.string().nullable().optional(),
	/** Set by the orchestrator for actions marked idempotent — skips the gate. */
	skip_idempotency_gate: z.boolean().optional(),
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

/**
 * Apply the result-offload policy to a response's `data`.
 * Mutates `response.data` when offloading; logs loudly when an inline
 * payload approaches the 16 MiB Dapr body ceiling and offload is impossible.
 */
function applyResultOffload(
	response: Record<string, unknown>,
	opts: { idempotencyKey?: string | null; resultStored: boolean; step: string },
): void {
	if (response.data === undefined) return;
	const serialized = JSON.stringify(response.data) ?? "null";
	const decision = decideResultOffload(serialized, {
		canOffload: Boolean(opts.idempotencyKey) && opts.resultStored,
		maxInlineBytes: getMaxInlineResultBytes(),
	});
	if (decision.action === "offload") {
		console.log(
			`[piece-runtime] Offloading ${decision.sizeBytes}B result for ${opts.step} ` +
				`to piece_execution row (key=${opts.idempotencyKey})`,
		);
		response.data = buildArtifactRefData(
			opts.idempotencyKey as string,
			decision.preview,
		);
		return;
	}
	if (decision.oversized) {
		console.warn(
			`[piece-runtime] WARNING: inline result for ${opts.step} is ${decision.sizeBytes}B ` +
				`(>12MiB) and cannot be offloaded (no idempotency_key/DB) — the 16MiB Dapr ` +
				`leg may reject this response.`,
		);
	}
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
			errorClass: "permanent",
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
		idempotency_key: request.idempotency_key ?? undefined,
		execution_type: request.execution_type ?? undefined,
	});

	if (request.step.startsWith("_code/")) {
		sendJson(res, 400, {
			success: false,
			error:
				"CODE steps are not executed by the piece-runtime; route _code/* to code-runtime.",
			errorClass: "permanent",
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
			errorClass: "permanent",
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
			errorClass: "permanent",
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
			errorClass: "permanent",
			duration_ms: Date.now() - startTime,
		});
		return;
	}

	// ── Idempotency gate (deterministic path only — never MCP) ──────────
	const pool = getPool(); // null when DATABASE_URL is unset
	const idempotencyKey = request.idempotency_key ?? undefined;
	const identity: PieceExecutionIdentity | null = idempotencyKey
		? {
				idempotencyKey,
				workflowId: request.workflow_id,
				executionId: request.execution_id,
				dbExecutionId: request.db_execution_id ?? null,
				nodeId: request.node_id,
				pieceName: normalizePieceName(deps.pieceName),
				actionName: names.actionName,
				pieceVersion: deps.metadata.version ?? null,
				connectionExternalId: getRequestConnectionExternalId() ?? null,
			}
		: null;
	const gateActive =
		Boolean(pool && identity) && request.skip_idempotency_gate !== true;

	if (pool && identity && gateActive) {
		let claim: Awaited<ReturnType<typeof claimIdempotency>>;
		try {
			claim = await claimIdempotency(pool, identity);
		} catch (error) {
			// Fail closed: a DB blip must not allow a duplicate side effect.
			// "retryable" so the orchestrator's retry policy re-attempts.
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`[piece-runtime] Idempotency gate unavailable for ${request.step}:`,
				error,
			);
			sendJson(res, 500, {
				success: false,
				error: `Idempotency gate unavailable: ${message}`,
				errorClass: "retryable",
				duration_ms: Date.now() - startTime,
			});
			return;
		}

		if (claim.status === "completed") {
			console.log(
				`[piece-runtime] Idempotency hit for ${request.step} ` +
					`(key=${idempotencyKey}, attempt=${claim.attempt}) — returning cached result`,
			);
			const response: Record<string, unknown> = {
				success: true,
				data: claim.result,
				error: undefined,
				deduped: true,
				duration_ms: Date.now() - startTime,
				pieceVersion: deps.metadata.version ?? undefined,
			};
			applyResultOffload(response, {
				idempotencyKey,
				resultStored: true,
				step: request.step,
			});
			sendJson(res, 200, response);
			return;
		}

		if (claim.status === "failed" && claim.errorClass === "permanent") {
			console.log(
				`[piece-runtime] Idempotency hit for ${request.step} ` +
					`(key=${idempotencyKey}, attempt=${claim.attempt}) — returning cached permanent failure`,
			);
			sendJson(res, 500, {
				success: false,
				error: claim.error ?? "Action previously failed permanently",
				errorClass: "permanent",
				deduped: true,
				duration_ms: Date.now() - startTime,
				pieceVersion: deps.metadata.version ?? undefined,
			});
			return;
		}
		// status running/paused/failed-retryable → proceed (at-least-once on
		// mid-flight crash; a RESUME re-invocation must re-execute a paused row).
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
			`type=${request.execution_type ?? "BEGIN"}, ` +
			`authSource=${auth == null ? "none" : "resolved"})`,
	);

	const result = await runPieceAction({
		runtimeAction: resolved.runtimeAction,
		actionName: names.actionName,
		auth,
		requireAuth,
		input: request.input,
		executionId: request.execution_id,
		executionType: request.execution_type ?? "BEGIN",
		resumePayload: request.resume_payload,
		// Postgres-backed ctx.store on the deterministic path when a DB exists;
		// the MCP path keeps the no-op store.
		store: pool
			? createPgStore(pool, {
					workflowId: request.workflow_id,
					executionId: request.execution_id,
					dbExecutionId: request.db_execution_id ?? null,
				})
			: undefined,
		dbExecutionId: request.db_execution_id ?? undefined,
	});

	// ── Persist outcome (audit trail + offload backing + dedupe cache) ──
	// status 'paused' is deliberately not a cacheable terminal state: a later
	// RESUME re-invocation passes the gate and re-executes the action.
	let resultStored = false;
	if (pool && identity) {
		const status = result.success
			? result.pause
				? ("paused" as const)
				: ("completed" as const)
			: ("failed" as const);
		try {
			await finalizeIdempotency(pool, identity, {
				status,
				result: result.data,
				error: result.error ?? null,
				errorClass: result.errorClass ?? null,
			});
			resultStored = true;
		} catch (error) {
			if (gateActive) {
				// Fail closed — without the completed row, a future retry could
				// duplicate the side effect undetected. Retryable: the orchestrator
				// re-attempts and the gate then dedupes (at-least-once).
				const message = error instanceof Error ? error.message : String(error);
				console.error(
					`[piece-runtime] Idempotency finalize failed for ${request.step}:`,
					error,
				);
				sendJson(res, 500, {
					success: false,
					error: `Idempotency record write failed after execution: ${message}`,
					errorClass: "retryable",
					duration_ms: Date.now() - startTime,
				});
				return;
			}
			// Gate skipped (action marked idempotent): the row is best-effort
			// audit/offload storage — log and fall through to inline data.
			console.warn(
				`[piece-runtime] Best-effort piece_execution write failed for ${request.step}:`,
				error instanceof Error ? error.message : error,
			);
		}
	}

	const duration_ms = Date.now() - startTime;
	const response: Record<string, unknown> = {
		success: result.success,
		data: result.data,
		error: result.error,
		duration_ms,
		pieceVersion: deps.metadata.version ?? undefined,
	};
	if (!result.success && result.errorClass) {
		response.errorClass = result.errorClass;
	}
	if (result.pause) {
		response.pause = result.pause;
	}

	applyResultOffload(response, {
		idempotencyKey,
		resultStored,
		step: request.step,
	});

	console.log(
		`[piece-runtime] Step ${request.step} completed: success=${result.success}, duration=${duration_ms}ms` +
			(result.errorClass ? `, errorClass=${result.errorClass}` : ""),
	);

	sendJson(res, result.success ? 200 : 500, response);
}
