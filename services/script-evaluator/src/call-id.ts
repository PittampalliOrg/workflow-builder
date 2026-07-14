/**
 * callId derivation - FROZEN by the /evaluate contract.
 *
 *   baseHash = sha256( prompt + NUL + canonicalJSON(semanticOpts) )  (hex)
 *   callId   = baseHash[:40] + "_" + occurrence
 *
 * The separator is the NUL character (U+0000). semanticOpts for an agent()
 * call = { schema, model, effort, isolation, agentType, label } with
 * undefined/null keys OMITTED; for a workflow() call = { args } (again
 * omitting undefined/null). `occurrence` is the per-baseHash encounter counter
 * (0-based) in script issue order - tracked by the sandbox, not here.
 */
import { createHash } from "node:crypto";
import { canonicalJSON } from "./canonical-json.js";

/** The opts keys that participate in callId derivation, in canonical set.
 * `agent` (named-agent slug) joined additively in contract 1.2.0 — omit-nullish
 * keeps every pre-1.2.0 callId byte-identical, and canonicalJSON sorts keys so
 * list position is irrelevant. */
export const SEMANTIC_OPT_KEYS = [
	"schema",
	"model",
	"effort",
	"isolation",
	"agentType",
	"label",
	"agent",
] as const;

/** NUL (U+0000) separator between prompt and canonicalized semantic opts. */
export const HASH_SEPARATOR = "\u0000";

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function omitNullish(
	source: Record<string, unknown>,
	keys: readonly string[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of keys) {
		const v = source[k];
		if (v === undefined || v === null) continue;
		out[k] = v;
	}
	return out;
}

/** Build the semanticOpts object for an agent() call. */
export function agentSemanticOpts(
	opts: Record<string, unknown> | undefined,
): Record<string, unknown> {
	return omitNullish(opts ?? {}, SEMANTIC_OPT_KEYS);
}

/** Build the semanticOpts object for a workflow() call. */
export function workflowSemanticOpts(args: unknown): Record<string, unknown> {
	return omitNullish({ args }, ["args"]);
}

// ── Contract 1.2.0 additive kinds (action / sleep / event) ──────────────────
// Derivations (additive; the agent/workflow/team derivations above are FROZEN):
//   action:  promptSub = "action:" + slug;  semanticOpts = { args: input, connection }
//   sleep:   promptSub = "sleep";           semanticOpts = { seconds }
//   event:   promptSub = "event:" + name;   semanticOpts = {}
// Execution knobs (label/timeoutMs/allowFailure/idempotent/timeoutMinutes) are
// deliberately NOT hashed: tuning them must never re-execute a completed side
// effect on resume. Disambiguation of identical calls comes from `args`
// (action) or occurrence (all kinds).

/** Build the semanticOpts object for an action() call. */
export function actionSemanticOpts(
	input: unknown,
	connection: unknown,
): Record<string, unknown> {
	return omitNullish({ args: input, connection }, ["args", "connection"]);
}

/** Build the semanticOpts object for a sleep() call. */
export function sleepSemanticOpts(seconds: number): Record<string, unknown> {
	return { seconds };
}

/** Build the semanticOpts object for an approve()/waitForEvent() call. */
export function eventSemanticOpts(): Record<string, unknown> {
	return {};
}

export function computeBaseHash(
	prompt: string,
	semanticOpts: Record<string, unknown>,
): string {
	return sha256Hex(prompt + HASH_SEPARATOR + canonicalJSON(semanticOpts));
}

export function deriveCallId(baseHash: string, occurrence: number): string {
	return baseHash.slice(0, 40) + "_" + occurrence;
}
