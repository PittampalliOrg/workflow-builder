/**
 * Walks a SW 1.0 spec's `do` array into the emitter IR (ir.ts).
 *
 * The normalizer is language-agnostic — it only handles task-shape
 * detection + jq extraction. Inlining happens in inline-resolver.ts, which
 * runs AFTER normalize so the resolver can see every code/<slug> call and
 * batch-fetch code_function rows.
 */

import type {
	DoNode,
	EmitNode,
	ForNode,
	PassthroughNode,
	SetNode,
	SwitchCase,
	SwitchNode,
	TryNode,
	WaitNode,
	CallNode,
} from './ir';

const UNSUPPORTED_KINDS = new Set(['fork', 'listen', 'emit', 'raise', 'run']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeTaskName(raw: string, fallback: string): string {
	const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, '_');
	if (!cleaned) return fallback;
	if (/^[0-9]/.test(cleaned)) return `_${cleaned}`;
	return cleaned;
}

function normalizeTask(
	taskName: string,
	taskDef: unknown,
	index: number,
	warnings: string[],
): EmitNode {
	const name = sanitizeTaskName(taskName, `task_${index}`);

	if (!isRecord(taskDef)) {
		return {
			kind: 'passthrough',
			taskName: name,
			taskKind: 'unknown',
			raw: taskDef,
			reason: 'Task definition was not an object',
		};
	}

	// durable/run agent turns — always passthrough in v1 (kept as shim call)
	const callSlug = typeof taskDef.call === 'string' ? taskDef.call : undefined;
	if (callSlug === 'durable/run') {
		return {
			kind: 'passthrough',
			taskName: name,
			taskKind: 'durable/run',
			raw: taskDef,
			reason: 'durable/run agent turns are emitted as raw shim calls in v1',
		};
	}

	if (callSlug) {
		const call: CallNode = {
			kind: 'call',
			taskName: name,
			slug: callSlug,
			args: taskDef.with ?? {},
		};
		return call;
	}

	if (isRecord(taskDef.set)) {
		const set: SetNode = {
			kind: 'set',
			taskName: name,
			assignments: taskDef.set as Record<string, unknown>,
		};
		return set;
	}

	if (taskDef.switch !== undefined) {
		return normalizeSwitch(name, taskDef.switch, warnings);
	}

	if (isRecord(taskDef.for)) {
		return normalizeFor(name, taskDef.for, warnings);
	}

	if (isRecord(taskDef.try)) {
		return normalizeTry(name, taskDef, warnings);
	}

	if (typeof taskDef.wait === 'string' || isRecord(taskDef.wait)) {
		return normalizeWait(name, taskDef.wait);
	}

	if (Array.isArray(taskDef.do)) {
		const nested: DoNode = {
			kind: 'do',
			taskName: name,
			steps: normalizeDoArray(taskDef.do as Array<Record<string, unknown>>, warnings),
		};
		return nested;
	}

	const kind = Object.keys(taskDef).find((key) => UNSUPPORTED_KINDS.has(key));
	if (kind) {
		warnings.push(
			`Task "${name}" uses "${kind}" which is emitted as a TODO passthrough in v1.`,
		);
		const passthrough: PassthroughNode = {
			kind: 'passthrough',
			taskName: name,
			taskKind: kind,
			raw: taskDef,
			reason: `${kind} is not yet supported by the emitter`,
		};
		return passthrough;
	}

	warnings.push(`Task "${name}" has no recognizable kind; emitting as TODO.`);
	return {
		kind: 'passthrough',
		taskName: name,
		taskKind: 'unknown',
		raw: taskDef,
		reason: 'No recognizable task kind (call/set/switch/for/try/wait/do)',
	};
}

function normalizeSwitch(
	name: string,
	rawCases: unknown,
	warnings: string[],
): SwitchNode {
	const cases: SwitchCase[] = [];
	const entries = Array.isArray(rawCases) ? rawCases : [];

	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const keys = Object.keys(entry);
		// SW 1.0 switch cases are keyed objects: { caseName: { when, then } }
		const caseKey = keys[0];
		const caseBody = caseKey ? entry[caseKey] : entry;
		if (!isRecord(caseBody)) continue;

		const when =
			typeof caseBody.when === 'string' ? extractJqExpression(caseBody.when) : null;
		const then =
			typeof caseBody.then === 'string' ? caseBody.then : 'continue';
		cases.push({ when, then });
	}

	if (cases.length === 0) {
		warnings.push(`Switch task "${name}" has no cases; emitting empty.`);
	}

	return { kind: 'switch', taskName: name, cases };
}

function normalizeFor(
	name: string,
	forDef: Record<string, unknown>,
	warnings: string[],
): ForNode {
	const each = typeof forDef.each === 'string' ? forDef.each : 'item';
	const iterableRaw = typeof forDef.in === 'string' ? forDef.in : '';
	const iterable = extractJqExpression(iterableRaw) ?? '';
	const body = Array.isArray(forDef.do)
		? normalizeDoArray(forDef.do as Array<Record<string, unknown>>, warnings)
		: [];

	return {
		kind: 'for',
		taskName: name,
		each: sanitizeTaskName(each, 'item'),
		in: iterable,
		body,
	};
}

function normalizeTry(
	name: string,
	taskDef: Record<string, unknown>,
	warnings: string[],
): TryNode {
	const tryBody = Array.isArray(taskDef.try)
		? normalizeDoArray(taskDef.try as Array<Record<string, unknown>>, warnings)
		: [];

	const catchBlock = isRecord(taskDef.catch) ? taskDef.catch : null;
	let catchBody: EmitNode[] | null = null;
	let catchWhen: string | null = null;
	if (catchBlock) {
		catchBody = Array.isArray(catchBlock.do)
			? normalizeDoArray(catchBlock.do as Array<Record<string, unknown>>, warnings)
			: [];
		catchWhen =
			typeof catchBlock.when === 'string'
				? extractJqExpression(catchBlock.when)
				: null;
	}

	return {
		kind: 'try',
		taskName: name,
		tryBody,
		catchBody,
		catchWhen,
	};
}

function normalizeWait(name: string, rawWait: unknown): WaitNode {
	if (typeof rawWait === 'string') {
		return { kind: 'wait', taskName: name, duration: rawWait };
	}
	if (isRecord(rawWait)) {
		const iso =
			typeof rawWait.duration === 'string'
				? rawWait.duration
				: typeof rawWait.for === 'string'
					? rawWait.for
					: 'PT0S';
		return { kind: 'wait', taskName: name, duration: iso };
	}
	return { kind: 'wait', taskName: name, duration: 'PT0S' };
}

export function normalizeDoArray(
	doArray: Array<unknown>,
	warnings: string[],
): EmitNode[] {
	const nodes: EmitNode[] = [];
	doArray.forEach((entry, index) => {
		if (!isRecord(entry)) return;
		const taskName = Object.keys(entry)[0];
		if (!taskName) return;
		const taskDef = entry[taskName];
		nodes.push(normalizeTask(taskName, taskDef, index, warnings));
	});
	return nodes;
}

/**
 * Pull the bare jq expression out of a SW 1.0 `${ .foo.bar }` wrapper. Returns
 * null for non-matching inputs so callers can mark them as non-jq literals.
 */
export function extractJqExpression(raw: string): string | null {
	const trimmed = raw.trim();
	const match = trimmed.match(/^\$\{\s*([\s\S]+?)\s*\}$/);
	return match ? match[1].trim() : null;
}

/**
 * Walks a value (object / array / scalar) and returns a structurally identical
 * clone where string values that look like `${ ... }` are replaced with a
 * marker `{ __jq: string }`. Emitters walk the marker tree and emit `ctx.jq(...)`
 * calls in place of literals.
 */
export type JqMarker = { __jq: string };
export function markJqExpressions(
	value: unknown,
): unknown | JqMarker {
	if (typeof value === 'string') {
		const expr = extractJqExpression(value);
		return expr ? { __jq: expr } : value;
	}
	if (Array.isArray(value)) {
		return value.map(markJqExpressions);
	}
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			out[key] = markJqExpressions(v);
		}
		return out;
	}
	return value;
}

export function extractTriggerSchema(
	spec: Record<string, unknown>,
): Record<string, unknown> | null {
	if (isRecord(spec.input)) {
		const schema = (spec.input as Record<string, unknown>).schema;
		if (isRecord(schema)) {
			const doc = schema.document;
			return isRecord(doc) ? (doc as Record<string, unknown>) : schema;
		}
	}
	const doc = spec.document;
	if (isRecord(doc)) {
		const xwb = doc['x-workflow-builder'];
		if (isRecord(xwb)) {
			const xwbInput = xwb.input;
			if (isRecord(xwbInput)) {
				const xwbSchema = xwbInput.schema;
				if (isRecord(xwbSchema)) {
					return xwbSchema as Record<string, unknown>;
				}
			}
		}
	}
	return null;
}

export function getWorkflowName(spec: Record<string, unknown>): string {
	const doc = spec.document;
	if (isRecord(doc)) {
		if (typeof doc.title === 'string' && doc.title.trim()) return doc.title.trim();
		if (typeof doc.name === 'string' && doc.name.trim()) return doc.name.trim();
	}
	return 'workflow';
}
