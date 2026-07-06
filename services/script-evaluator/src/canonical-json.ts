/**
 * Deterministic JSON serialization for callId derivation.
 *
 * Contract (FROZEN, see services/shared/contracts/script-evaluator-evaluate.contract.json):
 *   - object keys are sorted lexicographically at EVERY nesting level
 *   - array element order is PRESERVED
 *   - `undefined` object values are omitted (JSON.stringify parity)
 *   - `null` values are emitted verbatim as `null`
 *
 * This function is the single source of truth for canonicalization; both the
 * baseHash computation and any downstream consumer must go through it so that
 * hashes stay stable regardless of the key insertion order a script uses.
 */
export function canonicalJSON(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null) return "null";
	const t = typeof value;
	if (t === "number") {
		// JSON has no NaN/Infinity; normalize to null like JSON.stringify.
		return Number.isFinite(value as number)
			? JSON.stringify(value)
			: "null";
	}
	if (t === "string" || t === "boolean") {
		return JSON.stringify(value);
	}
	if (t === "bigint") {
		// bigint is not JSON-serializable; use its decimal string form.
		return JSON.stringify((value as bigint).toString());
	}
	if (Array.isArray(value)) {
		return "[" + value.map((v) => canonicalJSON(v)).join(",") + "]";
	}
	if (t === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj)
			.filter((k) => obj[k] !== undefined)
			.sort();
		return (
			"{" +
			keys
				.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k]))
				.join(",") +
			"}"
		);
	}
	// functions, symbols → treated as absent
	return "null";
}
