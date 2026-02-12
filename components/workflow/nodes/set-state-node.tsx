"use client";

import {
	Node,
	NodeDescription,
	NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";
import type { WorkflowNodeData } from "@/lib/workflow-store";
import type { NodeProps } from "@xyflow/react";
import { Database } from "lucide-react";
import { memo } from "react";

type SetStateNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const SetStateNode = memo(
	({ data, selected, id }: SetStateNodeProps) => {
		if (!data) {
			return null;
		}

		const key = String(data.config?.key || "").trim();

		return (
			<Node
				className={cn(
					"relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
					selected && "border-primary",
				)}
				data-testid={`set-state-node-${id}`}
				handles={{ target: true, source: true }}
				status={data.status}
			>
				<div className="flex flex-col items-center justify-center gap-3 p-6">
					<Database
						className="size-12 text-muted-foreground"
						strokeWidth={1.5}
					/>
					<div className="flex flex-col items-center gap-1 text-center">
						<NodeTitle className="text-base">
							{data.label || "Set State"}
						</NodeTitle>
						<NodeDescription className="text-xs">
							{key ? `Set state.${key}` : "Set a workflow variable"}
						</NodeDescription>
					</div>
				</div>
			</Node>
		);
	},
);

SetStateNode.displayName = "SetStateNode";
