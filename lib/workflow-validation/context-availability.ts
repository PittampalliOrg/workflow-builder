import type { WorkflowEdge, WorkflowNode } from "@/lib/workflow-store";
import type { AvailableContextByNodeId } from "./types";

const DEFAULT_CEL_INPUT_FIELDS = [
	"success",
	"data",
	"error",
	"text",
	"toolCalls",
	"fileChanges",
	"daprInstanceId",
] as const;

const DEFAULT_CEL_WORKFLOW_FIELDS = [
	"id",
	"name",
	"input",
	"input_as_text",
] as const;

function extractSetStateKeys(nodes: WorkflowNode[]): string[] {
	const keys = new Set<string>();

	for (const node of nodes) {
		if (node.type !== "set-state") {
			continue;
		}

		const config = node.data.config as Record<string, unknown> | undefined;
		if (!config) {
			continue;
		}

		if (Array.isArray(config.entries)) {
			for (const entry of config.entries) {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
					continue;
				}
				const rawKey = (entry as Record<string, unknown>).key;
				const key =
					typeof rawKey === "string"
						? rawKey.trim()
						: String(rawKey ?? "").trim();
				if (key) {
					keys.add(key);
				}
			}
		}

		const legacyKey =
			typeof config.key === "string"
				? config.key.trim()
				: String(config.key ?? "").trim();
		if (legacyKey) {
			keys.add(legacyKey);
		}
	}

	return Array.from(keys).sort((a, b) => a.localeCompare(b));
}

function getNodeLabel(node: WorkflowNode): string {
	const label =
		typeof node.data.label === "string" ? node.data.label.trim() : "";
	if (label) {
		return label;
	}
	return node.id;
}

function buildGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
	const filteredNodes = nodes.filter(
		(node) => node.type !== "add" && node.type !== "group",
	);
	const nodeIds = filteredNodes.map((node) => node.id);
	const nodeIdSet = new Set(nodeIds);

	const preds = new Map<string, Set<string>>();
	for (const nodeId of nodeIds) {
		preds.set(nodeId, new Set<string>());
	}

	for (const edge of edges) {
		if (!(nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target))) {
			continue;
		}
		preds.get(edge.target)?.add(edge.source);
	}

	return { filteredNodes, nodeIds, preds };
}

function computeAncestors(nodeIds: string[], preds: Map<string, Set<string>>) {
	const ancestors = new Map<string, Set<string>>();

	for (const nodeId of nodeIds) {
		const seen = new Set<string>();
		const stack = [...(preds.get(nodeId) ?? new Set<string>())];

		while (stack.length > 0) {
			const candidate = stack.pop();
			if (!candidate || seen.has(candidate)) {
				continue;
			}
			seen.add(candidate);
			for (const parent of preds.get(candidate) ?? new Set<string>()) {
				stack.push(parent);
			}
		}

		ancestors.set(nodeId, seen);
	}

	return ancestors;
}

function computeDominators(nodeIds: string[], preds: Map<string, Set<string>>) {
	const allNodeIds = new Set(nodeIds);
	const dominators = new Map<string, Set<string>>();

	const triggerNodeId = nodeIds.find((nodeId) => {
		const parentCount = (preds.get(nodeId) ?? new Set<string>()).size;
		return parentCount === 0;
	});
	const startNodeId = triggerNodeId ?? nodeIds[0];

	if (!startNodeId) {
		return dominators;
	}

	for (const nodeId of nodeIds) {
		if (nodeId === startNodeId) {
			dominators.set(nodeId, new Set([nodeId]));
			continue;
		}
		const parentIds = preds.get(nodeId) ?? new Set<string>();
		if (parentIds.size === 0) {
			dominators.set(nodeId, new Set([nodeId]));
			continue;
		}
		dominators.set(nodeId, new Set(allNodeIds));
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const nodeId of nodeIds) {
			if (nodeId === startNodeId) {
				continue;
			}

			const parentIds = [...(preds.get(nodeId) ?? new Set<string>())];
			if (parentIds.length === 0) {
				continue;
			}

			let intersection: Set<string> | null = null;
			for (const parentId of parentIds) {
				const parentDom = dominators.get(parentId) ?? new Set<string>();
				if (intersection === null) {
					intersection = new Set(parentDom);
					continue;
				}
				for (const value of [...intersection]) {
					if (!parentDom.has(value)) {
						intersection.delete(value);
					}
				}
			}

			const next = intersection ?? new Set<string>();
			next.add(nodeId);

			const current = dominators.get(nodeId) ?? new Set<string>();
			if (
				next.size !== current.size ||
				[...next].some((value) => !current.has(value))
			) {
				dominators.set(nodeId, next);
				changed = true;
			}
		}
	}

	return dominators;
}

export function buildWorkflowContextAvailability(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): AvailableContextByNodeId {
	const { filteredNodes, nodeIds, preds } = buildGraph(nodes, edges);
	const ancestors = computeAncestors(nodeIds, preds);
	const dominators = computeDominators(nodeIds, preds);
	const stateKeys = extractSetStateKeys(filteredNodes);
	const nodeById = new Map(
		filteredNodes.map((node) => [node.id, node] as const),
	);
	const triggerNodeId =
		filteredNodes.find((node) => node.type === "trigger")?.id ??
		filteredNodes[0]?.id;

	const result: AvailableContextByNodeId = {};

	for (const node of filteredNodes) {
		const ancestorIds = [
			...(ancestors.get(node.id) ?? new Set<string>()),
		].filter((ancestorId) => {
			const ancestor = nodeById.get(ancestorId);
			return Boolean(ancestor && ancestor.type !== "add");
		});

		const nodeDominators = dominators.get(node.id) ?? new Set<string>();
		const upstreamNodes = ancestorIds
			.map((ancestorId) => {
				const ancestor = nodeById.get(ancestorId);
				if (!ancestor) {
					return null;
				}
				const alwaysAvailable = nodeDominators.has(ancestorId);
				return {
					nodeId: ancestor.id,
					nodeLabel: getNodeLabel(ancestor),
					nodeType: String(ancestor.type ?? ancestor.data.type ?? "node"),
					availability: alwaysAvailable ? "always" : "maybe",
				} as const;
			})
			.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
			.sort((a, b) => {
				if (a.availability !== b.availability) {
					return a.availability === "always" ? -1 : 1;
				}
				return a.nodeLabel.localeCompare(b.nodeLabel);
			});

		result[node.id] = {
			upstreamNodes,
			stateKeys,
			triggerNodeId,
		};
	}

	return result;
}

export function buildWhileCelMemberFields(stateKeys: string[]) {
	return {
		state: stateKeys,
		workflow: [...DEFAULT_CEL_WORKFLOW_FIELDS],
		input: [...DEFAULT_CEL_INPUT_FIELDS],
		last: [...DEFAULT_CEL_INPUT_FIELDS],
	};
}
