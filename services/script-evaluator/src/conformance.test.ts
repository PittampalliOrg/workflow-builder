import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateScript, EVALUATOR_VERSION } from "./sandbox.js";

// SSOT contract shared with the orchestrator pytest suite.
const CONTRACT_PATH = fileURLToPath(
	new URL(
		"../../shared/contracts/script-evaluator-evaluate.contract.json",
		import.meta.url,
	),
);
const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));

describe("contract conformance (SSOT)", () => {
	const script: string = contract.request.script;

	it("evaluatorVersion matches the contract", () => {
		expect(EVALUATOR_VERSION).toBe(contract.evaluatorVersion);
	});

	it("first round produces the contract 'need' shape", async () => {
		const res = await evaluateScript({
			script,
			meta: contract.request.meta,
			args: contract.request.args,
			nested: false,
			budget: { total: 500000, spent: 0, exhausted: false, lifetimeExceeded: false },
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			limits: { maxItemsPerCall: contract.limits.maxItemsPerCall },
		});

		const need = contract.response.need;
		expect(res.status).toBe(need.status);
		expect(res.tasks.length).toBe(1);

		const task = res.tasks[0];
		const ref = need.tasks[0];
		// Structural parity with the contract's example task.
		expect(task.kind).toBe(ref.kind);
		expect(task.prompt).toBe(ref.prompt);
		expect(task.occurrence).toBe(ref.occurrence);
		expect(task.callId).toBe(task.baseHash.slice(0, 40) + "_0");
		expect(task.baseHash).toMatch(/^[0-9a-f]{64}$/);
		expect(Object.keys(task.opts).sort()).toEqual(Object.keys(ref.opts).sort());
		expect(task.opts.label).toBe(ref.opts.label);
		expect(task.opts.phase).toBe(ref.opts.phase);
		expect(task.opts.schema).toBeNull();

		expect(res.phases).toEqual(need.phases);
		expect(res.newLogs).toEqual(need.newLogs);
		expect(res.logCount).toBe(need.logCount);
		expect(res.counts).toEqual(need.counts);
		expect(res.returnValue).toBeNull();
		expect(res.error).toBeNull();
		expect(res.evaluatorVersion).toBe(need.evaluatorVersion);
	});

	it("second round (call journaled) produces the contract 'done' shape", async () => {
		// discover callId from round 1
		const round1 = await evaluateScript({
			script,
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			budget: { total: 500000, spent: 0 },
		});
		const callId = round1.tasks[0].callId;

		const res = await evaluateScript({
			script,
			completedResults: { [callId]: { status: "done", value: "hi there", errorCode: null } },
			knownCallIds: [callId],
			seenLogCount: 1,
			budget: { total: 500000, spent: 0 },
		});

		const done = contract.response.done;
		expect(res.status).toBe(done.status);
		expect(res.tasks).toEqual([]);
		expect(res.returnValue).toEqual(done.returnValue);
		expect(res.phases).toEqual(done.phases);
		expect(res.newLogs).toEqual(done.newLogs);
		expect(res.logCount).toBe(done.logCount);
		expect(res.counts).toEqual(done.counts);
		expect(res.error).toBeNull();
	});

	it("script_error shape carries error {message, stack}", async () => {
		const res = await evaluateScript({
			script: "export const meta = { name: 'e', description: 'd', phases: [] }\nthrow new Error('x')",
			completedResults: {},
			knownCallIds: [],
			seenLogCount: 0,
			budget: { total: 1, spent: 0 },
		});
		expect(res.status).toBe("script_error");
		expect(res.tasks).toEqual([]);
		expect(res.returnValue).toBeNull();
		expect(res.error).not.toBeNull();
		expect(typeof res.error?.message).toBe("string");
		expect("stack" in (res.error as object)).toBe(true);
	});
});
