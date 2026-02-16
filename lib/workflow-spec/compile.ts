import type { TriggerSpec, WorkflowSpec } from "./types";
import { layoutDagPositions } from "./layout";

export type WorkflowTableNode = {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: {
		label: string;
		description?: string;
		type: string;
		config?: Record<string, unknown>;
		status?: "idle" | "running" | "success" | "error";
		enabled?: boolean;
	};
};

export type WorkflowTableEdge = {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string | null;
	targetHandle?: string | null;
	type?: string;
};

function normalizeNext(next: string | string[] | undefined): string[] {
	if (!next) return [];
	return Array.isArray(next) ? next : [next];
}

function sortEdgesStable(edges: WorkflowTableEdge[]): WorkflowTableEdge[] {
	return [...edges].sort((a, b) => {
		const ak = `${a.source}\n${a.sourceHandle ?? ""}\n${a.target}`;
		const bk = `${b.source}\n${b.sourceHandle ?? ""}\n${b.target}`;
		return ak.localeCompare(bk);
	});
}

function toUiTriggerConfig(trigger: TriggerSpec): Record<string, unknown> {
	const config = { ...(trigger.config || {}) } as Record<string, unknown>;

	switch (trigger.type) {
		case "webhook": {
			const webhookSchema = config.webhookSchema;
			if (webhookSchema !== undefined && typeof webhookSchema !== "string") {
				config.webhookSchema = JSON.stringify(webhookSchema);
			}
			return { ...config, triggerType: "Webhook" };
		}
		case "schedule":
			return { ...config, triggerType: "Schedule" };
		case "mcp": {
			const inputSchema = config.inputSchema;
			if (inputSchema !== undefined && typeof inputSchema !== "string") {
				config.inputSchema = JSON.stringify(inputSchema);
			}
			if (typeof config.returnsResponse === "boolean") {
				config.returnsResponse = String(config.returnsResponse);
			}
			if (typeof config.enabled === "boolean") {
				config.enabled = String(config.enabled);
			}
			return { ...config, triggerType: "MCP" };
		}
		case "manual":
		default:
			return { ...config, triggerType: "Manual" };
	}
}

export function compileWorkflowSpecToGraph(spec: WorkflowSpec): {
	nodes: WorkflowTableNode[];
	edges: WorkflowTableEdge[];
} {
	const triggerId = spec.trigger.id || "trigger";
	const stepIds = new Set(spec.steps.map((s) => s.id));

	const edges: WorkflowTableEdge[] = [];
	const incoming = new Map<string, number>();
	for (const s of spec.steps) incoming.set(s.id, 0);

	const pushEdge = (edge: Omit<WorkflowTableEdge, "id">) => {
		edges.push({
			id: `${edge.source}=>${edge.target}${edge.sourceHandle ? `:${edge.sourceHandle}` : ""}`,
			...edge,
			type: "animated",
		});
		incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
	};

	for (const step of spec.steps) {
		if (step.kind === "if-else") {
			const nextTrue = normalizeNext(step.next.true);
			const nextFalse = normalizeNext(step.next.false);
			for (const tgt of nextTrue) {
				if (stepIds.has(tgt)) {
					pushEdge({ source: step.id, target: tgt, sourceHandle: "true" });
				}
			}
			for (const tgt of nextFalse) {
				if (stepIds.has(tgt)) {
					pushEdge({ source: step.id, target: tgt, sourceHandle: "false" });
				}
			}
		} else {
			const next = normalizeNext(step.next as string | string[] | undefined);
			for (const tgt of next) {
				if (stepIds.has(tgt)) {
					pushEdge({ source: step.id, target: tgt, sourceHandle: null });
				}
			}
		}
	}

	const triggerNext = normalizeNext(spec.trigger.next);
	const roots =
		triggerNext.length > 0
			? triggerNext.filter((id) => stepIds.has(id))
			: spec.steps
					.map((s) => s.id)
					.filter((id) => (incoming.get(id) || 0) === 0);

	for (const tgt of roots.sort((a, b) => a.localeCompare(b))) {
		pushEdge({ source: triggerId, target: tgt, sourceHandle: null });
	}

	const layoutNodes = [
		{ id: triggerId, kind: "trigger" },
		...spec.steps.map((s) => ({ id: s.id, kind: s.kind })),
	];
	const positions = layoutDagPositions({
		nodes: layoutNodes,
		edges: edges.map((e) => ({
			source: e.source,
			target: e.target,
			sourceHandle: e.sourceHandle,
		})),
		startId: triggerId,
	});

	const nodes: WorkflowTableNode[] = [
		{
			id: triggerId,
			type: "trigger",
			position: positions[triggerId] || { x: 0, y: 0 },
			data: {
				label: "Trigger",
				description: spec.description,
				type: "trigger",
				config: toUiTriggerConfig(spec.trigger),
				status: "idle" as const,
				enabled: true,
			},
		},
		...spec.steps.map(
			(s): WorkflowTableNode => ({
				id: s.id,
				type: s.kind,
				position: positions[s.id] || { x: 0, y: 0 },
				data: {
					label: s.label,
					description: s.description,
					type: s.kind,
					config: (s as { config?: Record<string, unknown> }).config || {},
					status: "idle" as const,
					enabled: s.enabled !== false,
				},
			}),
		),
	];

	return { nodes, edges: sortEdgesStable(edges) };
}
