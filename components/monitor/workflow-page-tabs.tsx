"use client";

import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { DaprWorkflowTable } from "@/components/monitor/dapr-workflow-table";
import { WorkflowFilters as WorkflowFiltersComponent } from "@/components/monitor/workflow-filters";
import { Button } from "@/components/ui/button";
import type { WorkflowFilters } from "@/lib/types/workflow-ui";
import { useMonitorWorkflows } from "@/hooks/use-monitor-workflows";

export function WorkflowPageTabs() {
	const [filters, setFilters] = useState<WorkflowFilters>({});
	const options = useMemo(
		() => ({
			search: filters.search,
			status: filters.status,
			limit: 100,
			offset: 0,
		}),
		[filters],
	);

	const { workflows, isLoading, isError, error, mutate } =
		useMonitorWorkflows(options);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-3">
				<WorkflowFiltersComponent
					filters={filters}
					onFiltersChange={setFilters}
				/>
				<Button
					disabled={isLoading}
					onClick={() => mutate()}
					size="sm"
					variant="outline"
				>
					<RefreshCw
						className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
					/>
					Refresh
				</Button>
			</div>

			{isError ? (
				<div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
					<p className="font-medium text-destructive">
						Failed to load workflows
					</p>
					<p className="text-muted-foreground text-sm">
						{error instanceof Error
							? error.message
							: "An unexpected error occurred"}
					</p>
				</div>
			) : (
				<DaprWorkflowTable isLoading={isLoading} workflows={workflows} />
			)}
		</div>
	);
}
