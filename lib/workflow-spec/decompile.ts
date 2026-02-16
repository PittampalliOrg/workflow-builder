import type { WorkflowTableEdge, WorkflowTableNode } from "./compile";
import {
	JsonValueSchema,
	WORKFLOW_SPEC_API_VERSION,
	type JsonValue,
	type WorkflowSpec,
} from "./types";

function toArray(next: string | string[] | undefined): string[] {
	if (!next) return [];
	return Array.isArray(next) ? next : [next];
}

function coerceJsonValueRecord(
	input: Record<string, unknown>,
): Record<string, JsonValue> {
	const out: Record<string, JsonValue> = {};
	for (const [k, v] of Object.entries(input)) {
		const parsed = JsonValueSchema.safeParse(v);
		if (parsed.success) {
			out[k] = parsed.data;
		}
	}
	return out;
}

function topoSortNodeIds(
	nodes: WorkflowTableNode[],
	edges: WorkflowTableEdge[],
): string[] {
	const ids = nodes.map((n) => n.id);
	const idSet = new Set(ids);

	const inDeg = new Map<string, number>();
	const out = new Map<string, string[]>();
	for (const id of ids) {
		inDeg.set(id, 0);
		out.set(id, []);
	}
	for (const e of edges) {
		if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
		out.get(e.source)?.push(e.target);
		inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
	}

	const queue = ids
		.filter((id) => (inDeg.get(id) || 0) === 0)
		.sort((a, b) => a.localeCompare(b));
	const result: string[] = [];
	while (queue.length > 0) {
		const id = queue.shift()!;
		result.push(id);
		for (const n of (out.get(id) || []).sort((a, b) => a.localeCompare(b))) {
			const next = (inDeg.get(n) || 0) - 1;
			inDeg.set(n, next);
			if (next === 0) {
				queue.push(n);
				queue.sort((a, b) => a.localeCompare(b));
			}
		}
	}

	// If cycles exist, fall back to stable id order.
	if (result.length !== ids.length) {
		return [...ids].sort((a, b) => a.localeCompare(b));
	}
	return result;
}

export function decompileGraphToWorkflowSpec(input: {
	name: string;
	description?: string;
	nodes: WorkflowTableNode[];
	edges: WorkflowTableEdge[];
}): WorkflowSpec {
	const { name, description, nodes, edges } = input;

	const triggerNode =
		nodes.find((n) => n.type === "trigger" || n.data?.type === "trigger") ||
		nodes[0];
	const triggerId = triggerNode?.id || "trigger";
	const triggerTypeRaw = String(
		(triggerNode?.data?.config as Record<string, unknown> | undefined)
			?.triggerType || "Manual",
	);

	const steps = nodes
		.filter((n) => n.id !== triggerId)
		.map((n) => {
			const kind = (n.data?.type || n.type) as string;
			return {
				id: n.id,
				kind,
				label: n.data?.label || n.id,
				description: n.data?.description,
				enabled: n.data?.enabled !== false,
				config:
					(typeof n.data?.config === "object" && n.data?.config != null
						? (n.data.config as Record<string, unknown>)
						: {}) || {},
			};
		});

	const byId = new Map(steps.map((s) => [s.id, s]));

	const outgoing = new Map<string, WorkflowTableEdge[]>();
	for (const e of edges) {
		const list = outgoing.get(e.source) || [];
		list.push(e);
		outgoing.set(e.source, list);
	}

	const orderedStepIds = topoSortNodeIds(
		[
			{
				id: triggerId,
				type: "trigger",
				position: { x: 0, y: 0 },
				data: { label: "Trigger", type: "trigger" },
			},
			...steps.map((s) => ({
				id: s.id,
				type: s.kind,
				position: { x: 0, y: 0 },
				data: { label: s.label, type: s.kind },
			})),
		],
		edges,
	).filter((id) => id !== triggerId);

	const normalizedSteps = orderedStepIds
		.map((id) => byId.get(id))
		.filter((s): s is NonNullable<typeof s> => Boolean(s))
		.map((s) => {
			const outs = (outgoing.get(s.id) || []).filter(
				(e) => e.target !== triggerId,
			);
			if (s.kind === "if-else") {
				const trues = outs
					.filter((e) => (e.sourceHandle || null) === "true")
					.map((e) => e.target)
					.sort((a, b) => a.localeCompare(b));
				const falses = outs
					.filter((e) => (e.sourceHandle || null) === "false")
					.map((e) => e.target)
					.sort((a, b) => a.localeCompare(b));
				return {
					...s,
					next: {
						true: trues.length === 1 ? trues[0] : trues,
						false: falses.length === 1 ? falses[0] : falses,
					},
				};
			}
			const targets = outs
				.map((e) => e.target)
				.sort((a, b) => a.localeCompare(b));
			return {
				...s,
				next:
					targets.length === 0
						? undefined
						: targets.length === 1
							? targets[0]
							: targets,
			};
		});

	// Trigger.next: only set if it differs from auto-root behavior; we keep it undefined by default.
	const triggerOut = (outgoing.get(triggerId) || [])
		.map((e) => e.target)
		.filter((t) => byId.has(t));
	const triggerNext = triggerOut.sort((a, b) => a.localeCompare(b));

	const triggerConfig =
		typeof triggerNode?.data?.config === "object" &&
		triggerNode.data.config != null
			? (triggerNode.data.config as Record<string, unknown>)
			: {};

	const spec: WorkflowSpec = {
		apiVersion: WORKFLOW_SPEC_API_VERSION,
		name,
		description,
		trigger: {
			id: triggerId,
			type: triggerTypeRaw.toLowerCase() === "webhook" ? "webhook" : "manual",
			config: coerceJsonValueRecord(triggerConfig),
			next:
				triggerNext.length === 0
					? undefined
					: triggerNext.length === 1
						? triggerNext[0]
						: triggerNext,
		},
		steps: normalizedSteps.map((s) => {
			// Ensure kind aligns with supported spec kinds; unknown kinds are exported as notes.
			const supportedKinds = new Set([
				"action",
				"approval-gate",
				"timer",
				"if-else",
				"loop-until",
				"set-state",
				"transform",
				"publish-event",
				"note",
			]);
			const kind = supportedKinds.has(s.kind)
				? (s.kind as WorkflowSpec["steps"][number]["kind"])
				: "note";
			const base = {
				id: s.id,
				kind,
				label: s.label,
				description: s.description,
				enabled: s.enabled,
				config: s.config,
			} as any;

			if (kind === "if-else") {
				const next = s.next as {
					true: string | string[];
					false: string | string[];
				};
				base.next = { true: toArray(next.true), false: toArray(next.false) };
				return base;
			}

			if (s.next !== undefined) {
				const nx = s.next as string | string[] | undefined;
				base.next = Array.isArray(nx) ? nx : nx;
			}
			return base;
		}),
	};

	return spec;
}
