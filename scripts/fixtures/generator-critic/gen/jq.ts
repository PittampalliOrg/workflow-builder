/**
 * Tiny helpers for assembling SW 1.0 `${ ... }` jq expressions from readable
 * source. The whole point of the generator is that shell/python scripts are
 * authored ONCE as plain multi-line strings (with `__TOKEN__` splice points for
 * dynamic jq), then encoded into a single jq string-concat expression here — so
 * we never hand-escape JSON-in-jq-in-shell by eye.
 */

/** Encode a raw JS string as a jq string LITERAL (adds the surrounding quotes). */
export function toJqLiteral(raw: string): string {
	return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

type Part = { lit: string } | { expr: string };

/** Join parts (string literals + raw jq expressions) into `${ a + b + c }`. */
export function jqConcat(parts: Part[]): string {
	const body = parts
		.filter((p) => ("lit" in p ? p.lit.length > 0 : true))
		.map((p) => ("lit" in p ? toJqLiteral(p.lit) : `(${p.expr})`))
		.join(" + ");
	return `\${ ${body} }`;
}

/**
 * Build a command jq expression from a raw script and a token->jq-expr map.
 * Any `__UPPER_TOKEN__` in the script must have an entry in `subs` (throws
 * otherwise, to catch typos); everything else becomes a jq string literal.
 */
export function buildCommand(raw: string, subs: Record<string, string> = {}): string {
	const tokenRe = /(__[A-Z0-9_]+__)/g;
	const pieces = raw.split(tokenRe);
	const parts: Part[] = [];
	for (const piece of pieces) {
		if (piece === "") continue;
		if (/^__[A-Z0-9_]+__$/.test(piece)) {
			if (!(piece in subs)) throw new Error(`buildCommand: no substitution for token ${piece}`);
			parts.push({ expr: subs[piece] });
		} else {
			parts.push({ lit: piece });
		}
	}
	return jqConcat(parts);
}

/** Wrap a hand-written jq body in `${ ... }` (body uses real jq syntax). */
export function jqExpr(body: string): string {
	return `\${ ${body} }`;
}

/**
 * Canonical parse of the read_verdict node's compact JSON stdout into an object
 * (the SINGLE source of truth for accepted/stalled/gate/best/terminal). Falls
 * back to `{}` so first-iteration / missing reads are safe.
 */
export const READ_VERDICT_OBJ =
	'((.loop.last.read_verdict.result.stdout // .loop.last.read_verdict.stdout // .loop.last.read_verdict.result.output // .loop.last.read_verdict.output // "{}") | fromjson?) // {}';
