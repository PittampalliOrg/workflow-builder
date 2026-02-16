"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExecutionStatusBadge } from "@/components/workflow-runs/execution-status-badge";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import { getRelativeTime } from "@/lib/utils/time";

type WorkflowExecutionListItem = Awaited<
	ReturnType<typeof api.workflow.getExecutions>
>[number];

export default function WorkflowRunsPage() {
	const params = useParams<{ workflowId: string }>();
	const workflowId = params.workflowId;

	const [workflowName, setWorkflowName] = useState<string>("");
	const [executions, setExecutions] = useState<WorkflowExecutionListItem[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!workflowId) {
			return;
		}

		try {
			setIsLoading(true);
			setError(null);

			const [workflow, runs] = await Promise.all([
				api.workflow.getById(workflowId),
				api.workflow.getExecutions(workflowId),
			]);

			setWorkflowName(workflow?.name ?? "Workflow");
			setExecutions(runs);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load runs");
		} finally {
			setIsLoading(false);
		}
	}, [workflowId]);

	useEffect(() => {
		load();
	}, [load]);

	const hasRunningExecution = useMemo(
		() =>
			executions.some((run) =>
				["running", "pending"].includes(run.status.toLowerCase()),
			),
		[executions],
	);

	useEffect(() => {
		if (!hasRunningExecution) {
			return;
		}

		const interval = setInterval(() => {
			load();
		}, 3000);

		return () => clearInterval(interval);
	}, [hasRunningExecution, load]);

	return (
		<div className="container mx-auto space-y-6 py-6">
			<div className="flex items-start justify-between">
				<div className="space-y-2">
					<div className="flex items-center gap-3">
						<SidebarToggle />
						<Button asChild size="sm" variant="outline">
							<Link href={`/workflows/${workflowId}`}>
								<ArrowLeft className="mr-2 h-4 w-4" />
								Back to workflow
							</Link>
						</Button>
					</div>
					<h1 className="font-bold text-3xl">Workflow Runs</h1>
					<p className="text-muted-foreground">{workflowName}</p>
				</div>

				<Button disabled={isLoading} onClick={load} variant="outline">
					<RefreshCw className="mr-2 h-4 w-4" />
					Refresh
				</Button>
			</div>

			{error && (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
					{error}
				</div>
			)}

			{isLoading && executions.length === 0 ? (
				<div className="rounded-lg border p-6 text-muted-foreground text-sm">
					Loading workflow runs...
				</div>
			) : executions.length === 0 ? (
				<div className="rounded-lg border p-6 text-muted-foreground text-sm">
					No runs found for this workflow yet.
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border bg-background">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Run</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Phase</TableHead>
								<TableHead>Started</TableHead>
								<TableHead>Duration</TableHead>
								<TableHead>Dapr Instance</TableHead>
								<TableHead>Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{executions.map((execution) => (
								<TableRow key={execution.id}>
									<TableCell className="font-mono text-xs">
										{execution.id.slice(0, 12)}...
									</TableCell>
									<TableCell>
										<ExecutionStatusBadge status={execution.status} />
									</TableCell>
									<TableCell>{execution.phase ?? "-"}</TableCell>
									<TableCell>
										<span
											title={new Date(execution.startedAt).toLocaleString()}
										>
											{getRelativeTime(execution.startedAt)}
										</span>
									</TableCell>
									<TableCell>{execution.duration ?? "-"}</TableCell>
									<TableCell className="font-mono text-xs">
										{execution.daprInstanceId
											? `${execution.daprInstanceId.slice(0, 12)}...`
											: "-"}
									</TableCell>
									<TableCell>
										<div className="flex items-center gap-2">
											<Button asChild size="sm" variant="outline">
												<Link
													href={`/workflows/${workflowId}/runs/${execution.id}`}
												>
													Details
												</Link>
											</Button>
											<Button asChild size="sm" variant="ghost">
												<Link href={`/monitor/${execution.id}`}>Monitor</Link>
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
}
