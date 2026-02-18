import type { ActionDefinition } from "@/lib/actions/types";
import type { WorkflowSpecCatalog } from "./catalog";
import { buildActionConfigSchema } from "./action-config-zod";
import type { StepSpec, WorkflowSpec } from "./types";
import { WorkflowSpecSchema } from "./types";

export type LintIssue = {
	code: string;
	message: string;
	path: string;
	nodeId?: string;
};

export type WorkflowSpecLintResult = {
	errors: LintIssue[];
	warnings: LintIssue[];
};

type Graph = {
	nodeIds: string[];
	startId: string;
	out: Map<string, Array<{ target: string; sourceHandle?: string | null }>>;
	preds: Map<string, string[]>;
};

function addIssue(
	target: "errors" | "warnings",
	acc: WorkflowSpecLintResult,
	issue: LintIssue,
): void {
	acc[target].push(issue);
}

function normalizeNext(next: string | string[] | undefined): string[] {
	if (!next) return [];
	return Array.isArray(next) ? next : [next];
}

function buildGraph(spec: WorkflowSpec): Graph {
	const startId = spec.trigger.id || "trigger";
	const stepIds = spec.steps.map((s) => s.id);
	const nodeIds = [startId, ...stepIds];
	const idSet = new Set(nodeIds);

	const out = new Map<
		string,
		Array<{ target: string; sourceHandle?: string | null }>
	>();
	const preds = new Map<string, string[]>();
	for (const id of nodeIds) {
		out.set(id, []);
		preds.set(id, []);
	}

	const push = (
		source: string,
		target: string,
		sourceHandle?: string | null,
	) => {
		if (!idSet.has(source) || !idSet.has(target)) return;
		out.get(source)?.push({ target, sourceHandle: sourceHandle ?? null });
		preds.get(target)?.push(source);
	};

	// Step edges
	for (const step of spec.steps) {
		if (step.kind === "if-else") {
			const nextTrue = normalizeNext(step.next.true);
			const nextFalse = normalizeNext(step.next.false);
			for (const t of nextTrue) push(step.id, t, "true");
			for (const t of nextFalse) push(step.id, t, "false");
		} else {
			const next = normalizeNext(step.next as string | string[] | undefined);
			for (const t of next) push(step.id, t, null);
		}
	}

	// Trigger edges: explicit or inferred roots
	const explicitTriggerNext = normalizeNext(spec.trigger.next);
	if (explicitTriggerNext.length > 0) {
		for (const t of explicitTriggerNext) push(startId, t, null);
	} else {
		const incomingCounts = new Map<string, number>();
		for (const id of stepIds) incomingCounts.set(id, 0);
		for (const [src, list] of out) {
			if (src === startId) continue;
			for (const e of list) {
				if (incomingCounts.has(e.target)) {
					incomingCounts.set(e.target, (incomingCounts.get(e.target) || 0) + 1);
				}
			}
		}
		const roots = stepIds.filter((id) => (incomingCounts.get(id) || 0) === 0);
		for (const t of roots) push(startId, t, null);
	}

	// Stable sort outgoing and predecessors
	for (const [id, list] of out) {
		list.sort((a, b) =>
			`${a.target}\n${a.sourceHandle ?? ""}`.localeCompare(
				`${b.target}\n${b.sourceHandle ?? ""}`,
			),
		);
		out.set(id, list);
	}
	for (const [id, list] of preds) {
		list.sort((a, b) => a.localeCompare(b));
		preds.set(id, list);
	}

	return { nodeIds, startId, out, preds };
}

function topoSort(graph: Graph): { order: string[]; hasCycle: boolean } {
	const { nodeIds, preds, out } = graph;
	const indeg = new Map<string, number>();
	for (const id of nodeIds) indeg.set(id, preds.get(id)?.length || 0);

	const queue = nodeIds
		.filter((id) => (indeg.get(id) || 0) === 0)
		.sort((a, b) => a.localeCompare(b));
	const result: string[] = [];

	while (queue.length > 0) {
		const id = queue.shift()!;
		result.push(id);
		for (const e of out.get(id) || []) {
			const n = e.target;
			const next = (indeg.get(n) || 0) - 1;
			indeg.set(n, next);
			if (next === 0) {
				queue.push(n);
				queue.sort((a, b) => a.localeCompare(b));
			}
		}
	}

	return { order: result, hasCycle: result.length !== nodeIds.length };
}

function computeAncestors(graph: Graph): Map<string, Set<string>> {
	const { nodeIds, preds } = graph;
	const ancestors = new Map<string, Set<string>>();

	for (const id of nodeIds) {
		const seen = new Set<string>();
		const stack = [...(preds.get(id) || [])];
		while (stack.length > 0) {
			const cur = stack.pop()!;
			if (seen.has(cur)) continue;
			seen.add(cur);
			for (const p of preds.get(cur) || []) stack.push(p);
		}
		ancestors.set(id, seen);
	}

	return ancestors;
}

function computeDominators(
	graph: Graph,
	topo: string[],
): Map<string, Set<string>> {
	const { nodeIds, startId, preds } = graph;
	const all = new Set(nodeIds);
	const dom = new Map<string, Set<string>>();

	for (const id of nodeIds) {
		dom.set(id, id === startId ? new Set([startId]) : new Set(all));
	}

	// DAG-friendly single pass in topo order is enough for stable graphs.
	for (const id of topo) {
		if (id === startId) continue;
		const ps = preds.get(id) || [];
		if (ps.length === 0) {
			dom.set(id, new Set([id, startId]));
			continue;
		}
		let intersect: Set<string> | null = null;
		for (const p of ps) {
			const pd = dom.get(p) || new Set(all);
			if (intersect == null) {
				intersect = new Set(pd);
			} else {
				for (const v of [...intersect]) {
					if (!pd.has(v)) intersect.delete(v);
				}
			}
		}
		const next = intersect ?? new Set<string>();
		next.add(id);
		dom.set(id, next);
	}

	return dom;
}

type TemplateRef = {
	nodeId: string;
	fieldPath: string;
	raw: string;
};

const CANONICAL_REF_PATTERN = /\{\{@([^:}]+):([^}]+)\}\}/g;

function parseCanonicalRefs(s: string): TemplateRef[] {
	const refs: TemplateRef[] = [];
	for (const match of s.matchAll(CANONICAL_REF_PATTERN)) {
		const nodeId = match[1]?.trim() || "";
		const rest = match[2]?.trim() || "";
		if (!nodeId) continue;
		const dot = rest.indexOf(".");
		const fieldPath = dot === -1 ? "" : rest.slice(dot + 1).trim();
		refs.push({ nodeId, fieldPath, raw: match[0] || "" });
	}
	return refs;
}

function walkStrings(
	value: unknown,
	basePath: string,
	cb: (s: string, path: string) => void,
): void {
	if (typeof value === "string") {
		cb(value, basePath);
		return;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i += 1) {
			walkStrings(value[i], `${basePath}/${i}`, cb);
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			walkStrings(v, `${basePath}/${k}`, cb);
		}
	}
}

function validateActionConfigWithZod(input: {
	action: ActionDefinition;
	step: Extract<StepSpec, { kind: "action" }>;
	result: WorkflowSpecLintResult;
}): void {
	const { action, step, result } = input;
	const schema = buildActionConfigSchema(action);
	const parsed = schema.safeParse(step.config || {});
	if (parsed.success) {
		return;
	}

	for (const issue of parsed.error.issues) {
		const key = issue.path.join("/");
		addIssue("errors", result, {
			code: "INVALID_ACTION_CONFIG",
			message: issue.message,
			path: `/steps/${step.id}/config${key ? `/${key}` : ""}`,
			nodeId: step.id,
		});
	}
}

const DEFAULT_TRIGGER_OUTPUT_FIELDS = [
	"triggered",
	"timestamp",
	"input",
] as const;

function getRootOutputField(fieldPath: string): string | undefined {
	const first = fieldPath.split(/[.[\]]/)[0]?.trim();
	return first || undefined;
}

function collectWebhookSchemaFieldPaths(
	schema: unknown,
	prefix = "",
): string[] {
	if (!Array.isArray(schema)) {
		return [];
	}

	const fields: string[] = [];
	for (const item of schema) {
		if (!item || typeof item !== "object") {
			continue;
		}

		const field = item as Record<string, unknown>;
		const name = typeof field.name === "string" ? field.name.trim() : "";
		if (!name) {
			continue;
		}

		const fieldPath = prefix ? `${prefix}.${name}` : name;
		fields.push(fieldPath);

		const nestedFields = field.fields;
		const type = typeof field.type === "string" ? field.type : "";
		const itemType = typeof field.itemType === "string" ? field.itemType : "";
		if (Array.isArray(nestedFields) && nestedFields.length > 0) {
			if (type === "object") {
				fields.push(...collectWebhookSchemaFieldPaths(nestedFields, fieldPath));
			} else if (type === "array" && itemType === "object") {
				fields.push(
					...collectWebhookSchemaFieldPaths(nestedFields, `${fieldPath}[0]`),
				);
			}
		}
	}

	return fields;
}

function getTriggerOutputFieldSet(spec: WorkflowSpec): Set<string> {
	const allowed = new Set<string>(DEFAULT_TRIGGER_OUTPUT_FIELDS);
	const triggerConfig = spec.trigger.config as
		| Record<string, unknown>
		| undefined;
	const triggerType =
		typeof triggerConfig?.triggerType === "string"
			? triggerConfig.triggerType.toLowerCase()
			: "";

	if (triggerType !== "webhook") {
		return allowed;
	}

	const webhookSchema =
		typeof triggerConfig?.webhookSchema === "string"
			? triggerConfig.webhookSchema
			: "";
	if (!webhookSchema.trim()) {
		return allowed;
	}

	try {
		const parsedSchema = JSON.parse(webhookSchema);
		const schemaFields = collectWebhookSchemaFieldPaths(parsedSchema);
		for (const schemaField of schemaFields) {
			const root = getRootOutputField(schemaField);
			if (root) {
				allowed.add(root);
			}
		}
	} catch {
		// Ignore invalid schema JSON and keep default trigger fields.
	}

	return allowed;
}

function validateActionOutputFieldRefs(input: {
	action: ActionDefinition;
	ref: TemplateRef;
	result: WorkflowSpecLintResult;
	path: string;
	nodeId: string;
}): void {
	const { action, ref, result, path, nodeId } = input;
	if (!ref.fieldPath) return;
	if (!action.outputFields || action.outputFields.length === 0) return;

	const first = getRootOutputField(ref.fieldPath);
	if (!first) return;
	const allowed = new Set(action.outputFields.map((f) => f.field));
	if (!allowed.has(first)) {
		addIssue("warnings", result, {
			code: "UNKNOWN_OUTPUT_FIELD",
			message: `Template references unknown output field "${first}" on "${action.id}".`,
			path,
			nodeId,
		});
	}
}

function validateTriggerOutputFieldRefs(input: {
	allowedFields: Set<string>;
	ref: TemplateRef;
	result: WorkflowSpecLintResult;
	path: string;
	nodeId: string;
}): void {
	const { allowedFields, ref, result, path, nodeId } = input;
	if (!ref.fieldPath) return;

	const first = getRootOutputField(ref.fieldPath);
	if (!first || allowedFields.has(first)) return;

	addIssue("warnings", result, {
		code: "UNKNOWN_OUTPUT_FIELD",
		message: `Template references unknown output field "${first}" on trigger.`,
		path,
		nodeId,
	});
}

export function lintWorkflowSpec(
	input: unknown,
	options?: {
		catalog?: WorkflowSpecCatalog;
		unknownActionType?: "error" | "warn";
	},
): { spec?: WorkflowSpec; result: WorkflowSpecLintResult } {
	const result: WorkflowSpecLintResult = { errors: [], warnings: [] };

	const parsed = WorkflowSpecSchema.safeParse(input);
	if (!parsed.success) {
		for (const issue of parsed.error.issues) {
			addIssue("errors", result, {
				code: "INVALID_SPEC",
				message: issue.message,
				path: `/${issue.path.join("/")}`,
			});
		}
		return { result };
	}

	const spec = parsed.data;
	const catalog = options?.catalog;
	const unknownActionTypeMode = options?.unknownActionType ?? "warn";
	if (!catalog) {
		addIssue("warnings", result, {
			code: "CATALOG_UNAVAILABLE",
			message:
				"Action catalog is not available; skipping action existence, required field, and output field validation.",
			path: "/",
		});
	}

	// Uniqueness
	const ids = new Set<string>();
	const allIds = [spec.trigger.id, ...spec.steps.map((s) => s.id)];
	for (const id of allIds) {
		if (ids.has(id)) {
			addIssue("errors", result, {
				code: "DUPLICATE_ID",
				message: `Duplicate id "${id}".`,
				path: "/",
			});
		}
		ids.add(id);
	}

	// Graph target existence checks
	const stepIdSet = new Set(spec.steps.map((s) => s.id));
	for (const step of spec.steps) {
		const stepPath = `/steps/${step.id}`;
		if (step.kind === "if-else") {
			for (const [branch, nx] of [
				["true", step.next.true] as const,
				["false", step.next.false] as const,
			]) {
				const targets = normalizeNext(nx);
				if (targets.length === 0) {
					addIssue("errors", result, {
						code: "EMPTY_BRANCH",
						message: `if-else "${step.id}" is missing targets for branch "${branch}".`,
						path: `${stepPath}/next/${branch}`,
						nodeId: step.id,
					});
				}
				for (const t of targets) {
					if (!stepIdSet.has(t)) {
						addIssue("errors", result, {
							code: "UNKNOWN_TARGET",
							message: `Unknown target step "${t}" referenced from "${step.id}".`,
							path: `${stepPath}/next/${branch}`,
							nodeId: step.id,
						});
					}
				}
			}
		} else {
			const targets = normalizeNext(step.next as string | string[] | undefined);
			for (const t of targets) {
				if (!stepIdSet.has(t)) {
					addIssue("errors", result, {
						code: "UNKNOWN_TARGET",
						message: `Unknown target step "${t}" referenced from "${step.id}".`,
						path: `${stepPath}/next`,
						nodeId: step.id,
					});
				}
			}
		}
	}

	const graph = buildGraph(spec);
	const topo = topoSort(graph);
	if (topo.hasCycle) {
		addIssue("errors", result, {
			code: "CYCLE_DETECTED",
			message: "Workflow contains a cycle in control-flow edges.",
			path: "/",
		});
		return { spec, result };
	}

	// loop-until consistency (mirrors runtime constraints)
	const indexById = new Map(topo.order.map((id, idx) => [id, idx]));
	for (const step of spec.steps) {
		if (step.kind !== "loop-until") continue;
		const start = step.config.loopStartNodeId;
		if (!stepIdSet.has(start)) {
			addIssue("errors", result, {
				code: "UNKNOWN_LOOP_START",
				message: `loopStartNodeId "${start}" does not exist.`,
				path: `/steps/${step.id}/config/loopStartNodeId`,
				nodeId: step.id,
			});
			continue;
		}
		const startIdx = indexById.get(start);
		const stepIdx = indexById.get(step.id);
		if (startIdx == null || stepIdx == null || startIdx >= stepIdx) {
			addIssue("errors", result, {
				code: "INVALID_LOOP_START_ORDER",
				message: `loopStartNodeId must come before the loop node in execution order.`,
				path: `/steps/${step.id}/config/loopStartNodeId`,
				nodeId: step.id,
			});
		}
	}

	const ancestors = computeAncestors(graph);
	const dominators = computeDominators(graph, topo.order);
	const triggerOutputFields = getTriggerOutputFieldSet(spec);

	// Action existence + required fields
	for (const step of spec.steps) {
		if (step.kind !== "action") continue;
		const actionType = String(step.config.actionType || "").trim();
		if (!actionType) {
			addIssue("errors", result, {
				code: "MISSING_ACTION_TYPE",
				message: `Action step "${step.id}" is missing config.actionType.`,
				path: `/steps/${step.id}/config/actionType`,
				nodeId: step.id,
			});
			continue;
		}

		if (catalog) {
			const action = catalog.actionsById.get(actionType);
			if (!action) {
				addIssue(
					unknownActionTypeMode === "error" ? "errors" : "warnings",
					result,
					{
						code: "UNKNOWN_ACTION_TYPE",
						message: `Unknown actionType "${actionType}".`,
						path: `/steps/${step.id}/config/actionType`,
						nodeId: step.id,
					},
				);
				continue;
			}

			validateActionConfigWithZod({ action, step, result });
		}
	}

	// Template references
	for (const step of spec.steps) {
		const stepConfig =
			(step as { config?: Record<string, unknown> }).config || {};
		walkStrings(stepConfig, `/steps/${step.id}/config`, (s, path) => {
			for (const ref of parseCanonicalRefs(s)) {
				if (!ids.has(ref.nodeId)) {
					addIssue("errors", result, {
						code: "BROKEN_REFERENCE",
						message: `Template references missing node "${ref.nodeId}".`,
						path,
						nodeId: step.id,
					});
					continue;
				}

				const isUpstream =
					ancestors.get(step.id)?.has(ref.nodeId) ||
					ref.nodeId === spec.trigger.id;
				if (!isUpstream) {
					addIssue("errors", result, {
						code: "NON_UPSTREAM_REFERENCE",
						message: `Template references "${ref.nodeId}" which is not upstream of "${step.id}".`,
						path,
						nodeId: step.id,
					});
					continue;
				}

				const dom = dominators.get(step.id);
				if (dom && !dom.has(ref.nodeId)) {
					addIssue("warnings", result, {
						code: "MAYBE_UNSET_REFERENCE",
						message: `Template references "${ref.nodeId}" but it may not execute on all paths before "${step.id}".`,
						path,
						nodeId: step.id,
					});
				}

				// Output field existence check (warn-only)
				if (ref.nodeId === spec.trigger.id) {
					validateTriggerOutputFieldRefs({
						allowedFields: triggerOutputFields,
						ref,
						result,
						path,
						nodeId: step.id,
					});
					continue;
				}

				const producer = spec.steps.find((s2) => s2.id === ref.nodeId);
				if (producer?.kind === "action" && catalog) {
					const action = catalog.actionsById.get(
						String(producer.config.actionType || ""),
					);
					if (action) {
						validateActionOutputFieldRefs({
							action,
							ref,
							result,
							path,
							nodeId: step.id,
						});
					}
				}
			}
		});
	}

	return { spec, result };
}
