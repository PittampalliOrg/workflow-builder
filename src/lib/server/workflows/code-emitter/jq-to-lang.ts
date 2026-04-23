/**
 * Minimal jq-subset classifier for the emitter.
 *
 * The shim (shim/runtime.*.txt) implements a small, pure-language jq subset
 * that covers the expressions actually observed in workflow-builder specs:
 *
 *   .foo.bar.baz            — nested path access
 *   .items[0]               — array index
 *   .items[]                — iteration (only legal inside for.in today)
 *   $.trigger.something     — root-relative path
 *   $task.output.something  — task output reference
 *   .x > 10   .x < .y       — comparisons
 *   .x == .y                — equality
 *   .flag and .other        — boolean composition
 *   .count + 1              — light arithmetic
 *
 * Anything outside this subset gets flagged so the caller can emit a warning
 * and let the shim decide what to do with it at runtime (it will log + return
 * undefined for unsupported expressions).
 */

const SUPPORTED_PATTERN = /^[\s$.\w\[\]"'+\-*\/<>=!,&|()?:]+$/;
const SUPPORTED_KEYWORDS = /\b(and|or|not|null|true|false)\b/;

export interface JqClassification {
	expression: string;
	/** True when the expression is within the shim's implemented subset. */
	supported: boolean;
}

export function classifyJq(expression: string): JqClassification {
	const trimmed = expression.trim();
	if (!trimmed) return { expression: trimmed, supported: false };

	// Reject SQL-like keywords and function calls the minimal subset doesn't handle
	const FORBIDDEN = [
		/\bmap\s*\(/,
		/\bselect\s*\(/,
		/\bgroup_by\s*\(/,
		/\bsort_by\s*\(/,
		/\bunique_by\s*\(/,
		/\breduce\s+/,
		/\bif\s+/,
		/\|\s*\w+/, // piped transforms
	];
	for (const pattern of FORBIDDEN) {
		if (pattern.test(trimmed)) {
			return { expression: trimmed, supported: false };
		}
	}

	if (!SUPPORTED_PATTERN.test(trimmed)) {
		// Allow known keyword words but reject anything else not in the char class
		const stripped = trimmed.replace(SUPPORTED_KEYWORDS, '');
		if (!SUPPORTED_PATTERN.test(stripped)) {
			return { expression: trimmed, supported: false };
		}
	}

	return { expression: trimmed, supported: true };
}

/**
 * Produce a JS string literal safe for emission: escapes backslashes, double
 * quotes, newlines. Used whenever the emitter needs to wrap a jq expression
 * in `ctx.jq("...")`.
 */
export function jsStringLiteral(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

/**
 * Python string literal — single-quoted with escaping. Uses triple-quoted
 * raw-string form when the value contains both kinds of quote so we never
 * escape characters inline.
 */
export function pyStringLiteral(value: string): string {
	if (!value.includes("'")) {
		return `'${value.replace(/\\/g, '\\\\')}'`;
	}
	if (!value.includes('"')) {
		return `"${value.replace(/\\/g, '\\\\')}"`;
	}
	const safe = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	return `'${safe}'`;
}
