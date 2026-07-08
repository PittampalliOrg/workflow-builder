/**
 * The re-execution sandbox — the core of script-evaluator.
 *
 * Each /evaluate is a FRESH, stateless re-run of the WHOLE user script in a
 * `vm.SourceTextModule` sandbox. Journaled (completed) agent()/workflow() calls
 * resolve immediately from `completedResults`; un-journaled calls register as
 * pending and return a never-settling promise so the script blocks on them.
 * A quiescence pump drains microtasks until the run reaches a stable state,
 * then classifies it:
 *
 *   module resolved                    -> done   (orphan pendings / a Promise in
 *                                                 returnValue -> script_error:
 *                                                 the forgotten-await guard)
 *   module rejected                    -> script_error
 *   module pending  AND pendings > 0   -> need   (tasks = pendings ∉ knownCallIds)
 *   module pending  AND pendings == 0  -> script_error (deadlock)
 *   host deadline exceeded             -> script_error (evaluation deadline exceeded)
 *
 * `node:vm` is NOT a security boundary — scripts are same-trust-domain as
 * workflow specs (see plan §Workstream 1). Determinism bans (Date/Math/timers)
 * are best-effort correctness guards, not sandbox escapes.
 *
 * Requires the process to run with --experimental-vm-modules.
 */
import vm from "node:vm";
import {
	agentSemanticOpts,
	computeBaseHash,
	deriveCallId,
	workflowSemanticOpts,
} from "./call-id.js";

export const EVALUATOR_VERSION = "1.1.0";

/** Response cap: no /evaluate response may carry more than this many tasks. */
export const MAX_TASKS_PER_RESPONSE = 4096;

// ── Public request/response types (mirror the /evaluate contract) ────────────

export interface CompletedResult {
	status: "done" | "null" | "error" | "skipped" | string;
	value?: unknown;
	errorCode?: string | null;
}

export interface EvaluateRequestBudget {
	total: number | null;
	spent: number;
	exhausted?: boolean;
	lifetimeExceeded?: boolean;
}

export interface EvaluateRequest {
	script: string;
	scriptSha256?: string;
	meta?: Record<string, unknown>;
	args?: unknown;
	nested?: boolean;
	budget?: EvaluateRequestBudget;
	completedResults?: Record<string, CompletedResult>;
	knownCallIds?: string[];
	seenLogCount?: number;
	limits?: { maxItemsPerCall?: number };
}

export interface TaskOpts {
	label: string | null;
	phase: string | null;
	schema: unknown;
	model: string | null;
	effort: string | null;
	isolation: string | null;
	agentType: string | null;
}

export interface EvaluateTask {
	callId: string;
	kind: "agent" | "workflow";
	prompt: string;
	opts: TaskOpts;
	baseHash: string;
	occurrence: number;
	workflowRef?: unknown;
	args?: unknown;
}

export interface EvaluateResponse {
	status: "need" | "done" | "script_error";
	tasks: EvaluateTask[];
	returnValue: unknown;
	error: { message: string; stack: string | null } | null;
	phases: { declared: string[]; current: string | null };
	newLogs: string[];
	logCount: number;
	counts: { totalCallsSeen: number };
	evaluatorVersion: string;
}

export interface ValidateResponse {
	ok: boolean;
	meta?: Record<string, unknown> | null;
	estimatedAgentCalls?: number;
	error?: string;
	evaluatorVersion: string;
}

// ── vm.SourceTextModule typing shim (experimental, not in @types/node) ───────

interface SourceTextModuleLike {
	link(linker: (specifier: string) => never): Promise<void>;
	evaluate(): Promise<void>;
}
type SourceTextModuleCtor = new (
	source: string,
	options: {
		context?: object;
		identifier?: string;
		importModuleDynamically?: () => never;
	},
) => SourceTextModuleLike;
const SourceTextModule = (vm as unknown as {
	SourceTextModule: SourceTextModuleCtor;
}).SourceTextModule;

// ── Small helpers ────────────────────────────────────────────────────────────

/** JSON round-trip clone; returns null on undefined or non-serializable input. */
function jsonSafe(value: unknown): unknown {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return null;
	}
}

/** Deep thenable scan for the forgotten-await guard. Cycle-safe, bounded.
 * Hook promises are HOST-realm objects (the injected globals are host
 * closures), so both the instanceof and the duck-typed `.then` check work. */
function containsThenable(value: unknown, depth = 0, seen = new Set<object>()): boolean {
	if (value === null || typeof value !== "object") return false;
	if (depth > 32 || seen.has(value)) return false;
	seen.add(value);
	if (
		value instanceof Promise ||
		typeof (value as { then?: unknown }).then === "function"
	) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.some((v) => containsThenable(v, depth + 1, seen));
	}
	for (const v of Object.values(value)) {
		if (containsThenable(v, depth + 1, seen)) return true;
	}
	return false;
}

function stringifyLogArg(arg: unknown): string {
	if (typeof arg === "string") return arg;
	if (arg === undefined) return "undefined";
	if (arg === null) return "null";
	try {
		return JSON.stringify(arg) ?? String(arg);
	} catch {
		return String(arg);
	}
}

/** Normalize meta.phases ([{title}] | [string] | undefined) to string[]. */
export function normalizePhases(phases: unknown): string[] {
	if (!Array.isArray(phases)) return [];
	const out: string[] = [];
	for (const p of phases) {
		if (typeof p === "string") out.push(p);
		else if (p && typeof p === "object" && typeof (p as any).title === "string") {
			out.push((p as any).title);
		}
	}
	return out;
}

// Errors thrown from inside a vm realm are NOT instanceof the host Error, so
// message/stack must be read via duck typing rather than instanceof.
function errMessage(e: unknown): string {
	const m = (e as { message?: unknown } | null)?.message;
	if (typeof m === "string" && m.length > 0) return m;
	return String(e);
}
function errStack(e: unknown): string | null {
	const s = (e as { stack?: unknown } | null)?.stack;
	return typeof s === "string" ? s : null;
}
function isSyntaxError(e: unknown): boolean {
	const name = (e as { name?: unknown } | null)?.name;
	return name === "SyntaxError" || String(e).startsWith("SyntaxError");
}
/** Detect a static `import` statement (banned). Dynamic import() is caught at
 * runtime by importModuleDynamically instead. */
function hasStaticImport(script: string): boolean {
	return /(?:^|[\n;])\s*import[\s'"({*]/.test(script);
}

function friendlyError(err: unknown, script: string): string {
	if (isSyntaxError(err) && hasStaticImport(script)) {
		return "import is not available in workflow scripts";
	}
	return errMessage(err);
}

function maskStringsAndComments(source: string): string {
	let out = "";
	let i = 0;
	let mode: "code" | "single" | "double" | "template" | "line" | "block" = "code";
	while (i < source.length) {
		const ch = source[i];
		const next = source[i + 1];
		if (mode === "code") {
			if (ch === "'" || ch === '"' || ch === "`") {
				mode = ch === "'" ? "single" : ch === '"' ? "double" : "template";
				out += "0";
				i++;
				continue;
			}
			if (ch === "/" && next === "/") {
				mode = "line";
				out += "  ";
				i += 2;
				continue;
			}
			if (ch === "/" && next === "*") {
				mode = "block";
				out += "  ";
				i += 2;
				continue;
			}
			out += ch;
			i++;
			continue;
		}
		out += ch === "\n" ? "\n" : " ";
		if ((mode === "single" && ch === "'") || (mode === "double" && ch === '"')) {
			mode = "code";
		} else if (mode === "template" && ch === "`") {
			mode = "code";
		} else if (mode === "line" && ch === "\n") {
			mode = "code";
		} else if (mode === "block" && ch === "*" && next === "/") {
			out += " ";
			i += 2;
			mode = "code";
			continue;
		}
		if ((mode === "single" || mode === "double" || mode === "template") && ch === "\\") {
			out += next === "\n" ? "\n" : " ";
			i += 2;
			continue;
		}
		i++;
	}
	return out;
}

function dateFunctionCallError(masked: string): string | null {
	const re = /(^|[^\w$])Date\s*\(/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(masked)) !== null) {
		const dateIndex = match.index + match[1].length;
		const prefix = masked.slice(0, dateIndex).trimEnd();
		if (!prefix.endsWith("new")) {
			return "Date() as a function is banned in workflow scripts (non-deterministic)";
		}
	}
	return null;
}

function staticDeterminismError(script: string): string | null {
	const masked = maskStringsAndComments(script);
	return (
		dateFunctionCallError(masked) ||
		(/\bnew\s+Date\s*\(\s*\)/.test(masked)
			? "new Date() with no arguments is banned in workflow scripts (non-deterministic)"
			: null) ||
		(/\bDate\s*\.\s*now\s*\(/.test(masked)
			? "Date.now() is banned in workflow scripts (non-deterministic)"
			: null) ||
		(/\bMath\s*\.\s*random\s*\(/.test(masked)
			? "Math.random() is banned in workflow scripts (non-deterministic)"
			: null) ||
		(/\b(?:setTimeout|setInterval|setImmediate|queueMicrotask|fetch|require|process)\b/.test(masked)
			? "timers, fetch, require, and process are not available in workflow scripts"
			: null) ||
		(/\bimport\s*\(/.test(masked)
			? "import is not available in workflow scripts"
			: null)
	);
}

// ── Wrapper source ───────────────────────────────────────────────────────────
//
// User scripts use the Claude Code dialect: bare top-level `return {...}` and a
// static `export const meta = {...}`. `export const meta` is stripped and
// evaluated separately; the remaining body is wrapped in an async IIFE (so bare
// `return` is legal and top-level `await` works) inside a SourceTextModule. A
// leading IIFE installs the determinism bans on the vm-native Date/Math without
// leaking the real intrinsics into the user body's scope.

const WRAPPER_PREFIX = `(() => {
  const RealDate = Date;
  const RealMath = Math;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, argsList) {
      if (argsList.length === 0) {
        throw new Error('new Date() with no arguments is banned in workflow scripts (non-deterministic)');
      }
      return Reflect.construct(target, argsList);
    },
    apply() {
      throw new Error('Date() as a function is banned in workflow scripts (non-deterministic)');
    },
    get(target, prop) {
      if (prop === 'now') {
        return () => { throw new Error('Date.now() is banned in workflow scripts (non-deterministic)'); };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  globalThis.Math = new Proxy(RealMath, {
    get(target, prop) {
      if (prop === 'random') {
        return () => { throw new Error('Math.random() is banned in workflow scripts (non-deterministic)'); };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
})();
globalThis.__result = await (async () => {
`;

const WRAPPER_SUFFIX = `
})();
`;

function buildWrapperSource(body: string): string {
	return WRAPPER_PREFIX + body + WRAPPER_SUFFIX;
}

// ── Static `export const meta` extraction ────────────────────────────────────

interface MetaExtraction {
	meta: Record<string, unknown> | undefined;
	body: string;
	ok: boolean;
	error?: string;
}

function skipString(src: string, i: number, quote: string): number {
	i++; // past the opening quote
	const n = src.length;
	while (i < n) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (quote === "`" && c === "$" && src[i + 1] === "{") {
			i += 2;
			let depth = 1;
			while (i < n && depth > 0) {
				const cc = src[i];
				if (cc === "{") depth++;
				else if (cc === "}") depth--;
				else if (cc === '"' || cc === "'" || cc === "`") {
					i = skipString(src, i, cc);
					continue;
				}
				i++;
			}
			continue;
		}
		if (c === quote) return i + 1;
		i++;
	}
	return n;
}

/** src[start] must be '{'; returns index just past the matching '}', or -1. */
function scanBalanced(src: string, start: number): number {
	let depth = 0;
	let i = start;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		if (c === '"' || c === "'" || c === "`") {
			i = skipString(src, i, c);
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			if (nl < 0) return -1;
			i = nl + 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end < 0) return -1;
			i = end + 2;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
		i++;
	}
	return -1;
}

export function extractMeta(script: string): MetaExtraction {
	const marker = /export\s+const\s+meta\s*=/;
	const m = marker.exec(script);
	if (!m) return { meta: undefined, body: script, ok: false };

	let i = m.index + m[0].length;
	while (i < script.length && /\s/.test(script[i])) i++;
	if (script[i] !== "{") {
		return {
			meta: undefined,
			body: script,
			ok: false,
			error: "export const meta must be an object literal",
		};
	}

	const end = scanBalanced(script, i);
	if (end < 0) {
		return {
			meta: undefined,
			body: script,
			ok: false,
			error: "unterminated meta object literal",
		};
	}

	const literal = script.slice(i, end);
	let after = end;
	while (after < script.length && /[ \t]/.test(script[after])) after++;
	if (script[after] === ";") after++;
	const body = script.slice(0, m.index) + script.slice(after);

	let meta: Record<string, unknown> | undefined;
	try {
		const raw = vm.runInNewContext(
			"(" + literal + ")",
			Object.create(null) as object,
			{ timeout: 1000 },
		);
		meta = jsonSafe(raw) as Record<string, unknown> | undefined;
		if (meta === null) meta = undefined;
	} catch {
		meta = undefined;
	}
	return { meta, body, ok: meta !== undefined };
}

// ── Determinism/limit errors thrown INTO the script ──────────────────────────

function makeBudgetError(): Error {
	const e = new Error("agent budget exhausted");
	e.name = "BudgetExhaustedError";
	return e;
}
function makeAgentLimitError(): Error {
	const e = new Error("agent lifetime limit exceeded");
	e.name = "AgentLimitError";
	return e;
}
/** Message thrown into the script for a failed workflow() child. The journal
 * stores the human reason in result.message (status 'error',
 * errorCode 'workflow_child_error'); fall back to the errorCode. */
function workflowChildErrorMessage(cr: CompletedResult): string {
	const value = cr.value as { message?: unknown } | null | undefined;
	if (
		value &&
		typeof value === "object" &&
		typeof value.message === "string" &&
		value.message.length > 0
	) {
		return value.message;
	}
	if (cr.errorCode) return String(cr.errorCode);
	return "workflow() child failed";
}

// ── The evaluator ────────────────────────────────────────────────────────────

interface Pending {
	callId: string;
	kind: "agent" | "workflow";
	prompt: string;
	optsRaw?: Record<string, unknown>;
	phaseAtCall: string | null;
	baseHash: string;
	occurrence: number;
	workflowRef?: unknown;
	args?: unknown;
}

export async function evaluateScript(
	req: EvaluateRequest,
): Promise<EvaluateResponse> {
	const deadlineMs = Number(process.env.SCRIPT_EVAL_TIMEOUT_MS ?? "10000") || 10000;
	const maxItemsPerCall = req.limits?.maxItemsPerCall ?? MAX_TASKS_PER_RESPONSE;
	const seenLogCount = Math.max(0, req.seenLogCount ?? 0);
	const knownCallIds = new Set(req.knownCallIds ?? []);
	const completedResults = req.completedResults ?? {};
	const nested = req.nested === true;
	const budgetExhausted = req.budget?.exhausted === true;
	const lifetimeExceeded = req.budget?.lifetimeExceeded === true;
	const budgetTotal = req.budget?.total ?? null;
	const budgetSpent = req.budget?.spent ?? 0;

	// Server-truth meta (extracted) drives declared phases; fall back to request.
	const extracted = extractMeta(req.script);
	const metaForPhases = extracted.meta ?? req.meta ?? {};
	const declaredPhases = normalizePhases((metaForPhases as any)?.phases);

	// Per-request mutable state (nothing survives the request → stateless).
	const state = {
		pendings: [] as Pending[],
		logs: [] as string[],
		phaseCalls: [] as string[],
		currentPhase: null as string | null,
		totalCallsSeen: 0,
		progress: 0,
	};
	const occCounter = new Map<string, number>();

	function nextOccurrence(baseHash: string): number {
		const cur = occCounter.get(baseHash) ?? 0;
		occCounter.set(baseHash, cur + 1);
		return cur;
	}

	function neverSettle(): Promise<never> {
		return new Promise<never>(() => {
			/* intentionally never resolves — blocks the awaiting script */
		});
	}

	function resolveFromJournal(cr: CompletedResult): Promise<unknown> {
		state.progress++;
		return Promise.resolve(cr.status === "done" ? cr.value : null);
	}

	// ── Host hook functions injected as sandbox globals ──
	function agent(prompt: unknown, opts?: unknown): Promise<unknown> {
		state.totalCallsSeen++;
		if (typeof prompt !== "string") {
			throw new TypeError("agent(prompt, opts): prompt must be a string");
		}
		if (prompt.includes("[object Promise]")) {
			// A prior hook result was interpolated without await — this prompt
			// would bill a real agent with garbage. Deterministic (same script
			// → same prompt → same throw), so replay-safe.
			throw new TypeError(
				'agent(prompt): prompt contains "[object Promise]" — a previous ' +
					"agent()/parallel()/workflow() result was used without `await`.",
			);
		}
		if (opts !== undefined && (typeof opts !== "object" || opts === null)) {
			throw new TypeError("agent(prompt, opts): opts must be an object");
		}
		const optsObj = opts as Record<string, unknown> | undefined;
		const baseHash = computeBaseHash(prompt, agentSemanticOpts(optsObj));
		const occurrence = nextOccurrence(baseHash);
		const callId = deriveCallId(baseHash, occurrence);

		const cr = completedResults[callId];
		if (cr) return resolveFromJournal(cr);
		if (budgetExhausted) throw makeBudgetError();
		if (lifetimeExceeded) throw makeAgentLimitError();

		state.pendings.push({
			callId,
			kind: "agent",
			prompt,
			optsRaw: optsObj,
			phaseAtCall: state.currentPhase,
			baseHash,
			occurrence,
		});
		state.progress++;
		return neverSettle();
	}

	function workflow(nameOrRef: unknown, args?: unknown): Promise<unknown> {
		state.totalCallsSeen++;
		if (nested) throw new Error("workflow() nesting is one level only");
		const promptSub =
			"workflow:" +
			(typeof nameOrRef === "string" ? nameOrRef : JSON.stringify(nameOrRef));
		const baseHash = computeBaseHash(promptSub, workflowSemanticOpts(args));
		const occurrence = nextOccurrence(baseHash);
		const callId = deriveCallId(baseHash, occurrence);

		const cr = completedResults[callId];
		if (cr) {
			// workflow() failure semantics differ from agent(): the Workflow-tool
			// contract says workflow() THROWS on an unknown name / unreadable ref /
			// child error so authors can try/catch — agent() resolves null instead.
			// done -> child returnValue; skipped (user skip) -> null; error/null ->
			// throw the journaled message (journal stores it as result.message).
			if (cr.status === "done" || cr.status === "skipped") {
				return resolveFromJournal(cr);
			}
			state.progress++;
			throw new Error(workflowChildErrorMessage(cr));
		}
		if (budgetExhausted) throw makeBudgetError();
		if (lifetimeExceeded) throw makeAgentLimitError();

		state.pendings.push({
			callId,
			kind: "workflow",
			prompt: "",
			phaseAtCall: state.currentPhase,
			baseHash,
			occurrence,
			workflowRef: nameOrRef,
			args,
		});
		state.progress++;
		return neverSettle();
	}

	function parallel(thunks: unknown): Promise<unknown[]> {
		if (!Array.isArray(thunks)) {
			throw new TypeError("parallel(thunks): expected an array of thunks");
		}
		if (thunks.length > maxItemsPerCall) {
			throw new Error(
				`parallel(): ${thunks.length} items exceeds maxItemsPerCall (${maxItemsPerCall})`,
			);
		}
		return Promise.all(
			thunks.map(async (t: unknown) => {
				try {
					return await (t as () => unknown)();
				} catch {
					return null;
				}
			}),
		);
	}

	function pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
		if (!Array.isArray(items)) {
			throw new TypeError("pipeline(items, ...stages): items must be an array");
		}
		if (items.length > maxItemsPerCall) {
			throw new Error(
				`pipeline(): ${items.length} items exceeds maxItemsPerCall (${maxItemsPerCall})`,
			);
		}
		const stageFns = stages as Array<
			(value: unknown, original: unknown, index: number) => unknown
		>;
		return Promise.all(
			items.map(async (item: unknown, index: number) => {
				let value = item;
				for (const stage of stageFns) {
					try {
						value = await stage(value, item, index);
					} catch {
						return null;
					}
				}
				return value;
			}),
		);
	}

	function phase(title: unknown): void {
		const t = typeof title === "string" ? title : String(title);
		state.currentPhase = t;
		state.phaseCalls.push(t);
		state.progress++;
	}

	function log(msg: unknown): void {
		state.logs.push(stringifyLogArg(msg));
		state.progress++;
	}

	// console.log AND the other console.* methods all route to the same log sink.
	// The Claude Code spec only guarantees log()/console.log, but scripts ported
	// from that habit commonly use console.error/warn/info/debug — mapping them all
	// (rather than leaving them undefined, which would throw a TypeError and abort
	// the script) is a strict superset that keeps such scripts running.
	const consoleWrite = (...consoleArgs: unknown[]) => {
		state.logs.push(consoleArgs.map(stringifyLogArg).join(" "));
		state.progress++;
	};
	const consoleShim = Object.freeze({
		log: consoleWrite,
		error: consoleWrite,
		warn: consoleWrite,
		info: consoleWrite,
		debug: consoleWrite,
	});

	const budgetGlobal = Object.freeze({
		total: budgetTotal,
		spent: () => budgetSpent,
		remaining: () =>
			budgetTotal == null ? Infinity : Math.max(0, budgetTotal - budgetSpent),
	});

	// args is the run's VERBATIM input — any JSON value (object/array/scalar/
	// null), deep-frozen. Key-absence is meaningful: no `args` key -> the
	// script's `args` global is undefined (Workflow-tool parity: "undefined if
	// not provided"). JSON.parse never produces undefined, so `"args" in req`
	// is the reliable presence signal.
	const argsGlobal =
		"args" in req && req.args !== undefined
			? deepFreeze(jsonSafe(req.args))
			: undefined;

	// ── Build the sandbox context ──
	const sandbox: Record<string, unknown> = Object.create(null);
	sandbox.agent = Object.freeze(agent);
	sandbox.parallel = Object.freeze(parallel);
	sandbox.pipeline = Object.freeze(pipeline);
	sandbox.phase = Object.freeze(phase);
	sandbox.log = Object.freeze(log);
	sandbox.workflow = Object.freeze(workflow);
	sandbox.console = consoleShim;
	sandbox.args = argsGlobal;
	sandbox.budget = budgetGlobal;

	const phasesResult = { declared: declaredPhases, current: null as string | null };

	let module: SourceTextModuleLike;
	try {
		const context = vm.createContext(sandbox, {
			name: "script-evaluator",
			codeGeneration: { strings: false, wasm: false },
		});
		const source = buildWrapperSource(extracted.body);
		module = new SourceTextModule(source, {
			context,
			identifier: "workflow-script",
			importModuleDynamically: () => {
				throw new Error("import is not available in workflow scripts");
			},
		});
		await module.link(() => {
			throw new Error("import is not available in workflow scripts");
		});
	} catch (err) {
		// Syntax error / import / link failure: pre-execution script_error.
		phasesResult.current = state.currentPhase;
		return scriptErrorResponse(
			friendlyError(err, req.script),
			errStack(err),
			phasesResult,
			state.logs.slice(seenLogCount),
			state.logs.length,
			state.totalCallsSeen,
		);
	}

	// ── Run + quiescence pump ──
	let settled = false;
	let rejected = false;
	let evalError: unknown = null;
	module.evaluate().then(
		() => {
			settled = true;
		},
		(e) => {
			settled = true;
			rejected = true;
			evalError = e;
		},
	);

	const start = Date.now();
	let deadlineHit = false;
	let lastProgress = -1;
	// Bounded loop; the no-progress break is the normal exit for `need`.
	for (let i = 0; i < 1_000_000; i++) {
		if (Date.now() - start > deadlineMs) {
			deadlineHit = true;
			break;
		}
		await new Promise((r) => setImmediate(r)); // drain vm microtasks
		if (settled) break;
		if (state.progress === lastProgress) break; // quiescent
		lastProgress = state.progress;
	}

	phasesResult.current = state.currentPhase;
	const newLogs = state.logs.slice(seenLogCount);
	const logCount = state.logs.length;
	const totalCallsSeen = state.totalCallsSeen;

	if (deadlineHit) {
		return scriptErrorResponse(
			"evaluation deadline exceeded",
			null,
			phasesResult,
			newLogs,
			logCount,
			totalCallsSeen,
		);
	}

	if (settled && !rejected) {
		// Forgotten-await guards. A script that completes with un-awaited hook
		// calls (or returns a Promise inside its value) used to "succeed" with
		// silent garbage — `{}` / "[object Promise]" reached real agent prompts
		// and returnValues (live-caught 2026-07-07). Fail loudly instead: the
		// author gets a validation-grade error naming the fix.
		if (state.pendings.length > 0) {
			const kinds = [...new Set(state.pendings.map((p) => `${p.kind}()`))].join(
				", ",
			);
			return scriptErrorResponse(
				`script completed with ${state.pendings.length} un-awaited ${kinds} ` +
					"call(s). Every hook returns a Promise — add `await` " +
					"(e.g. `const x = await agent(...)`, " +
					"`const [a, b] = await parallel([...])`).",
				null,
				phasesResult,
				newLogs,
				logCount,
				totalCallsSeen,
			);
		}
		if (containsThenable(sandbox.__result)) {
			return scriptErrorResponse(
				"returnValue contains an un-awaited Promise. Every hook returns a " +
					"Promise — add `await` before agent()/parallel()/pipeline()/" +
					"workflow() results you return.",
				null,
				phasesResult,
				newLogs,
				logCount,
				totalCallsSeen,
			);
		}
		return {
			status: "done",
			tasks: [],
			returnValue: jsonSafe(sandbox.__result),
			error: null,
			phases: phasesResult,
			newLogs,
			logCount,
			counts: { totalCallsSeen },
			evaluatorVersion: EVALUATOR_VERSION,
		};
	}

	if (settled && rejected) {
		return scriptErrorResponse(
			errMessage(evalError),
			errStack(evalError),
			phasesResult,
			newLogs,
			logCount,
			totalCallsSeen,
		);
	}

	// Not settled → module is still pending.
	if (state.pendings.length > 0) {
		const tasks = state.pendings
			.filter((p) => !knownCallIds.has(p.callId))
			.map(toTask);
		if (tasks.length > MAX_TASKS_PER_RESPONSE) {
			return scriptErrorResponse(
				`too many tasks in one response: ${tasks.length} exceeds ${MAX_TASKS_PER_RESPONSE}`,
				null,
				phasesResult,
				newLogs,
				logCount,
				totalCallsSeen,
			);
		}
		return {
			status: "need",
			tasks,
			returnValue: null,
			error: null,
			phases: phasesResult,
			newLogs,
			logCount,
			counts: { totalCallsSeen },
			evaluatorVersion: EVALUATOR_VERSION,
		};
	}

	// Pending with no outstanding calls → deadlock.
	return scriptErrorResponse(
		"script is awaiting but has no pending agent() calls (deadlock)",
		null,
		phasesResult,
		newLogs,
		logCount,
		totalCallsSeen,
	);
}

function toTask(p: Pending): EvaluateTask {
	const phase =
		(p.optsRaw?.phase as string | undefined) ?? p.phaseAtCall ?? null;
	if (p.kind === "workflow") {
		return {
			callId: p.callId,
			kind: "workflow",
			prompt: "",
			opts: {
				label: null,
				phase,
				schema: null,
				model: null,
				effort: null,
				isolation: null,
				agentType: null,
			},
			baseHash: p.baseHash,
			occurrence: p.occurrence,
			workflowRef: jsonSafe(p.workflowRef),
			// Omit args entirely when the parent passed nothing so the child's
			// `args` global is undefined (jsonSafe(undefined) would coerce to null,
			// losing the distinction the contract preserves).
			...(p.args === undefined ? {} : { args: jsonSafe(p.args) }),
		};
	}
	const o = p.optsRaw ?? {};
	return {
		callId: p.callId,
		kind: "agent",
		prompt: p.prompt,
		opts: {
			label: (o.label as string | undefined) ?? null,
			phase,
			schema: jsonSafe(o.schema ?? null),
			model: (o.model as string | undefined) ?? null,
			effort: (o.effort as string | undefined) ?? null,
			isolation: (o.isolation as string | undefined) ?? null,
			agentType: (o.agentType as string | undefined) ?? null,
		},
		baseHash: p.baseHash,
		occurrence: p.occurrence,
	};
}

function scriptErrorResponse(
	message: string,
	stack: string | null,
	phases: { declared: string[]; current: string | null },
	newLogs: string[],
	logCount: number,
	totalCallsSeen: number,
): EvaluateResponse {
	return {
		status: "script_error",
		tasks: [],
		returnValue: null,
		error: { message, stack },
		phases,
		newLogs,
		logCount,
		counts: { totalCallsSeen },
		evaluatorVersion: EVALUATOR_VERSION,
	};
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const key of Object.keys(value as Record<string, unknown>)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
		Object.freeze(value);
	}
	return value;
}

// ── /validate: static meta + syntax check, no execution ──────────────────────

export async function validateScript(script: string): Promise<ValidateResponse> {
	const extracted = extractMeta(script);
	const estimatedAgentCalls = (script.match(/\bagent\s*\(/g) ?? []).length;
	const lintError = staticDeterminismError(extracted.body);
	if (lintError) {
		return {
			ok: false,
			error: lintError,
			evaluatorVersion: EVALUATOR_VERSION,
		};
	}
	try {
		const context = vm.createContext(Object.create(null) as object, {
			name: "script-evaluator-validate",
			codeGeneration: { strings: false, wasm: false },
		});
		const source = buildWrapperSource(extracted.body);
		const mod = new SourceTextModule(source, {
			context,
			identifier: "workflow-script-validate",
			importModuleDynamically: () => {
				throw new Error("import is not available in workflow scripts");
			},
		});
		await mod.link(() => {
			throw new Error("import is not available in workflow scripts");
		});
		// Deliberately NOT evaluated — meta is statically extracted.
	} catch (err) {
		return {
			ok: false,
			error: friendlyError(err, script),
			evaluatorVersion: EVALUATOR_VERSION,
		};
	}
	return {
		ok: true,
		meta: extracted.meta ?? null,
		estimatedAgentCalls,
		evaluatorVersion: EVALUATOR_VERSION,
	};
}
