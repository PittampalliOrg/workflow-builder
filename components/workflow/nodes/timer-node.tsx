"use client";

import type { NodeProps } from "@xyflow/react";
import { Check, Timer, XCircle } from "lucide-react";
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

type TimerNodeProps = NodeProps & {
	data?: WorkflowNodeData;
	id: string;
};

export const TimerNode = memo(({ data, selected, id }: TimerNodeProps) => {
	if (!data) {
		return null;
	}

	const durationSeconds = (data.config?.durationSeconds as number) || 0;
	const displayTitle = data.label || "Timer";
	const status = data.status;

	// Format duration for display
	const formatDuration = (seconds: number): string => {
		if (seconds < 60) {
			return `${seconds}s`;
		}
		if (seconds < 3600) {
			return `${Math.floor(seconds / 60)}m`;
		}
		return `${Math.floor(seconds / 3600)}h`;
	};

	const displayDescription =
		data.description ||
		(durationSeconds > 0
			? `Wait ${formatDuration(durationSeconds)}`
			: "Set duration");

	return (
		<Node
			className={cn(
				"relative flex h-48 w-48 flex-col items-center justify-center shadow-none transition-all duration-150 ease-out",
				selected && "border-primary",
			)}
			data-testid={`timer-node-${id}`}
			handles={{ target: true, source: true }}
			runnable
			selected={selected}
			status={status}
		>
			<StatusBadge status={status} />

			<div className="flex flex-col items-center justify-center gap-3 p-6">
				<Timer className="size-12 text-purple-400" strokeWidth={1.5} />
				<div className="flex flex-col items-center gap-1 text-center">
					<NodeTitle className="text-base">{displayTitle}</NodeTitle>
					<NodeDescription className="text-xs">
						{displayDescription}
					</NodeDescription>
				</div>
			</div>
		</Node>
	);
});

TimerNode.displayName = "TimerNode";
