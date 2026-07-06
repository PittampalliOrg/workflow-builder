/**
 * Drizzle-backed store for the dynamic-script call journal (`workflow_script_calls`)
 * plus the per-execution LLM-usage aggregate (the script `budget`).
 *
 * The journal is written by the orchestrator's `record_script_call_result` activity
 * (idempotent PUT keyed on `(workflowExecutionId, callId)`) and read by the run-detail
 * UI + the evaluator activity. `import` copies a source execution's `done` rows into a
 * fresh execution for resume-after-edit. `sumExecutionLlmUsage` reuses the goal-loop
 * `tokensFromUsage` formula (input + output + cache_creation) over `agent.llm_usage`
 * session events for every session linked to the execution.
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	sessionEvents,
	sessions,
	workflowScriptCalls,
} from "$lib/server/db/schema";
import { tokensFromUsage } from "$lib/server/goals/goal-loop";

export type ScriptCallStatus = "running" | "done" | "null" | "error" | "skipped";

/** Wire contract for one journal row (GET/PUT). */
export type ScriptCallRecord = {
	callId: string;
	seq: number;
	kind: string;
	baseHash: string | null;
	occurrence: number;
	label: string | null;
	phase: string | null;
	promptSha256: string | null;
	status: string;
	sessionId: string | null;
	result: unknown;
	errorCode: string | null;
	retries: number;
	tokensUsed: number;
	createdAt: string;
	updatedAt: string;
};

/** Mutable fields accepted by the idempotent PUT upsert. */
export type ScriptCallUpsertInput = {
	seq: number;
	kind?: string;
	baseHash?: string | null;
	occurrence?: number;
	label?: string | null;
	phase?: string | null;
	promptSha256?: string | null;
	status: string;
	sessionId?: string | null;
	result?: unknown;
	errorCode?: string | null;
	retries?: number;
	tokensUsed?: number;
};

type Row = typeof workflowScriptCalls.$inferSelect;

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

function toRecord(row: Row): ScriptCallRecord {
	return {
		callId: row.callId,
		seq: row.seq,
		kind: row.kind,
		baseHash: row.baseHash,
		occurrence: row.occurrence,
		label: row.label,
		phase: row.phase,
		promptSha256: row.promptSha256,
		status: row.status,
		sessionId: row.sessionId,
		result: row.result ?? null,
		errorCode: row.errorCode,
		retries: row.retries,
		tokensUsed: row.tokensUsed,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

/** All journal rows for an execution, ordered by issue order (seq). */
export async function listScriptCalls(
	executionId: string,
): Promise<ScriptCallRecord[]> {
	const rows = await requireDb()
		.select()
		.from(workflowScriptCalls)
		.where(eq(workflowScriptCalls.workflowExecutionId, executionId))
		.orderBy(asc(workflowScriptCalls.seq));
	return rows.map(toRecord);
}

/**
 * Idempotent upsert of one journal row (composite PK). Dapr activity retries land
 * on the same row → UPSERT. `updated_at` is always bumped; `created_at` is left to
 * its default on first insert.
 */
export async function upsertScriptCall(
	executionId: string,
	callId: string,
	input: ScriptCallUpsertInput,
): Promise<ScriptCallRecord> {
	const now = new Date();
	const values = {
		workflowExecutionId: executionId,
		callId,
		seq: input.seq,
		kind: input.kind ?? "agent",
		baseHash: input.baseHash ?? null,
		occurrence: input.occurrence ?? 0,
		label: input.label ?? null,
		phase: input.phase ?? null,
		promptSha256: input.promptSha256 ?? null,
		status: input.status,
		sessionId: input.sessionId ?? null,
		result: input.result ?? null,
		errorCode: input.errorCode ?? null,
		retries: input.retries ?? 0,
		tokensUsed: input.tokensUsed ?? 0,
		updatedAt: now,
	};
	const rows = await requireDb()
		.insert(workflowScriptCalls)
		.values(values)
		.onConflictDoUpdate({
			target: [
				workflowScriptCalls.workflowExecutionId,
				workflowScriptCalls.callId,
			],
			set: {
				seq: values.seq,
				kind: values.kind,
				baseHash: values.baseHash,
				occurrence: values.occurrence,
				label: values.label,
				phase: values.phase,
				promptSha256: values.promptSha256,
				status: values.status,
				sessionId: values.sessionId,
				result: values.result,
				errorCode: values.errorCode,
				retries: values.retries,
				tokensUsed: values.tokensUsed,
				updatedAt: now,
			},
		})
		.returning();
	return toRecord(rows[0]);
}

/**
 * Copy the `done` rows of a SOURCE execution into a TARGET execution for
 * resume-after-edit. Only `done` rows are imported (failed/skipped/null are
 * dropped so an edited script re-runs them). The source `session_id` is kept —
 * it is informational (the imported result is authoritative). Returns the number
 * of rows imported.
 */
export async function importScriptCalls(input: {
	toExecutionId: string;
	fromExecutionId: string;
}): Promise<{ imported: number }> {
	const database = requireDb();
	const sourceRows = await database
		.select()
		.from(workflowScriptCalls)
		.where(
			and(
				eq(workflowScriptCalls.workflowExecutionId, input.fromExecutionId),
				eq(workflowScriptCalls.status, "done"),
			),
		);
	let imported = 0;
	for (const row of sourceRows) {
		await upsertScriptCall(input.toExecutionId, row.callId, {
			seq: row.seq,
			kind: row.kind,
			baseHash: row.baseHash,
			occurrence: row.occurrence,
			label: row.label,
			phase: row.phase,
			promptSha256: row.promptSha256,
			status: "done",
			sessionId: row.sessionId,
			result: row.result,
			errorCode: row.errorCode,
			retries: row.retries,
			tokensUsed: row.tokensUsed,
		});
		imported += 1;
	}
	return { imported };
}

/**
 * The script `budget` accrual: SUM of the goal-loop `tokensFromUsage`
 * (input + output + cache_creation) over every `agent.llm_usage` session event
 * for sessions linked to this execution. Fetches the event `data` rows and sums
 * in JS so the exact goal-loop formula is reused verbatim.
 */
export async function sumExecutionLlmUsage(
	executionId: string,
): Promise<{ totalTokens: number }> {
	const rows = await requireDb()
		.select({ data: sessionEvents.data })
		.from(sessionEvents)
		.innerJoin(sessions, eq(sessionEvents.sessionId, sessions.id))
		.where(
			and(
				eq(sessions.workflowExecutionId, executionId),
				eq(sessionEvents.type, "agent.llm_usage"),
			),
		);
	let totalTokens = 0;
	for (const row of rows) {
		totalTokens += tokensFromUsage(
			row.data as Record<string, unknown> | undefined,
		);
	}
	return { totalTokens };
}
