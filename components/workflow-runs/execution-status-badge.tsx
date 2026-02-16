"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ExecutionStatusBadgeProps = {
	status: string;
	className?: string;
};

function normalizeStatus(status: string): string {
	return status.toLowerCase();
}

export function ExecutionStatusBadge({
	status,
	className,
}: ExecutionStatusBadgeProps) {
	const normalized = normalizeStatus(status);

	if (normalized === "success" || normalized === "completed") {
		return (
			<Badge
				className={cn(
					"border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
					className,
				)}
				variant="outline"
			>
				Completed
			</Badge>
		);
	}

	if (normalized === "running" || normalized === "pending") {
		return (
			<Badge
				className={cn(
					"border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
					className,
				)}
				variant="outline"
			>
				Running
			</Badge>
		);
	}

	if (normalized === "error" || normalized === "failed") {
		return (
			<Badge
				className={cn(
					"border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
					className,
				)}
				variant="outline"
			>
				Failed
			</Badge>
		);
	}

	if (normalized === "cancelled" || normalized === "terminated") {
		return (
			<Badge
				className={cn(
					"border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
					className,
				)}
				variant="outline"
			>
				Cancelled
			</Badge>
		);
	}

	return (
		<Badge className={cn("text-muted-foreground", className)} variant="outline">
			{status}
		</Badge>
	);
}
