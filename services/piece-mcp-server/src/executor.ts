/**
 * Piece Executor — shared deterministic core.
 *
 * One execution path for both surfaces of the piece-runtime:
 *  - POST /execute  (SW 1.0 workflow activities via function-router)
 *  - POST /mcp      (MCP CallTool handlers in piece-to-mcp.ts)
 *
 * Normalizes input, builds the AP ActionContext (with pause capture),
 * runs the action, and returns a uniform ExecutionResult. Auth is
 * resolved by the CALLER (header-scoped connection reference via
 * auth-resolver, or legacy credentials in the /execute body).
 */

import type { Action, Piece, Store } from "@activepieces/pieces-framework";
import { buildActionContext, type PauseCaptured } from "./context-factory.js";
import { classifyExecutionError, type ErrorClass } from "./error-classify.js";
import { extensionsFor } from "./extensions/index.js";
import { normalizeActionInput } from "./normalize-input.js";

export type ExecutionResult = {
	success: boolean;
	data?: unknown;
	error?: string;
	/**
	 * Failure classification for the orchestrator's retry policy:
	 * "retryable" (429/5xx/network) vs "permanent" (4xx/validation/auth/unknown).
	 */
	errorClass?: ErrorClass;
	pause?: PauseCaptured;
};

// biome-ignore lint/suspicious/noExplicitAny: Action's generics are internal
export type RuntimeAction = Action<any, any>;

export type ResolvedAction = {
	runtimeAction: RuntimeAction;
	/** True unless the action explicitly opts out (extensions always require auth). */
	requireAuth: boolean;
	isExtension: boolean;
};

/**
 * Resolve a runtime action by name: vendored piece actions first, then
 * in-repo extension actions (src/extensions/<piece>.ts).
 */
export function resolveRuntimeAction(
	piece: Piece,
	pieceName: string,
	actionName: string,
): ResolvedAction | undefined {
	const vendored = piece.getAction(actionName);
	if (vendored) {
		const raw = vendored as unknown as { requireAuth?: boolean };
		return {
			runtimeAction: vendored as RuntimeAction,
			requireAuth: raw.requireAuth !== false,
			isExtension: false,
		};
	}

	const extension = extensionsFor(pieceName).find(
		(ext) => ext.name === actionName,
	);
	if (extension) {
		// Extensions always require auth — see piece-to-mcp.ts for the
		// CJS-import-timing rationale.
		return {
			runtimeAction: extension as RuntimeAction,
			requireAuth: true,
			isExtension: true,
		};
	}

	return undefined;
}

/**
 * Run a piece action deterministically: normalize input → build context
 * (with pauseRef) → run → uniform result. Never throws.
 */
export async function runPieceAction(opts: {
	runtimeAction: RuntimeAction;
	actionName: string;
	auth: unknown;
	requireAuth: boolean;
	input: Record<string, unknown>;
	executionId: string;
	/** BEGIN (default) or RESUME — pause re-invocations from the orchestrator. */
	executionType?: "BEGIN" | "RESUME";
	/** Webhook payload exposed as ctx.resumePayload on RESUME. */
	resumePayload?: unknown;
	/** Durable ctx.store adapter; omitted on the MCP path (no-op store). */
	store?: Store;
	/** workflow_executions.id — needed by generateResumeUrl. */
	dbExecutionId?: string;
}): Promise<ExecutionResult> {
	const { runtimeAction, actionName, auth, requireAuth, input, executionId } =
		opts;

	// Fail fast with a clear message instead of letting pieces crash with
	// "Cannot read properties of undefined".
	if (auth == null && requireAuth) {
		return {
			success: false,
			error:
				`Missing credentials for "${actionName}". ` +
				"Provide X-Connection-External-Id (or select a Connection for this step) and retry.",
			errorClass: "permanent",
		};
	}

	try {
		const normalizedInput = await normalizeActionInput(runtimeAction, input);

		const { context, pauseRef } = buildActionContext({
			auth,
			propsValue: normalizedInput,
			executionId,
			actionName,
			executionType: opts.executionType,
			resumePayload: opts.resumePayload,
			store: opts.store,
			dbExecutionId: opts.dbExecutionId,
		});

		const result = await runtimeAction.run(context);

		if (pauseRef.value) {
			console.log(
				`[piece-runtime] Action ${actionName} requested pause: type=${pauseRef.value.type}`,
			);
			return { success: true, data: result, pause: pauseRef.value };
		}

		return { success: true, data: result };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[piece-runtime] Action ${actionName} failed:`, error);
		return {
			success: false,
			error: `Action execution failed: ${message}`,
			errorClass: classifyExecutionError(error),
		};
	}
}
