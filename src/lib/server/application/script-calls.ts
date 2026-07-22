/**
 * Application service for the dynamic-script call journal + budget aggregate.
 *
 * Routes (internal-token + user-scoped) reach the journal through this service
 * (`getApplicationAdapters().scriptCalls`) rather than touching the DB directly —
 * db access lives in `adapters/script-calls-store.ts`. The user-scoped read
 * enforces workspace scope via `workflowData.getScopedExecutionById`.
 */

import type {
	TerminalRuntimeHostCleanupPort,
	WorkflowDataService,
} from "$lib/server/application/ports";
import {
	postgresScriptCallsStore,
	type ScriptCallRecord,
	type ScriptCallsStore,
	type ScriptCallUpsertInput,
} from "$lib/server/application/adapters/script-calls-store";

export type ScriptCallsListResult =
	| { status: "ok"; body: { scriptCalls: ScriptCallRecord[] } }
	| { status: "error"; httpStatus: number; message: string };

export class ApplicationScriptCallsService {
	constructor(
		private readonly deps: {
			workflowData: Pick<WorkflowDataService, "getScopedExecutionById">;
			store?: ScriptCallsStore;
			terminalRuntimeHosts?: TerminalRuntimeHostCleanupPort;
		},
	) {}

	private get store(): ScriptCallsStore {
		return this.deps.store ?? postgresScriptCallsStore;
	}

	/** Internal (orchestrator) read — no scope check. */
	async listInternal(executionId: string): Promise<ScriptCallRecord[]> {
		return this.store.listScriptCalls(executionId);
	}

	/** Internal idempotent upsert of one journal row. */
	async upsert(
		executionId: string,
		callId: string,
		input: ScriptCallUpsertInput,
	): Promise<ScriptCallRecord> {
		const call = await this.store.upsertScriptCall(executionId, callId, input);
		if (
			call.sessionId &&
			["done", "null", "error", "skipped"].includes(call.status)
		) {
			// The journal write is the parent-consumption fence. Cleanup is eager but
			// detached so the orchestrator activity is never coupled to SEA latency;
			// the nullable session acknowledgement lets the scheduled reconciler retry.
			this.deps.terminalRuntimeHosts?.requestReap();
		}
		return call;
	}

	/** Internal resume-after-edit journal import (`done` rows only). */
	async import(input: {
		toExecutionId: string;
		fromExecutionId: string;
	}): Promise<{ imported: number }> {
		return this.store.importScriptCalls(input);
	}

	/** Internal budget aggregate — Σ tokensFromUsage over the execution's sessions. */
	async llmUsage(executionId: string): Promise<{ totalTokens: number }> {
		return this.store.sumExecutionLlmUsage(executionId);
	}

	/** User-scoped journal read for the run UI. 404s cross-workspace. */
	async listForUser(input: {
		executionId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<ScriptCallsListResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!execution) {
			return { status: "error", httpStatus: 404, message: "Execution not found" };
		}
		const calls = await this.store.listScriptCalls(input.executionId);
		return { status: "ok", body: { scriptCalls: calls } };
	}
}
