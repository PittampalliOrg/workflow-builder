import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: process.env }));

import {
	validateDynamicScriptSpec,
	validateWithEvaluator,
} from "./dynamic-script-validation";

const SCRIPT = `export const meta = { name: 'Demo', description: 'a demo', phases: ['Review', 'Verify'] }
const a = await agent('say hi', { label: 'hi' })
return { a }`;

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.DYNAMIC_SCRIPT_MAX_BYTES;
});

describe("validateDynamicScriptSpec", () => {
	it("accepts a well-formed spec and normalizes meta phases", () => {
		const result = validateDynamicScriptSpec({
			engine: "dynamic-script",
			script: SCRIPT,
			meta: { name: "Demo", phases: ["Review", "Verify"] },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.meta.name).toBe("Demo");
		expect(result.meta.phases).toEqual([{ title: "Review" }, { title: "Verify" }]);
	});

	it("rejects a script over the byte cap", () => {
		process.env.DYNAMIC_SCRIPT_MAX_BYTES = "64";
		const result = validateDynamicScriptSpec({
			engine: "dynamic-script",
			script: `export const meta = { name: 'x' }\n${"// pad ".repeat(50)}`,
			meta: { name: "x" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(400);
		expect(result.error).toMatch(/DYNAMIC_SCRIPT_MAX_BYTES/);
	});

	it("rejects a script missing `export const meta`", () => {
		const result = validateDynamicScriptSpec({
			engine: "dynamic-script",
			script: "const meta = { name: 'x' }\nreturn {}",
			meta: { name: "x" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/export const meta/);
	});

	it("rejects meta without a name", () => {
		const result = validateDynamicScriptSpec({
			engine: "dynamic-script",
			script: SCRIPT,
			meta: { description: "no name" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toMatch(/name is required/);
	});

	it("rejects a non-dynamic-script engine", () => {
		const result = validateDynamicScriptSpec({ engine: "dapr", script: SCRIPT, meta: {} });
		expect(result.ok).toBe(false);
	});
});

describe("validateWithEvaluator", () => {
	it("returns evaluator-truth meta + estimatedAgentCalls on 200", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					meta: { name: "Server Demo", phases: [{ title: "Review" }] },
					estimatedAgentCalls: 3,
				}),
			})),
		);
		const result = await validateWithEvaluator(SCRIPT, { baseUrl: "http://evaluator" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.meta.name).toBe("Server Demo");
		expect(result.meta.estimatedAgentCalls).toBe(3);
		expect(result.estimatedAgentCalls).toBe(3);
	});

	it("degrades to static validation when the evaluator is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
		const result = await validateWithEvaluator(SCRIPT, { baseUrl: "http://evaluator" });
		// Static gate still passes → degrade to a static OK (name from the script).
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.meta.name).toBe("Demo");
	});

	it("can require evaluator availability for execution start", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
		const result = await validateWithEvaluator(SCRIPT, {
			baseUrl: "http://evaluator",
			degradeOnUnavailable: false,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(503);
		expect(result.error).toMatch(/script evaluator unavailable/);
	});

	it("can treat 5xx evaluator failures as unavailable for execution start", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 503,
				text: async () => "warming up",
			})),
		);
		const result = await validateWithEvaluator(SCRIPT, {
			baseUrl: "http://evaluator",
			degradeOnUnavailable: false,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(503);
		expect(result.error).toContain("warming up");
	});

	it("propagates a 4xx evaluator rejection as a 400", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: false,
				status: 422,
				text: async () => "banned_api: Date.now",
			})),
		);
		const result = await validateWithEvaluator(SCRIPT, { baseUrl: "http://evaluator" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(400);
		expect(result.error).toMatch(/banned_api/);
	});
});
