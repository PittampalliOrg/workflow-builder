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

/** The opts keys that participate in callId derivation, in canonical set. */
export const SEMANTIC_OPT_KEYS = [
	"schema",
	"model",
	"effort",
	"isolation",
	"agentType",
	"label",
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

export function computeBaseHash(
	prompt: string,
	semanticOpts: Record<string, unknown>,
): string {
	return sha256Hex(prompt + HASH_SEPARATOR + canonicalJSON(semanticOpts));
}

export function deriveCallId(baseHash: string, occurrence: number): string {
	return baseHash.slice(0, 40) + "_" + occurrence;
}
