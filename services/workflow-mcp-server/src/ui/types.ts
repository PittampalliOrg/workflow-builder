import { z } from "zod";
import type {
	EdgeData,
	NodeData,
	WorkflowRow,
	WorkflowSummary,
} from "../db.js";

export type UiToast = {
	id: string;
	message: string;
	type: "success" | "error";
	expiresAt: number;
};

export type UiExecution = {
	instanceId: string | null;
	status: unknown | null;
	results: unknown | null;
	showResults: boolean;
	loadingResults: boolean;
};

export type UiModel = {
	workflows: WorkflowSummary[];
	selectedWorkflowId: string | null;
	workflow: WorkflowRow | null;
	selectedNodeId: string | null;
	selectedNode: NodeData | null;
	nodeStatuses: Record<string, "running" | "completed" | "error">;
	execution: UiExecution;
	toasts: UiToast[];
	nodeTypes: Array<{ value: string; label: string }>;
};

export const UiEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("workflow.select"), workflowId: z.string() }),
	z.object({
		type: z.literal("workflow.create"),
		name: z.string().min(1),
		description: z.string().optional(),
	}),
	z.object({
		type: z.literal("workflow.rename"),
		workflowId: z.string(),
		name: z.string().min(1),
	}),
	z.object({
		type: z.literal("workflow.update_description"),
		workflowId: z.string(),
		description: z.string().nullable(),
	}),
	z.object({ type: z.literal("workflow.duplicate"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow.delete"), workflowId: z.string() }),
	z.object({ type: z.literal("workflow.refresh") }),

	z.object({
		type: z.literal("node.select"),
		nodeId: z.string().nullable(),
	}),
	z.object({
		type: z.literal("node.add"),
		workflowId: z.string(),
		nodeType: z.string(),
		x: z.number(),
		y: z.number(),
		label: z.string().optional(),
	}),
	z.object({
		type: z.literal("node.move"),
		workflowId: z.string(),
		nodeId: z.string(),
		x: z.number(),
		y: z.number(),
	}),
	z.object({
		type: z.literal("node.update"),
		workflowId: z.string(),
		nodeId: z.string(),
		updates: z
			.object({
				label: z.string().optional(),
				description: z.string().optional(),
				enabled: z.boolean().optional(),
				config: z.record(z.unknown()).optional(),
			})
			.strict(),
	}),
	z.object({
		type: z.literal("node.delete"),
		workflowId: z.string(),
		nodeId: z.string(),
	}),

	z.object({
		type: z.literal("edge.connect"),
		workflowId: z.string(),
		sourceId: z.string(),
		targetId: z.string(),
		sourceHandle: z.string().optional(),
		targetHandle: z.string().optional(),
	}),
	z.object({
		type: z.literal("edge.disconnect"),
		workflowId: z.string(),
		edgeId: z.string(),
	}),

	z.object({
		type: z.literal("execution.run"),
		workflowId: z.string(),
		triggerData: z.record(z.unknown()).optional(),
	}),
	z.object({
		type: z.literal("execution.approve"),
		instanceId: z.string(),
		eventName: z.string(),
		approved: z.boolean(),
		reason: z.string().optional(),
	}),
	z.object({
		type: z.literal("execution.show_results"),
		instanceId: z.string(),
	}),
	z.object({ type: z.literal("execution.hide_results") }),
	z.object({ type: z.literal("toast.dismiss"), id: z.string() }),
]);

export type UiEvent = z.infer<typeof UiEventSchema>;
