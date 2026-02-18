"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Repeat } from "lucide-react";
import { memo } from "react";
import { cn } from "@/lib/utils";
import type { WorkflowNodeData } from "@/lib/workflow-store";

type WhileNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const WhileNode = memo(({ data, selected, id }: WhileNodeProps) => {
	if (!data) return null;

	const expression = String(data.config?.expression || "").trim();
	const title = data.label || "While";

	return (
		<div
			className={cn(
				"relative h-[300px] w-[420px] rounded-xl border border-dashed bg-card/30 backdrop-blur-[1px] transition-all duration-150 ease-out",
				selected
					? "border-primary shadow-[0_0_0_1px_hsl(var(--primary))]"
					: "border-border/80",
			)}
			data-testid={`while-node-${id}`}
		>
			<Handle position={Position.Left} type="target" />
			<Handle position={Position.Right} type="source" />

			<div className="pointer-events-none absolute inset-x-3 top-3 flex items-center gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-2">
				<div className="rounded-md border border-border/70 bg-background/60 p-1.5">
					<Repeat className="size-4 text-muted-foreground" strokeWidth={1.8} />
				</div>
				<div className="min-w-0">
					<p className="truncate font-medium text-sm leading-none">{title}</p>
					<p className="mt-1 truncate text-muted-foreground text-xs">
						{expression ? expression : "Drop a Durable Agent node here"}
					</p>
				</div>
			</div>
		</div>
	);
});

WhileNode.displayName = "WhileNode";
