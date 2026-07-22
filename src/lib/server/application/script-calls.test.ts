import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRuntimeHostCleanupPort } from "$lib/server/application/ports";
import type {
	ScriptCallRecord,
	ScriptCallsStore,
} from "$lib/server/application/adapters/script-calls-store";
import { ApplicationScriptCallsService } from "./script-calls";

function call(status: string): ScriptCallRecord {
	return {
		callId: "call-1",
		seq: 1,
		kind: "agent",
		baseHash: null,
		occurrence: 0,
		label: null,
		phase: null,
		promptSha256: null,
		status,
		sessionId: "session-1",
		result: null,
		errorCode: null,
		retries: 0,
		tokensUsed: 0,
		callSite: null,
		createdAt: "2026-07-22T12:00:00.000Z",
		updatedAt: "2026-07-22T12:00:00.000Z",
	};
}

describe("ApplicationScriptCallsService runtime-host cleanup fence", () => {
	let store: ScriptCallsStore;
	let runtimeHosts: TerminalRuntimeHostCleanupPort;
	let service: ApplicationScriptCallsService;

	beforeEach(() => {
		store = {
			listScriptCalls: vi.fn(async () => []),
			upsertScriptCall: vi.fn(async () => call("running")),
			importScriptCalls: vi.fn(async () => ({ imported: 0 })),
			sumExecutionLlmUsage: vi.fn(async () => ({ totalTokens: 0 })),
		};
		runtimeHosts = {
			requestReap: vi.fn(),
			reapPending: vi.fn(async () => ({
				scanned: 0,
				acknowledged: [],
				failed: [],
				dryRun: false,
			})),
		};
		service = new ApplicationScriptCallsService({
			workflowData: { getScopedExecutionById: vi.fn(async () => null) },
			store,
			terminalRuntimeHosts: runtimeHosts,
		});
	});

	it("does not reap while the parent journal row is running", async () => {
		await service.upsert("execution-1", "call-1", {
			seq: 1,
			status: "running",
			sessionId: "session-1",
		});
		expect(runtimeHosts.requestReap).not.toHaveBeenCalled();
	});

	it.each(["done", "null", "error", "skipped"])(
		"triggers fenced cleanup after journal status %s",
		async (status) => {
			vi.mocked(store.upsertScriptCall).mockResolvedValueOnce(call(status));
			await service.upsert("execution-1", "call-1", {
				seq: 1,
				status,
				sessionId: "session-1",
			});
			expect(runtimeHosts.requestReap).toHaveBeenCalledOnce();
		},
	);
});
