"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useAtomValue, useSetAtom } from "jotai";
import { Bot, Repeat } from "lucide-react";
import { nanoid } from "nanoid";
import { memo, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	activeWhileDropTargetAtom,
	addNodeAtom,
	nodesAtom,
	propertiesPanelActiveTabAtom,
	selectedNodeAtom,
	type WorkflowNode,
	type WorkflowNodeData,
} from "@/lib/workflow-store";
import {
	clampWhileChildPosition,
	isWhileBodyCandidate,
} from "@/lib/workflows/while-node";

type WhileNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const WhileNode = memo(({ data, selected, id }: WhileNodeProps) => {
	if (!data) return null;

	const nodes = useAtomValue(nodesAtom);
	const addNode = useSetAtom(addNodeAtom);
	const setSelectedNode = useSetAtom(selectedNodeAtom);
	const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
	const expression = String(data.config?.expression || "").trim();
	const title = data.label || "While";
	const dropTarget = useAtomValue(activeWhileDropTargetAtom);
	const dropState = dropTarget?.whileId === id ? dropTarget.state : null;
	const showDropHint = dropState !== null;
	const enclosedBodyNode = nodes.find(
		(node) => node.parentId === id && isWhileBodyCandidate(node),
	);
	const hasEnclosedBody = Boolean(enclosedBodyNode);
	const dropHintText =
		dropState === "eligible"
			? "Release to bind Durable Agent"
			: dropState === "occupied"
				? "Only one Durable Agent can be enclosed"
				: "Only Durable Agent (durable/run) can be enclosed";
	const handleBodyAction = useCallback(() => {
		if (enclosedBodyNode) {
			setSelectedNode(enclosedBodyNode.id);
			setActiveTab("properties");
			toast.info("Selected enclosed Durable Agent");
			return;
		}

		const newNode: WorkflowNode = {
			id: nanoid(),
			type: "action",
			parentId: id,
			extent: "parent",
			position: clampWhileChildPosition({ x: 28, y: 74 }),
			data: {
				label: "",
				description: "",
				type: "action",
				config: {
					actionType: "durable/run",
				},
				status: "idle",
			},
			selected: true,
		};
		addNode(newNode);
		setActiveTab("properties");
	}, [addNode, enclosedBodyNode, id, setActiveTab, setSelectedNode]);

	return (
		<div
			className={cn(
				"relative h-[300px] w-[420px] rounded-xl border border-dashed bg-card/30 backdrop-blur-[1px] transition-all duration-150 ease-out",
				selected
					? "border-primary shadow-[0_0_0_1px_hsl(var(--primary))]"
					: "border-border/80",
				dropState === "eligible" &&
					"border-emerald-500 bg-emerald-500/5 shadow-[0_0_0_2px_rgba(16,185,129,0.45)]",
				(dropState === "occupied" || dropState === "unsupported") &&
					"border-amber-500 bg-amber-500/5 shadow-[0_0_0_2px_rgba(245,158,11,0.35)]",
			)}
			data-testid={`while-node-${id}`}
		>
			<Handle position={Position.Left} type="target" />
			<Handle position={Position.Right} type="source" />

			<div className="absolute inset-x-3 top-3 flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-2">
				<div className="rounded-md border border-border/70 bg-background/60 p-1.5">
					<Repeat className="size-4 text-muted-foreground" strokeWidth={1.8} />
				</div>
				<div className="min-w-0 flex-1">
					<p className="truncate font-medium text-sm leading-none">{title}</p>
					<p className="mt-1 truncate text-muted-foreground text-xs">
						{showDropHint
							? dropHintText
							: expression
								? expression
								: "Drop a Durable Agent node here"}
					</p>
				</div>
				<Button
					className="nodrag nopan h-7 gap-1.5 px-2 text-xs"
					data-testid={`while-body-action-${id}`}
					onClick={(event) => {
						event.stopPropagation();
						handleBodyAction();
					}}
					size="sm"
					type="button"
					variant={hasEnclosedBody ? "secondary" : "default"}
				>
					<Bot className="size-3.5" strokeWidth={1.8} />
					{hasEnclosedBody ? "Select Body" : "Add Durable Agent"}
				</Button>
			</div>
			{showDropHint && (
				<div className="pointer-events-none absolute inset-3 top-16 rounded-lg border border-dashed border-current bg-transparent p-3">
					<p
						className={cn(
							"font-medium text-xs",
							dropState === "eligible"
								? "text-emerald-600 dark:text-emerald-400"
								: "text-amber-600 dark:text-amber-400",
						)}
					>
						{dropHintText}
					</p>
				</div>
			)}
		</div>
	);
});

WhileNode.displayName = "WhileNode";
