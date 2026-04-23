/**
 * Intermediate representation for the visual→code emitter.
 *
 * Consumes a SW 1.0 spec's `do` array and normalizes each task into an
 * EmitNode. The TS and Python emitters both walk this IR so the heavy
 * lifting (jq expression extraction, inline-function rewriting, unsupported-
 * task passthrough) happens once, not per language.
 */

export interface InlinedFunction {
	/** sanitized identifier used at the call site */
	identifier: string;
	/** source code body (the code_function's `source`, rewritten so its
	 *  entrypoint matches `identifier`) */
	sourceSnippet: string;
	/** original code_function slug (before `code/` prefix) */
	slug: string;
	/** version string at emit time */
	version: string;
	/** short sha1 of the source for diffability */
	sha: string;
	/** language of the inlined function — must match the emitted workflow's
	 *  language; if mismatched, the caller falls back to shim dispatch */
	language: 'typescript' | 'python';
	/** supporting_files that must travel with the emitted workflow */
	supportingFiles: Record<string, string>;
}

export type EmitNode =
	| CallNode
	| SetNode
	| SwitchNode
	| ForNode
	| TryNode
	| WaitNode
	| DoNode
	| PassthroughNode;

export interface CallNode {
	kind: 'call';
	/** sanitized task name for the local `const` binding */
	taskName: string;
	/** the activity slug, e.g. "openai/chat" */
	slug: string;
	/** raw `with:` object from the spec */
	args: unknown;
	/** when present, the emitter writes a direct call instead of dispatching
	 *  through the shim */
	inlined?: InlinedFunction;
}

export interface SetNode {
	kind: 'set';
	taskName: string;
	assignments: Record<string, unknown>;
}

export interface SwitchCase {
	/** JQ expression or null for the default case */
	when: string | null;
	/** label to jump to, "continue", or "end" */
	then: string;
}

export interface SwitchNode {
	kind: 'switch';
	taskName: string;
	cases: SwitchCase[];
}

export interface ForNode {
	kind: 'for';
	taskName: string;
	/** iteration variable name */
	each: string;
	/** JQ expression for the iterable */
	in: string;
	body: EmitNode[];
}

export interface TryNode {
	kind: 'try';
	taskName: string;
	tryBody: EmitNode[];
	/** when null, the try has no catch handler */
	catchBody: EmitNode[] | null;
	catchWhen: string | null;
}

export interface WaitNode {
	kind: 'wait';
	taskName: string;
	/** ISO-8601 duration, e.g. "PT5S" */
	duration: string;
}

export interface DoNode {
	kind: 'do';
	taskName: string;
	steps: EmitNode[];
}

export interface PassthroughNode {
	kind: 'passthrough';
	taskName: string;
	/** original task-kind keyword (fork, listen, emit, raise, run, durable/run) */
	taskKind: string;
	/** raw task definition, preserved verbatim in a TODO block */
	raw: unknown;
	/** human-readable reason the emitter couldn't handle it */
	reason: string;
}

export interface EmitWorkflowInput {
	/** steps for the main workflow body */
	steps: EmitNode[];
	/** workflow name (used for the emitted function name and file banner) */
	workflowName: string;
	/** trigger input schema (from spec.input or spec.document["x-workflow-builder"].input.schema) */
	triggerSchema: Record<string, unknown> | null;
	/** the entire set of inlined functions, deduplicated by identifier */
	inlinedFunctions: InlinedFunction[];
	/** warnings surfaced during normalization (unsupported jq subset, missing
	 *  code_function, etc.) */
	warnings: string[];
	/** original SW 1.0 spec preserved so the emitter can embed it as a
	 *  round-trip anchor */
	originalSpec: Record<string, unknown>;
}

export interface CompositionSummary {
	activitySlugs: string[];
	hasFork: boolean;
	hasSwitch: boolean;
	hasDurableAgent: boolean;
}

export function summarizeComposition(steps: EmitNode[]): CompositionSummary {
	const slugs = new Set<string>();
	let hasFork = false;
	let hasSwitch = false;
	let hasDurableAgent = false;

	function walk(nodes: EmitNode[]): void {
		for (const node of nodes) {
			switch (node.kind) {
				case 'call':
					slugs.add(node.slug);
					if (node.slug === 'durable/run') hasDurableAgent = true;
					break;
				case 'switch':
					hasSwitch = true;
					break;
				case 'for':
					walk(node.body);
					break;
				case 'try':
					walk(node.tryBody);
					if (node.catchBody) walk(node.catchBody);
					break;
				case 'do':
					walk(node.steps);
					break;
				case 'passthrough':
					if (node.taskKind === 'fork') hasFork = true;
					if (node.taskKind === 'durable/run') hasDurableAgent = true;
					break;
				default:
					break;
			}
		}
	}

	walk(steps);
	return {
		activitySlugs: [...slugs].sort(),
		hasFork,
		hasSwitch,
		hasDurableAgent,
	};
}
