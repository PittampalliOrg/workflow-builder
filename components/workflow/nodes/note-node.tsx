"use client";

import {
	Node,
	NodeDescription,
	NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";
import type { WorkflowNodeData } from "@/lib/workflow-store";
import type { NodeProps } from "@xyflow/react";
import { StickyNote } from "lucide-react";
import { memo } from "react";

type NoteNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const NoteNode = memo(({ data, selected, id }: NoteNodeProps) => {
	if (!data) {
		return null;
	}

	return (
		<Node
			className={cn(
				"relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
				selected && "border-primary",
			)}
			data-testid={`note-node-${id}`}
			handles={{ target: false, source: false }}
			selected={selected}
			status={data.status}
		>
			<div className="flex flex-col items-center justify-center gap-3 p-6">
				<StickyNote
					className="size-12 text-muted-foreground"
					strokeWidth={1.5}
				/>
				<div className="flex flex-col items-center gap-1 text-center">
					<NodeTitle className="text-base">{data.label || "Note"}</NodeTitle>
					<NodeDescription className="text-xs">
						{data.description || "Non-executing annotation"}
					</NodeDescription>
				</div>
			</div>
		</Node>
	);
});

NoteNode.displayName = "NoteNode";
