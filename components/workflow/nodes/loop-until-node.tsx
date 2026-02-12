"use client";

import type { NodeProps } from "@xyflow/react";
import { Check, Repeat, XCircle } from "lucide-react";
import { memo } from "react";
import {
	Node,
	NodeDescription,
	NodeTitle,
} from "@/components/ai-elements/node";
import { cn } from "@/lib/utils";
import type { WorkflowNodeData } from "@/lib/workflow-store";

const StatusBadge = ({
	status,
}: {
	status?: "idle" | "running" | "success" | "error";
}) => {
	if (!status || status === "idle" || status === "running") {
		return null;
	}

	return (
		<div
			className={cn(
				"absolute top-2 right-2 rounded-full p-1",
				status === "success" && "bg-green-500/50",
				status === "error" && "bg-red-500/50",
			)}
		>
			{status === "success" && (
				<Check className="size-3.5 text-white" strokeWidth={2.5} />
			)}
			{status === "error" && (
				<XCircle className="size-3.5 text-white" strokeWidth={2.5} />
			)}
		</div>
	);
};

type LoopUntilNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const LoopUntilNode = memo(
	({ data, selected, id }: LoopUntilNodeProps) => {
		if (!data) {
			return null;
		}

		const maxIterations = Number(data.config?.maxIterations ?? 10);
		const displayTitle = data.label || "Loop Until";
		const status = data.status;

		const displayDescription =
			data.description ||
			(maxIterations > 0
				? `Repeat until condition is met (max ${maxIterations})`
				: "Configure loop");

		return (
			<Node
				className={cn(
					"relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
					selected && "border-primary",
				)}
				data-testid={`loop-until-node-${id}`}
				handles={{ target: true, source: true }}
				status={status}
			>
				<StatusBadge status={status} />

				<div className="flex flex-col items-center justify-center gap-3 p-6">
					<Repeat className="size-12 text-muted-foreground" strokeWidth={1.5} />
					<div className="flex flex-col items-center gap-1 text-center">
						<NodeTitle className="text-base">{displayTitle}</NodeTitle>
						<NodeDescription className="text-xs">
							{displayDescription}
						</NodeDescription>
					</div>
				</div>
			</Node>
		);
	},
);

LoopUntilNode.displayName = "LoopUntilNode";
