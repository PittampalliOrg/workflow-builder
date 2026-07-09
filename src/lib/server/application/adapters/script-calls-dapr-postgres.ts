import { DaprPostgresBindingClient } from "$lib/server/application/adapters/dapr-postgres-binding";
import {
	isoTimestamp,
	jsonParam,
	numberValue,
	stringOrNull,
	stringValue,
} from "$lib/server/application/adapters/dapr-postgres-rows";
import {
	type ScriptCallRecord,
	type ScriptCallsStore,
	type ScriptCallUpsertInput,
} from "$lib/server/application/adapters/script-calls-store";
import { tokensFromUsage } from "$lib/server/goals/goal-loop";

const SCRIPT_CALL_COLUMNS = `
	call_id,
	seq,
	kind,
	base_hash,
	occurrence,
	label,
	phase,
	prompt_sha256,
	status,
	session_id,
	result,
	error_code,
	retries,
	tokens_used,
	created_at,
	updated_at
`;

function rowToScriptCall(row: unknown[]): ScriptCallRecord {
	return {
		callId: stringValue(row[0]),
		seq: numberValue(row[1]),
		kind: stringValue(row[2], "agent"),
		baseHash: stringOrNull(row[3]),
		occurrence: numberValue(row[4]),
		label: stringOrNull(row[5]),
		phase: stringOrNull(row[6]),
		promptSha256: stringOrNull(row[7]),
		status: stringValue(row[8]),
		sessionId: stringOrNull(row[9]),
		result: row[10] ?? null,
		errorCode: stringOrNull(row[11]),
		retries: numberValue(row[12]),
		tokensUsed: numberValue(row[13]),
		createdAt: isoTimestamp(row[14]),
		updatedAt: isoTimestamp(row[15]),
	};
}

export class DaprPostgresScriptCallsStore implements ScriptCallsStore {
	constructor(
		private readonly client: Pick<
			DaprPostgresBindingClient,
			"query" | "exec"
		> = new DaprPostgresBindingClient(),
	) {}

	async listScriptCalls(executionId: string): Promise<ScriptCallRecord[]> {
		const result = await this.client.query({
			summary: "workflow_script_calls.select_by_execution",
			collection: "workflow_script_calls",
			sql: `
				SELECT ${SCRIPT_CALL_COLUMNS}
				FROM workflow_script_calls
				WHERE workflow_execution_id = $1
				ORDER BY seq ASC
			`,
			params: [executionId],
			paramNames: ["workflow_execution_id"],
		});
		return result.rows.map(rowToScriptCall);
	}

	async upsertScriptCall(
		executionId: string,
		callId: string,
		input: ScriptCallUpsertInput,
	): Promise<ScriptCallRecord> {
		const storedResult = jsonParam(input.result ?? null);
		const params = [
			executionId,
			callId,
			input.seq,
			input.kind ?? "agent",
			input.baseHash ?? null,
			input.occurrence ?? 0,
			input.label ?? null,
			input.phase ?? null,
			input.promptSha256 ?? null,
			input.status,
			input.sessionId ?? null,
			storedResult,
			input.errorCode ?? null,
			input.retries ?? 0,
			input.tokensUsed ?? 0,
		];
		const paramNames = [
			"workflow_execution_id",
			"call_id",
			"seq",
			"kind",
			"base_hash",
			"occurrence",
			"label",
			"phase",
			"prompt_sha256",
			"status",
			"session_id",
			"result",
			"error_code",
			"retries",
			"tokens_used",
		];
		await this.client.exec({
			summary: "workflow_script_calls.upsert",
			collection: "workflow_script_calls",
			sql: `
				INSERT INTO workflow_script_calls (
					workflow_execution_id,
					call_id,
					seq,
					kind,
					base_hash,
					occurrence,
					label,
					phase,
					prompt_sha256,
					status,
					session_id,
					result,
					error_code,
					retries,
					tokens_used,
					updated_at
				)
				VALUES (
					$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
					CAST($12 AS jsonb), $13, $14, $15, now()
				)
				ON CONFLICT (workflow_execution_id, call_id)
				DO UPDATE SET
					seq = EXCLUDED.seq,
					kind = EXCLUDED.kind,
					base_hash = EXCLUDED.base_hash,
					occurrence = EXCLUDED.occurrence,
					label = EXCLUDED.label,
					phase = EXCLUDED.phase,
					prompt_sha256 = EXCLUDED.prompt_sha256,
					status = EXCLUDED.status,
					session_id = EXCLUDED.session_id,
					result = EXCLUDED.result,
					error_code = EXCLUDED.error_code,
					retries = EXCLUDED.retries,
					tokens_used = EXCLUDED.tokens_used,
					updated_at = now()
			`,
			params,
			spanParams: [
				...params.slice(0, 11),
				input.result ?? null,
				...params.slice(12),
			],
			paramNames,
		});
		const selected = await this.client.query({
			summary: "workflow_script_calls.select_by_pk",
			collection: "workflow_script_calls",
			sql: `
				SELECT ${SCRIPT_CALL_COLUMNS}
				FROM workflow_script_calls
				WHERE workflow_execution_id = $1 AND call_id = $2
				LIMIT 1
			`,
			params: [executionId, callId],
			paramNames: ["workflow_execution_id", "call_id"],
		});
		const row = selected.rows[0];
		if (!row) {
			throw new Error(`Script call upsert did not return a row for ${executionId}/${callId}`);
		}
		return rowToScriptCall(row);
	}

	async importScriptCalls(input: {
		toExecutionId: string;
		fromExecutionId: string;
	}): Promise<{ imported: number }> {
		const source = await this.client.query({
			summary: "workflow_script_calls.select_done_for_import",
			collection: "workflow_script_calls",
			sql: `
				SELECT ${SCRIPT_CALL_COLUMNS}
				FROM workflow_script_calls
				WHERE workflow_execution_id = $1 AND status = 'done'
				ORDER BY seq ASC
			`,
			params: [input.fromExecutionId],
			paramNames: ["from_workflow_execution_id"],
		});
		let imported = 0;
		for (const row of source.rows) {
			const call = rowToScriptCall(row);
			await this.upsertScriptCall(input.toExecutionId, call.callId, {
				seq: call.seq,
				kind: call.kind,
				baseHash: call.baseHash,
				occurrence: call.occurrence,
				label: call.label,
				phase: call.phase,
				promptSha256: call.promptSha256,
				status: "done",
				sessionId: call.sessionId,
				result: call.result,
				errorCode: call.errorCode,
				retries: call.retries,
				tokensUsed: call.tokensUsed,
			});
			imported += 1;
		}
		return { imported };
	}

	async sumExecutionLlmUsage(executionId: string): Promise<{ totalTokens: number }> {
		const result = await this.client.query({
			summary: "session_events.sum_llm_usage_for_execution",
			collection: "session_events",
			sql: `
				SELECT se.data
				FROM session_events se
				INNER JOIN sessions s ON se.session_id = s.id
				WHERE s.workflow_execution_id = $1 AND se.type = 'agent.llm_usage'
			`,
			params: [executionId],
			paramNames: ["workflow_execution_id"],
		});
		let totalTokens = 0;
		for (const row of result.rows) {
			totalTokens += tokensFromUsage(
				row[0] as Record<string, unknown> | undefined,
			);
		}
		return { totalTokens };
	}
}
