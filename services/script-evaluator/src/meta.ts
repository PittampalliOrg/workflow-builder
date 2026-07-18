import vm from "node:vm";

export interface MetaExtraction {
	meta: Record<string, unknown> | undefined;
	body: string;
	ok: boolean;
	error?: string;
}

/** JSON round-trip clone; returns null on undefined or non-serializable input. */
function jsonSafe(value: unknown): unknown {
	if (value === undefined) return null;
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return null;
	}
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
	// Preserve source coordinates when the evaluator removes the meta export.
	const padding = script.slice(m.index, after).replace(/[^\n]/g, " ");
	const body = script.slice(0, m.index) + padding + script.slice(after);

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
