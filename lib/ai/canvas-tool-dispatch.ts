import type { CanvasToolResult } from "./canvas-tools";
import type { WorkflowNode, WorkflowNodeData } from "@/lib/workflow-store";

export type CanvasAtomSetters = {
	addNode: (node: WorkflowNode) => void;
	updateNodeData: (args: {
		id: string;
		data: Partial<WorkflowNodeData>;
	}) => void;
	deleteNode: (nodeId: string) => void;
	addEdge: (edge: {
		id: string;
		source: string;
		target: string;
		sourceHandle?: string | null;
		type?: string;
	}) => void;
	deleteEdge: (edgeId: string) => void;
	setWorkflowName: (name: string) => void;
	setSelectedNode: (nodeId: string | null) => void;
	getNodes: () => WorkflowNode[];
	clearWorkflow: () => void;
	autoArrange: () => void;
};

export function dispatchCanvasToolResult(
	result: CanvasToolResult,
	atoms: CanvasAtomSetters,
): void {
	switch (result.op) {
		case "addNode": {
			const payload = result.payload as {
				id: string;
				type: string;
				position: { x: number; y: number };
				data: WorkflowNodeData;
			};
			const node: WorkflowNode = {
				id: payload.id,
				type: payload.type,
				position: payload.position,
				data: payload.data,
			};
			atoms.addNode(node);
			break;
		}

		case "updateNodeData": {
			const { id, data } = result.payload as {
				id: string;
				data: Partial<WorkflowNodeData>;
			};

			// Merge config fields with existing config instead of replacing
			if (data.config) {
				const currentNodes = atoms.getNodes();
				const existingNode = currentNodes.find((n) => n.id === id);
				if (existingNode?.data.config) {
					data.config = {
						...existingNode.data.config,
						...data.config,
					};
				}
			}

			atoms.updateNodeData({ id, data });
			break;
		}

		case "deleteNode": {
			const { id } = result.payload as { id: string };
			atoms.deleteNode(id);
			break;
		}

		case "addEdge": {
			const edge = result.payload as {
				id: string;
				source: string;
				target: string;
				sourceHandle?: string | null;
				type?: string;
			};
			atoms.addEdge(edge);
			break;
		}

		case "deleteEdge": {
			const { edgeId } = result.payload as { edgeId: string };
			atoms.deleteEdge(edgeId);
			break;
		}

		case "setName": {
			const { name } = result.payload as { name: string };
			atoms.setWorkflowName(name);
			break;
		}

		case "selectNode": {
			const { nodeId } = result.payload as { nodeId: string };
			atoms.setSelectedNode(nodeId);
			break;
		}

		case "clearWorkflow": {
			atoms.clearWorkflow();
			break;
		}

		case "autoArrange": {
			atoms.autoArrange();
			break;
		}
	}
}
