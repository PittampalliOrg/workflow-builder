import type { WorkflowTableEdge, WorkflowTableNode } from "./compile";
import {
	parseWorkflowSpec,
	WORKFLOW_SPEC_API_VERSION,
	type JsonValue,
	type WorkflowSpec,
} from "./types";

function toArray(next: string | string[] | undefined): string[] {
	if (!next) return [];
	return Array.isArray(next) ? next : [next];
}

function parseJsonish(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return "";
		if (
			(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
			(trimmed.startsWith("[") && trimmed.endsWith("]"))
		) {
			try {
				return JSON.parse(trimmed) as JsonValue;
			} catch {
				return value;
			}
		}
		if (trimmed === "true") return true;
		if (trimmed === "false") return false;
		if (trimmed === "null") return null;
		if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
			const n = Number(trimmed);
			if (Number.isFinite(n)) return n;
		}
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value as JsonValue;
	}
	if (value && typeof value === "object") {
		return value as JsonValue;
	}
	return String(value);
}

function normalizeTrigger(input: {
	triggerId: string;
	triggerNode?: WorkflowTableNode;
	triggerNext: string[];
}): WorkflowSpec["trigger"] {
	const { triggerId, triggerNode, triggerNext } = input;
	const triggerConfig =
		typeof triggerNode?.data?.config === "object" &&
		triggerNode.data.config != null
			? ({ ...(triggerNode.data.config as Record<string, unknown>) } as Record<
					string,
					unknown
				>)
			: {};

	const triggerTypeRaw = String(
		triggerConfig.triggerType || "Manual",
	).toLowerCase();
	delete triggerConfig.triggerType;

	const triggerBase = {
		id: triggerId,
		next:
			triggerNext.length === 0
				? undefined
				: triggerNext.length === 1
					? triggerNext[0]
					: triggerNext,
	};

	if (triggerTypeRaw === "webhook") {
		const webhookSchema = parseJsonish(triggerConfig.webhookSchema);
		const webhookMockRequest =
			typeof triggerConfig.webhookMockRequest === "string"
				? triggerConfig.webhookMockRequest
				: undefined;
		return {
			...triggerBase,
			type: "webhook",
			config: {
				...(webhookSchema !== undefined ? { webhookSchema } : {}),
				...(webhookMockRequest ? { webhookMockRequest } : {}),
			},
		};
	}

	if (triggerTypeRaw === "schedule") {
		return {
			...triggerBase,
			type: "schedule",
			config: {
				scheduleCron: String(triggerConfig.scheduleCron || ""),
				scheduleTimezone: String(
					triggerConfig.scheduleTimezone || "America/New_York",
				),
			},
		};
	}

	if (triggerTypeRaw === "mcp") {
		const inputSchema = parseJsonish(triggerConfig.inputSchema);
		const returnsResponse =
			typeof triggerConfig.returnsResponse === "string"
				? triggerConfig.returnsResponse.toLowerCase() === "true"
				: Boolean(triggerConfig.returnsResponse);
		const enabled =
			typeof triggerConfig.enabled === "string"
				? triggerConfig.enabled.toLowerCase() !== "false"
				: triggerConfig.enabled !== false;

		return {
			...triggerBase,
			type: "mcp",
			config: {
				toolName: String(triggerConfig.toolName || ""),
				...(typeof triggerConfig.toolDescription === "string" &&
				triggerConfig.toolDescription.trim().length > 0
					? { toolDescription: triggerConfig.toolDescription }
					: {}),
				...(inputSchema !== undefined ? { inputSchema } : {}),
				returnsResponse,
				enabled,
			},
		};
	}

	const manualConfig: Record<string, JsonValue> = {};
	for (const [k, v] of Object.entries(triggerConfig)) {
		const parsed = parseJsonish(v);
		if (parsed !== undefined) {
			manualConfig[k] = parsed;
		}
	}

	return {
		...triggerBase,
		type: "manual",
		config: manualConfig,
	};
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

	if (result.length !== ids.length) {
		return [...ids].sort((a, b) => a.localeCompare(b));
	}
	return result;
}

const SUPPORTED_KINDS = new Set<WorkflowSpec["steps"][number]["kind"]>([
	"action",
	"activity",
	"approval-gate",
	"timer",
	"if-else",
	"loop-until",
	"set-state",
	"transform",
	"workflow-control",
	"publish-event",
	"note",
]);

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

	const steps = nodes
		.filter((n) => n.id !== triggerId)
		.map((n) => {
			const kindRaw = String(n.data?.type || n.type || "").trim();
			if (
				!SUPPORTED_KINDS.has(kindRaw as WorkflowSpec["steps"][number]["kind"])
			) {
				throw new Error(
					`Unsupported node kind "${kindRaw}" in strict workflow-spec/v2 decompile.`,
				);
			}

			const config =
				typeof n.data?.config === "object" && n.data.config != null
					? ({ ...(n.data.config as Record<string, unknown>) } as Record<
							string,
							unknown
						>)
					: {};

			if (kindRaw === "timer") {
				const durationRaw =
					config.duration ??
					config.durationSeconds ??
					config.durationMinutes ??
					config.durationHours;
				const parsedDuration = Number(durationRaw ?? 60);
				config.duration =
					Number.isFinite(parsedDuration) && parsedDuration > 0
						? Math.floor(parsedDuration)
						: 60;
				const unitRaw = String(config.durationUnit || "").toLowerCase();
				if (
					unitRaw !== "seconds" &&
					unitRaw !== "minutes" &&
					unitRaw !== "hours" &&
					unitRaw !== "days"
				) {
					if (config.durationHours !== undefined) {
						config.durationUnit = "hours";
					} else if (config.durationMinutes !== undefined) {
						config.durationUnit = "minutes";
					} else {
						config.durationUnit = "seconds";
					}
				}
			}

			if (kindRaw === "transform") {
				config.templateJson = String(
					config.templateJson ?? config.template ?? "{\n  \n}",
				);
			}

			if (kindRaw === "workflow-control") {
				const modeRaw = String(config.mode || "stop")
					.trim()
					.toLowerCase();
				config.mode = modeRaw === "continue" ? "continue" : "stop";
				if (config.reason !== undefined && typeof config.reason !== "string") {
					config.reason = String(config.reason);
				}
			}

			return {
				id: n.id,
				kind: kindRaw as WorkflowSpec["steps"][number]["kind"],
				label: n.data?.label || n.id,
				description: n.data?.description,
				enabled: n.data?.enabled !== false,
				config,
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

	const triggerOut = (outgoing.get(triggerId) || [])
		.map((e) => e.target)
		.filter((t) => byId.has(t));
	const triggerNext = triggerOut.sort((a, b) => a.localeCompare(b));

	const specCandidate: WorkflowSpec = {
		apiVersion: WORKFLOW_SPEC_API_VERSION,
		name,
		description,
		trigger: normalizeTrigger({
			triggerId,
			triggerNode,
			triggerNext,
		}),
		steps: normalizedSteps.map((s) => {
			if (s.kind === "if-else") {
				const next = s.next as {
					true: string | string[];
					false: string | string[];
				};
				return {
					...s,
					next: { true: toArray(next.true), false: toArray(next.false) },
				} as WorkflowSpec["steps"][number];
			}

			if (s.next !== undefined) {
				const nx = s.next as string | string[] | undefined;
				return {
					...s,
					next: Array.isArray(nx) ? nx : nx,
				} as WorkflowSpec["steps"][number];
			}

			return s as WorkflowSpec["steps"][number];
		}),
	};

	return parseWorkflowSpec(specCandidate);
}
