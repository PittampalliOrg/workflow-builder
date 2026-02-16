"use client";

import { AlertCircle, CheckCircle2, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ObservabilityTraceStatus } from "@/lib/types/observability";
import { cn } from "@/lib/utils";

type TraceStatusBadgeProps = {
	status: ObservabilityTraceStatus;
	className?: string;
};

export function TraceStatusBadge({ status, className }: TraceStatusBadgeProps) {
	if (status === "ok") {
		return (
			<Badge
				className={cn(
					"border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
					className,
				)}
				variant="outline"
			>
				<CheckCircle2 className="mr-1 h-3.5 w-3.5" />
				OK
			</Badge>
		);
	}

	if (status === "error") {
		return (
			<Badge
				className={cn(
					"border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
					className,
				)}
				variant="outline"
			>
				<AlertCircle className="mr-1 h-3.5 w-3.5" />
				Error
			</Badge>
		);
	}

	return (
		<Badge className={cn("text-muted-foreground", className)} variant="outline">
			<HelpCircle className="mr-1 h-3.5 w-3.5" />
			Unknown
		</Badge>
	);
}
