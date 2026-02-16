"use client";

import {
	Node,
	NodeDescription,
	NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";
import type { WorkflowNodeData } from "@/lib/workflow-store";
import type { NodeProps } from "@xyflow/react";
import { Hand } from "lucide-react";
import { memo } from "react";

type WorkflowControlNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const WorkflowControlNode = memo(
	({ data, selected, id }: WorkflowControlNodeProps) => {
		if (!data) {
			return null;
		}

		const mode = String(data.config?.mode || "stop").toLowerCase();
		const reason = String(data.config?.reason || "").trim();

		return (
			<Node
				className={cn(
					"relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
					selected && "border-primary",
				)}
				data-testid={`workflow-control-node-${id}`}
				handles={{ target: true, source: true }}
				status={data.status}
			>
				<div className="flex flex-col items-center justify-center gap-3 p-6">
					<Hand className="size-12 text-muted-foreground" strokeWidth={1.5} />
					<div className="flex flex-col items-center gap-1 text-center">
						<NodeTitle className="text-base">
							{data.label || "Workflow Control"}
						</NodeTitle>
						<NodeDescription className="text-xs">
							{mode === "continue" ? "Continue workflow" : "Stop workflow"}
							{reason ? `: ${reason}` : ""}
						</NodeDescription>
					</div>
				</div>
			</Node>
		);
	},
);

WorkflowControlNode.displayName = "WorkflowControlNode";
