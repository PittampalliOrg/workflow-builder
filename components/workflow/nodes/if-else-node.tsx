"use client";

import {
	Node,
	NodeDescription,
	NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";
import type { WorkflowNodeData } from "@/lib/workflow-store";
import { Position, type NodeProps } from "@xyflow/react";
import { GitBranch } from "lucide-react";
import { memo } from "react";

type IfElseNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const IfElseNode = memo(({ data, selected, id }: IfElseNodeProps) => {
	if (!data) {
		return null;
	}

	return (
		<Node
			className={cn(
				"relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
				selected && "border-primary",
			)}
			data-testid={`if-else-node-${id}`}
			handles={{
				target: true,
				sources: [
					{
						id: "true",
						position: Position.Right,
						style: { top: "35%" },
						className: "border-green-700 bg-green-500",
					},
					{
						id: "false",
						position: Position.Right,
						style: { top: "65%" },
						className: "border-red-700 bg-red-500",
					},
				],
			}}
			status={data.status}
		>
			<div className="flex flex-col items-center justify-center gap-3 p-6">
				<GitBranch
					className="size-12 text-muted-foreground"
					strokeWidth={1.5}
				/>
				<div className="flex flex-col items-center gap-1 text-center">
					<NodeTitle className="text-base">
						{data.label || "If / Else"}
					</NodeTitle>
					<NodeDescription className="text-xs">
						{data.description || "Choose a branch"}
					</NodeDescription>
				</div>
			</div>

			<div className="absolute right-6 flex w-10 flex-col gap-6 text-muted-foreground text-[10px]">
				<span className="text-right">true</span>
				<span className="text-right">false</span>
			</div>
		</Node>
	);
});

IfElseNode.displayName = "IfElseNode";
