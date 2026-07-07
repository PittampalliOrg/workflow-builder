import { describe, expect, it } from "vitest";
import {
	agentSemanticOpts,
	computeBaseHash,
	deriveCallId,
	workflowSemanticOpts,
} from "./call-id.js";
import {
	evaluateScript,
	extractMeta,
	normalizePhases,
	validateScript,
	type EvaluateRequest,
} from "./sandbox.js";

const META = "export const meta = { name: 'x', description: 'd', phases: [] }\n";

function req(script: string, o: Partial<EvaluateRequest> = {}): EvaluateRequest {
	return {
		script,
		budget: { total: 1_000_000, spent: 0 },
		completedResults: {},
		knownCallIds: [],
		seenLogCount: 0,
		...o,
	};
}

/** callId of an agent() call, occurrence 0. */
function acid(prompt: string, opts?: Record<string, unknown>, occ = 0): string {
	return deriveCallId(computeBaseHash(prompt, agentSemanticOpts(opts)), occ);
}
/** callId of a workflow() call, occurrence 0. */
function wcid(nameOrRef: string, args?: unknown, occ = 0): string {
	const prompt = "workflow:" + nameOrRef;
	return deriveCallId(computeBaseHash(prompt, workflowSemanticOpts(args)), occ);
}

describe("quiescence classification", () => {
	it("need: unresolved agent() → status need with a task", async () => {
		const res = await evaluateScript(req(META + "const a = await agent('go'); return { a }"));
		expect(res.status).toBe("need");
		expect(res.tasks.map((t) => t.callId)).toEqual([acid("go")]);
	});

	it("done: resolved agent() → status done with returnValue", async () => {
		const id = acid("go");
		const res = await evaluateScript(
			req(META + "const a = await agent('go'); return { a }", {
				completedResults: { [id]: { status: "done", value: "yo" } },
				knownCallIds: [id],
			}),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ a: "yo" });
	});

	it("null/skipped/error journal statuses resolve agent() to null", async () => {
		for (const status of ["null", "skipped", "error"]) {
			const id = acid("go");
			const res = await evaluateScript(
				req(META + "const a = await agent('go'); return { a }", {
					completedResults: { [id]: { status, value: "ignored" } },
					knownCallIds: [id],
				}),
			);
			expect(res.status).toBe("done");
			expect(res.returnValue).toEqual({ a: null });
		}
	});

	it("script_error: a thrown error surfaces message + stack", async () => {
		const res = await evaluateScript(req(META + "throw new Error('boom')"));
		expect(res.status).toBe("script_error");
		expect(res.error?.message).toContain("boom");
		expect(typeof res.error?.stack).toBe("string");
	});

	it("script_error deadlock: awaiting with no pending agent() calls", async () => {
		const res = await evaluateScript(
			req(META + "await new Promise(() => {}); return {}"),
		);
		expect(res.status).toBe("script_error");
		expect(res.error?.message).toContain("deadlock");
	});

	it("done drops orphan pendings with an evaluator warning", async () => {
		// agent() is called but never awaited → orphan on completion.
		const res = await evaluateScript(
			req(META + "agent('orphan'); return { ok: true }"),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ ok: true });
		expect(res.newLogs.some((l) => l.startsWith("[evaluator] dropped orphan"))).toBe(
			true,
		);
	});

	it("need with empty tasks when the only pending call is already known (in-flight)", async () => {
		const id = acid("go");
		const res = await evaluateScript(
			req(META + "const a = await agent('go'); return { a }", {
				completedResults: {},
				knownCallIds: [id], // dispatched but not yet complete
			}),
		);
		expect(res.status).toBe("need");
		expect(res.tasks).toEqual([]);
	});
});

describe("parallel semantics", () => {
	it("is a barrier: does not resolve until ALL thunks settle", async () => {
		const script =
			META + "const r = await parallel([() => agent('p1'), () => agent('p2')]); return { r }";
		const p1 = acid("p1");
		const res = await evaluateScript(
			req(script, {
				completedResults: { [p1]: { status: "done", value: "v1" } },
				knownCallIds: [p1],
			}),
		);
		// p1 resolved, but parallel still waits on p2 → need, only p2 outstanding.
		expect(res.status).toBe("need");
		expect(res.tasks.map((t) => t.callId)).toEqual([acid("p2")]);
	});

	it("a thrown thunk becomes null (not a rejection)", async () => {
		const script =
			META +
			"const r = await parallel([() => { throw new Error('x'); }, () => agent('ok')]); return { r }";
		const ok = acid("ok");
		const res = await evaluateScript(
			req(script, {
				completedResults: { [ok]: { status: "done", value: "V" } },
				knownCallIds: [ok],
			}),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ r: [null, "V"] });
	});

	it("throws when items exceed maxItemsPerCall", async () => {
		const script =
			META +
			"const t = Array.from({length: 4097}, (_,i) => () => agent('p'+i)); await parallel(t); return {}";
		const res = await evaluateScript(req(script));
		expect(res.status).toBe("script_error");
		expect(res.error?.message).toContain("maxItemsPerCall");
	});
});

describe("pipeline semantics", () => {
	const script =
		META +
		`const r = await pipeline(['A','B'],
      async (x) => await agent('s1:'+x),
      async (y) => await agent('s2:'+y),
    )
    return { r }`;

	it("has NO cross-item barrier: item A reaches stage2 while item B is stuck at stage1", async () => {
		const s1A = acid("s1:A");
		const res = await evaluateScript(
			req(script, {
				completedResults: { [s1A]: { status: "done", value: "A1" } },
				knownCallIds: [s1A],
			}),
		);
		expect(res.status).toBe("need");
		const ids = res.tasks.map((t) => t.callId).sort();
		// A advanced to stage2 (s2:A1) while B is still at stage1 (s1:B).
		expect(ids).toEqual([acid("s1:B"), acid("s2:A1")].sort());
	});

	it("a thrown stage drops that item (null) and skips remaining stages", async () => {
		const throwing =
			META +
			`const r = await pipeline(['A','B'],
        async (x) => { if (x === 'B') throw new Error('bad'); return await agent('s:'+x); },
        async (y) => await agent('t:'+y),
      )
      return { r }`;
		const sA = acid("s:A");
		const tA1 = acid("t:A1");
		const res = await evaluateScript(
			req(throwing, {
				completedResults: {
					[sA]: { status: "done", value: "A1" },
					[tA1]: { status: "done", value: "A2" },
				},
				knownCallIds: [sA, tA1],
			}),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ r: ["A2", null] });
	});
});

describe("determinism bans", () => {
	const cases: Array<[string, string]> = [
		["Date.now()", "const a = Date.now(); return { a }"],
		["new Date() with zero args", "const a = new Date(); return { a }"],
		["Math.random()", "const a = Math.random(); return { a }"],
	];
	for (const [name, snippet] of cases) {
		it(`${name} throws → script_error`, async () => {
			const res = await evaluateScript(req(META + snippet));
			expect(res.status).toBe("script_error");
			expect(res.error?.message.toLowerCase()).toContain("banned");
		});
	}

	it("new Date(arg) with arguments is allowed", async () => {
		const res = await evaluateScript(
			req(
				META +
					"const d = new Date('2020-01-01T00:00:00Z'); return { iso: d.toISOString() }",
			),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ iso: "2020-01-01T00:00:00.000Z" });
	});

	it("Math still works for deterministic ops", async () => {
		const res = await evaluateScript(
			req(META + "return { v: Math.max(1, 2, 3) + Math.floor(2.9) }"),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ v: 5 });
	});

	it("timers/fetch/require/process are not present in the sandbox", async () => {
		for (const g of ["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "fetch", "require", "process"]) {
			const res = await evaluateScript(req(META + `return { t: typeof ${g} }`));
			expect(res.status).toBe("done");
			expect(res.returnValue).toEqual({ t: "undefined" });
		}
	});
});

describe("workflow() failure semantics (throws, not null)", () => {
	it("a journaled error resolves workflow() by THROWING the stored message", async () => {
		const id = wcid("missing-child");
		const res = await evaluateScript(
			req(
				META +
					"try { await workflow('missing-child'); return { caught: null } } catch (e) { return { caught: e.message } }",
				{
					completedResults: {
						[id]: {
							status: "error",
							value: { message: "workflow() could not resolve 'missing-child': not found" },
							errorCode: "workflow_child_error",
						},
					},
					knownCallIds: [id],
				},
			),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({
			caught: "workflow() could not resolve 'missing-child': not found",
		});
	});

	it("a legacy 'null' workflow row also throws (generic message)", async () => {
		const id = wcid("dead-child");
		const res = await evaluateScript(
			req(
				META +
					"try { await workflow('dead-child'); return { caught: null } } catch (e) { return { caught: e.message } }",
				{
					completedResults: { [id]: { status: "null", value: null } },
					knownCallIds: [id],
				},
			),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ caught: "workflow() child failed" });
	});

	it("an UNCAUGHT workflow() child error rejects the script (script_error)", async () => {
		const id = wcid("dead-child");
		const res = await evaluateScript(
			req(META + "const r = await workflow('dead-child'); return { r }", {
				completedResults: {
					[id]: {
						status: "error",
						value: { message: "child died" },
						errorCode: "workflow_child_error",
					},
				},
				knownCallIds: [id],
			}),
		);
		expect(res.status).toBe("script_error");
		expect(res.error?.message).toBe("child died");
	});

	it("a skipped workflow() still resolves null (user skip)", async () => {
		const id = wcid("skipped-child");
		const res = await evaluateScript(
			req(META + "const r = await workflow('skipped-child'); return { r }", {
				completedResults: { [id]: { status: "skipped", value: null } },
				knownCallIds: [id],
			}),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ r: null });
	});
});

describe("args semantics (verbatim any-JSON, undefined when absent)", () => {
	it("array args pass verbatim (args.map works)", async () => {
		const res = await evaluateScript(
			req(META + "return { n: args.length, upper: args.map((f) => f.toUpperCase()) }", {
				args: ["a.ts", "b.ts"],
			}),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ n: 2, upper: ["A.TS", "B.TS"] });
	});

	it("scalar (string) args pass verbatim", async () => {
		const res = await evaluateScript(
			req(META + "return { q: args, t: typeof args }", { args: "a research question" }),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ q: "a research question", t: "string" });
	});

	it("absent args -> the args global is undefined", async () => {
		const request = req(META + "return { t: typeof args, isUndef: args === undefined }");
		delete (request as Record<string, unknown>).args;
		const res = await evaluateScript(request);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ t: "undefined", isUndef: true });
	});

	it("explicit null args stay null (distinct from absent)", async () => {
		const res = await evaluateScript(
			req(META + "return { isNull: args === null }", { args: null }),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ isNull: true });
	});
});

describe("log / console", () => {
	it("log() and console.log write to the same log sink", async () => {
		const res = await evaluateScript(
			req(META + "log('a'); console.log('b', 1); return {}"),
		);
		expect(res.status).toBe("done");
		expect(res.newLogs).toContain("a");
		expect(res.newLogs).toContain("b 1");
	});

	it("console.error/warn/info/debug are shimmed (do not throw) and log", async () => {
		const res = await evaluateScript(
			req(
				META +
					"console.error('e'); console.warn('w'); console.info('i'); console.debug('d'); return { ok: true }",
			),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ ok: true });
		for (const m of ["e", "w", "i", "d"]) expect(res.newLogs).toContain(m);
	});
});

describe("budget / lifetime", () => {
	it("throws BudgetExhaustedError only at UNRESOLVED calls", async () => {
		// resolved call still resolves under exhaustion
		const id = acid("go");
		const resolved = await evaluateScript(
			req(META + "const a = await agent('go'); return { a }", {
				budget: { total: 10, spent: 10, exhausted: true },
				completedResults: { [id]: { status: "done", value: "ok" } },
				knownCallIds: [id],
			}),
		);
		expect(resolved.status).toBe("done");
		expect(resolved.returnValue).toEqual({ a: "ok" });

		// unresolved call throws
		const thrown = await evaluateScript(
			req(META + "const a = await agent('go'); return { a }", {
				budget: { total: 10, spent: 10, exhausted: true },
			}),
		);
		expect(thrown.status).toBe("script_error");
		expect(thrown.error?.message).toContain("budget exhausted");
	});

	it("lifetimeExceeded throws AgentLimitError at unresolved calls", async () => {
		const res = await evaluateScript(
			req(META + "const a = await agent('go'); return { a }", {
				budget: { total: 100, spent: 0, lifetimeExceeded: true },
			}),
		);
		expect(res.status).toBe("script_error");
		expect(res.error?.message).toContain("lifetime");
	});

	it("exposes budget total/spent/remaining to the script", async () => {
		const res = await evaluateScript(
			req(META + "return { total: budget.total, spent: budget.spent(), rem: budget.remaining() }", {
				budget: { total: 100, spent: 30 },
			}),
		);
		expect(res.status).toBe("done");
		expect(res.returnValue).toEqual({ total: 100, spent: 30, rem: 70 });
	});
});

describe("4096 task-per-response guard", () => {
	it("script_error when a response would carry more than 4096 tasks", async () => {
		const script =
			META +
			"const ps = []; for (let i=0;i<4097;i++) ps.push(agent('p'+i)); await Promise.all(ps); return {}";
		const res = await evaluateScript(req(script, { limits: { maxItemsPerCall: 1_000_000 } }));
		expect(res.status).toBe("script_error");
		expect(res.error?.message).toContain("too many tasks");
	});
});

describe("workflow()", () => {
	it("registers a workflow task with workflowRef/args and empty prompt/schema", async () => {
		const res = await evaluateScript(
			req(META + "const r = await workflow('childflow', { k: 1 }); return { r }"),
		);
		expect(res.status).toBe("need");
		expect(res.tasks.length).toBe(1);
		const t = res.tasks[0];
		expect(t.kind).toBe("workflow");
		expect(t.callId).toBe(wcid("childflow", { k: 1 }));
		expect(t.prompt).toBe("");
		expect(t.opts.schema).toBeNull();
		expect(t.workflowRef).toBe("childflow");
		expect(t.args).toEqual({ k: 1 });
	});

	it("rejects when request.nested is true (one level only)", async () => {
		const res = await evaluateScript(
			req(META + "const r = await workflow('childflow'); return { r }", {
				nested: true,
			}),
		);
		expect(res.status).toBe("script_error");
		expect(res.error?.message).toContain("one level only");
	});
});

describe("import is banned", () => {
	it("static import → script_error 'import is not available'", async () => {
		const res = await evaluateScript(req("import x from 'y'\n" + META + "return {}"));
		expect(res.status).toBe("script_error");
		expect(res.error?.message).toContain("import is not available");
	});
});

describe("log / phase deltas", () => {
	it("newLogs are sliced by seenLogCount; logCount is the running total", async () => {
		const script =
			META + "log('a'); log('b'); phase('P1'); log('c'); phase('P2'); return {}";
		const full = await evaluateScript(req(script));
		expect(full.status).toBe("done");
		expect(full.logCount).toBe(3);
		expect(full.newLogs).toEqual(["a", "b", "c"]);
		expect(full.phases.current).toBe("P2");

		const delta = await evaluateScript(req(script, { seenLogCount: 2 }));
		expect(delta.newLogs).toEqual(["c"]);
		expect(delta.logCount).toBe(3);
	});

	it("console.log is captured as a log line", async () => {
		const res = await evaluateScript(
			req(META + "console.log('hello', 42); return {}"),
		);
		expect(res.status).toBe("done");
		expect(res.newLogs).toContain("hello 42");
	});

	it("agent task opts.phase reflects the current phase at call time", async () => {
		const res = await evaluateScript(
			req(META + "phase('build'); const a = await agent('go'); return { a }"),
		);
		expect(res.status).toBe("need");
		expect(res.tasks[0].opts.phase).toBe("build");
	});
});

describe("meta extraction + normalization", () => {
	it("normalizePhases handles [{title}] and [string]", () => {
		expect(normalizePhases([{ title: "A" }, { title: "B" }])).toEqual(["A", "B"]);
		expect(normalizePhases(["X", "Y"])).toEqual(["X", "Y"]);
		expect(normalizePhases(undefined)).toEqual([]);
	});

	it("extractMeta pulls a balanced object literal with nested braces/strings", () => {
		const script = `export const meta = { name: 'n', description: 'has } brace', phases: [{ title: 'A' }], nested: { a: 1 } }
phase('A')
return {}`;
		const ex = extractMeta(script);
		expect(ex.ok).toBe(true);
		expect(ex.meta?.name).toBe("n");
		expect(ex.meta?.description).toBe("has } brace");
		expect((ex.meta?.phases as unknown[]).length).toBe(1);
		// body must no longer contain the meta declaration.
		expect(ex.body).not.toContain("export const meta");
		expect(ex.body).toContain("phase('A')");
	});

	it("declared phases in /evaluate come from meta (normalized)", async () => {
		const script =
			"export const meta = { name: 'n', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }\nreturn {}";
		const res = await evaluateScript(req(script));
		expect(res.phases.declared).toEqual(["A", "B"]);
	});
});

describe("/validate", () => {
	it("returns ok + meta + estimatedAgentCalls for a good script", async () => {
		const script =
			META + "const a = await agent('one'); const b = await agent('two'); return { a, b }";
		const res = await validateScript(script);
		expect(res.ok).toBe(true);
		expect(res.meta?.name).toBe("x");
		expect(res.estimatedAgentCalls).toBe(2);
	});

	it("returns ok:false with an error for a syntax error", async () => {
		const res = await validateScript(META + "const = ;");
		expect(res.ok).toBe(false);
		expect(typeof res.error).toBe("string");
	});

	it("returns ok:false for an import", async () => {
		const res = await validateScript("import x from 'y'\n" + META + "return {}");
		expect(res.ok).toBe(false);
		expect(res.error).toContain("import is not available");
	});
});
