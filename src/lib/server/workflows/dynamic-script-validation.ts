/**
 * Validation for dynamic-script (engineType `dynamic-script`) workflows.
 *
 * Two layers:
 *  1. `validateDynamicScriptSpec` — CHEAP, synchronous, always runs: enforces the
 *     size cap (`DYNAMIC_SCRIPT_MAX_BYTES`, default 256 KiB), the `meta` shape
 *     (name required, description/phases optional), and a static gate that the
 *     script actually exports `meta` (`export const meta = …`). Returns a
 *     normalized meta so persistence has a canonical shape even before the
 *     evaluator confirms it.
 *  2. `validateWithEvaluator` — AUTHORITATIVE, async: POSTs the script to the
 *     script-evaluator `/validate` endpoint which re-runs the module in a vm
 *     sandbox for the server-truth `meta` + `estimatedAgentCalls`. When the
 *     evaluator is unreachable we usually DEGRADE to the static result (a save
 *     must not hard-fail because a stateless helper is down); the start path
 *     passes `degradeOnUnavailable:false` because execution requires the
 *     evaluator anyway.
 *
 * Wired into workflow create/update (`workflow-definition-commands.ts`): a 400
 * on validation failure; on success the evaluator meta + estimatedAgentCalls are
 * persisted into `spec.meta`.
 */

import { env } from "$env/dynamic/private";

export const DEFAULT_DYNAMIC_SCRIPT_MAX_BYTES = 262144;

export const SCRIPT_EVALUATOR_URL =
	env.SCRIPT_EVALUATOR_URL ??
	"http://script-evaluator.workflow-builder.svc.cluster.local:8080";

/** Normalized phase entry — `{ title }` (extra keys preserved). */
export type DynamicScriptPhase = { title: string; [k: string]: unknown };

export type DynamicScriptMeta = {
	name: string;
	description?: string;
	phases?: DynamicScriptPhase[];
	estimatedAgentCalls?: number;
	[k: string]: unknown;
};

export type DynamicScriptSpec = {
	engine: "dynamic-script";
	script: string;
	meta: DynamicScriptMeta;
	defaults?: { budgetTotal?: number | null; args?: Record<string, unknown> };
	[k: string]: unknown;
};

export type ValidateResult =
	| { ok: true; meta: DynamicScriptMeta; estimatedAgentCalls?: number }
	| { ok: false; status: number; error: string };

function maxBytes(): number {
	const raw = Number(env.DYNAMIC_SCRIPT_MAX_BYTES);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DYNAMIC_SCRIPT_MAX_BYTES;
}

/** Static gate: the script must declare `export const meta = …`. */
const EXPORT_META_RE = /export\s+const\s+meta\s*=/;

function normalizePhases(raw: unknown): DynamicScriptPhase[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const phases: DynamicScriptPhase[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			phases.push({ title: entry });
		} else if (entry && typeof entry === "object") {
			const e = entry as Record<string, unknown>;
			const title =
				typeof e.title === "string"
					? e.title
					: typeof e.name === "string"
						? (e.name as string)
						: "";
			if (title) phases.push({ ...e, title });
		}
	}
	return phases.length ? phases : undefined;
}

function normalizeMeta(
	raw: unknown,
): { ok: true; meta: DynamicScriptMeta } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: "spec.meta must be an object with a required `name`" };
	}
	const m = raw as Record<string, unknown>;
	if (typeof m.name !== "string" || m.name.trim() === "") {
		return { ok: false, error: "spec.meta.name is required and must be a non-empty string" };
	}
	const meta: DynamicScriptMeta = { ...m, name: m.name.trim() };
	if (m.description !== undefined) {
		if (typeof m.description !== "string") {
			return { ok: false, error: "spec.meta.description must be a string when present" };
		}
		meta.description = m.description;
	}
	const phases = normalizePhases(m.phases);
	if (phases) meta.phases = phases;
	else delete meta.phases;
	// meta.team.tokenBudget — the team-wide token cap the orchestrator forwards
	// to ensure-script-team. Validated here so authors get a clear error at
	// validate time instead of a silently-ignored budget at run time.
	if (m.team !== undefined) {
		if (!m.team || typeof m.team !== "object" || Array.isArray(m.team)) {
			return { ok: false, error: "spec.meta.team must be an object when present" };
		}
		const budget = (m.team as Record<string, unknown>).tokenBudget;
		if (
			budget !== undefined &&
			(typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0)
		) {
			return {
				ok: false,
				error: "spec.meta.team.tokenBudget must be a positive number when present",
			};
		}
	}
	return { ok: true, meta };
}

/**
 * Cheap synchronous validation of a dynamic-script spec. Returns the normalized
 * meta on success. Does NOT contact the evaluator.
 */
export function validateDynamicScriptSpec(spec: unknown): ValidateResult {
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
		return { ok: false, status: 400, error: "dynamic-script spec must be an object" };
	}
	const s = spec as Record<string, unknown>;
	if (s.engine !== "dynamic-script") {
		return { ok: false, status: 400, error: "spec.engine must be 'dynamic-script'" };
	}
	if (typeof s.script !== "string" || s.script.trim() === "") {
		return { ok: false, status: 400, error: "spec.script must be a non-empty string" };
	}
	const size = Buffer.byteLength(s.script, "utf8");
	const limit = maxBytes();
	if (size > limit) {
		return {
			ok: false,
			status: 400,
			error: `script is ${size} bytes; exceeds DYNAMIC_SCRIPT_MAX_BYTES (${limit})`,
		};
	}
	if (!EXPORT_META_RE.test(s.script)) {
		return {
			ok: false,
			status: 400,
			error: "script must declare `export const meta = …`",
		};
	}
	const meta = normalizeMeta(s.meta);
	if (!meta.ok) {
		return { ok: false, status: 400, error: meta.error };
	}
	return { ok: true, meta: meta.meta };
}

type EvaluatorValidateResponse = {
	ok?: boolean;
	error?: string;
	meta?: unknown;
	estimatedAgentCalls?: number;
};

/**
 * Authoritative validation via the stateless script-evaluator `/validate`
 * endpoint. Returns server-truth meta + estimatedAgentCalls. When the evaluator
 * is unreachable, DEGRADES to a static-only pass (still runs the static gate).
 */
export async function validateWithEvaluator(
	script: string,
	opts: {
		signal?: AbortSignal;
		baseUrl?: string;
		degradeOnUnavailable?: boolean;
	} = {},
): Promise<ValidateResult> {
	const staticResult = validateDynamicScriptSpec({
		engine: "dynamic-script",
		script,
		// meta is resolved by the evaluator; the static gate only needs the export.
		meta: extractStaticMeta(script) ?? { name: "script" },
	});
	if (!staticResult.ok) return staticResult;

	const base = opts.baseUrl ?? SCRIPT_EVALUATOR_URL;
	try {
		const response = await fetch(`${base}/validate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ script }),
			signal: opts.signal ?? AbortSignal.timeout(10000),
		});
		if (!response.ok) {
			// 4xx from the evaluator is authoritative rejection (banned API, invalid
			// meta, too large); surface it. 5xx → degrade to static.
			if (response.status >= 400 && response.status < 500) {
				const detail = await response.text().catch(() => "script validation failed");
				return { ok: false, status: 400, error: detail || "script validation failed" };
			}
			if (opts.degradeOnUnavailable === false) {
				const detail = await response.text().catch(() => "");
				return {
					ok: false,
					status: 503,
					error: detail || "script evaluator unavailable",
				};
			}
			return staticResult;
		}
		const data = (await response.json().catch(() => null)) as EvaluatorValidateResponse | null;
		if (!data || data.ok === false) {
			return { ok: false, status: 400, error: data?.error ?? "script validation failed" };
		}
		const normalized = normalizeMeta(data.meta ?? staticResult.meta);
		if (!normalized.ok) {
			return { ok: false, status: 400, error: normalized.error };
		}
		const meta = normalized.meta;
		const estimatedAgentCalls =
			typeof data.estimatedAgentCalls === "number" && data.estimatedAgentCalls >= 0
				? data.estimatedAgentCalls
				: undefined;
		if (estimatedAgentCalls !== undefined) meta.estimatedAgentCalls = estimatedAgentCalls;
		return { ok: true, meta, estimatedAgentCalls };
	} catch (err) {
		if (opts.degradeOnUnavailable === false) {
			const detail =
				err instanceof Error ? err.message : "script evaluator unavailable";
			return {
				ok: false,
				status: 503,
				error: `script evaluator unavailable: ${detail}`,
			};
		}
		// Evaluator unreachable — degrade to the static result. The start path passes
		// `degradeOnUnavailable:false` before actually executing.
		return staticResult;
	}
}

/**
 * Best-effort static extraction of the `meta` object literal for a default
 * workflow name before the evaluator confirms it. Parses the FIRST balanced
 * object literal after `export const meta =`. Returns undefined when it can't be
 * parsed as JSON-ish (the evaluator is the real authority).
 */
export function extractStaticMeta(script: string): DynamicScriptMeta | undefined {
	const m = script.match(/export\s+const\s+meta\s*=\s*(\{)/);
	if (!m || m.index === undefined) return undefined;
	const start = script.indexOf("{", m.index);
	if (start < 0) return undefined;
	let depth = 0;
	let end = -1;
	for (let i = start; i < script.length; i++) {
		const ch = script[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end < 0) return undefined;
	const literal = script.slice(start, end + 1);
	// Extract just the string name if present — full JS-literal parsing is the
	// evaluator's job; here we only want a friendly default name.
	const nameMatch = literal.match(/name\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
	const descMatch = literal.match(/description\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/);
	if (!nameMatch) return undefined;
	const meta: DynamicScriptMeta = { name: nameMatch[2] };
	if (descMatch) meta.description = descMatch[2];
	return meta;
}
