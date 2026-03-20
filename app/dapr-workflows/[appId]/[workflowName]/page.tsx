"use client";

import { format } from "date-fns";
import {
	ArrowLeft,
	CheckCircle2,
	Clock,
	Activity,
	XCircle,
	TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkflowDefinitionGraph } from "@/components/monitor/workflow-definition-graph";
import { api } from "@/lib/api-client";
import type { WorkflowRuntimeGraph } from "@/lib/types/workflow-graph";
import type { WorkflowNameDetail } from "@/lib/types/workflow-dashboard";
import type { WorkflowUIStatus } from "@/lib/types/workflow-ui";

function getStatusBadgeClasses(status: WorkflowUIStatus): string {
	switch (status) {
		case "COMPLETED":
			return "border-green-500 text-green-600 dark:text-green-400 bg-green-500/10";
		case "RUNNING":
		case "PENDING":
			return "border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-500/10";
		case "FAILED":
		case "TERMINATED":
			return "border-red-500 text-red-600 dark:text-red-400 bg-red-500/10";
		case "SUSPENDED":
			return "border-yellow-500 text-yellow-600 dark:text-yellow-400 bg-yellow-500/10";
		default:
			return "border-gray-500 text-gray-600 dark:text-gray-400 bg-gray-500/10";
	}
}

function formatTimestamp(iso: string | null): string {
	if (!iso) return "-";
	try {
		return format(new Date(iso), "dd MMM yyyy h:mm:ss a");
	} catch {
		return iso;
	}
}

export default function WorkflowDetailPage() {
	const params = useParams<{ appId: string; workflowName: string }>();
	const appId = decodeURIComponent(params.appId);
	const workflowName = decodeURIComponent(params.workflowName);

	const [data, setData] = useState<WorkflowNameDetail | null>(null);
	const [graph, setGraph] = useState<WorkflowRuntimeGraph | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const fetchDetail = useCallback(async () => {
		try {
			const result = await api.workflowDashboard.getNameDetail(
				appId,
				workflowName,
			);
			setData(result);
		} catch (error) {
			console.error("Failed to fetch workflow detail:", error);
			toast.error("Failed to load workflow detail");
		} finally {
			setLoading(false);
		}
		api.workflowDashboard.getWorkflowGraph(appId, workflowName).then(setGraph).catch(() => {});
	}, [appId, workflowName]);

	useEffect(() => {
		fetchDetail();
	}, [fetchDetail]);

	useEffect(() => {
		intervalRef.current = setInterval(fetchDetail, 30_000);
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [fetchDetail]);

	if (loading) {
		return (
			<div className="pointer-events-auto mx-auto max-w-6xl p-6">
				<Skeleton className="mb-2 h-5 w-24" />
				<Skeleton className="mb-6 h-8 w-64" />
				<div className="grid grid-cols-5 gap-4 mb-8">
					{Array.from({ length: 5 }).map((_, i) => (
						<Skeleton key={i} className="h-24 rounded-lg" />
					))}
				</div>
				<Skeleton className="h-64 w-full rounded-lg" />
			</div>
		);
	}

	if (!data) {
		return (
			<div className="pointer-events-auto mx-auto max-w-6xl p-6">
				<p className="text-muted-foreground">Workflow not found.</p>
			</div>
		);
	}

	return (
		<div className="pointer-events-auto mx-auto max-w-6xl p-6">
			{/* Breadcrumb */}
			<Link
				href="/dapr-workflows"
				className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				<ArrowLeft className="size-3.5" />
				Workflows
			</Link>

			{/* Header */}
			<div className="mb-1 flex items-center gap-3">
				<div className="h-8 w-1 rounded-full bg-emerald-500" />
				<h1 className="font-semibold text-2xl">{data.name}</h1>
			</div>
			<p className="mb-6 ml-4 text-sm text-emerald-600 dark:text-emerald-400">
				{data.appId}
			</p>

			{/* Stat Cards */}
			<div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
				<StatCard
					label="EXECUTIONS"
					value={data.totalExecutions}
					icon={<Activity className="size-4" />}
					color="text-foreground"
					bgColor="bg-muted/50"
				/>
				<StatCard
					label="RUNNING"
					value={data.running}
					icon={<Clock className="size-4 text-blue-500" />}
					color="text-blue-600 dark:text-blue-400"
					bgColor="bg-blue-500/10"
				/>
				<StatCard
					label="SUCCESS"
					value={data.success}
					icon={<CheckCircle2 className="size-4 text-green-500" />}
					color="text-green-600 dark:text-green-400"
					bgColor="bg-green-500/10"
				/>
				<StatCard
					label="FAILED"
					value={data.failed}
					icon={<XCircle className="size-4 text-red-500" />}
					color="text-red-600 dark:text-red-400"
					bgColor="bg-red-500/10"
				/>
				<div className={`rounded-lg border p-4 bg-green-500/10`}>
					<div className="mb-1 flex items-center gap-2">
						<TrendingUp className="size-4 text-green-500" />
						<span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
							SUCCESS RATE
						</span>
					</div>
					<p className="text-lg font-bold text-green-600 dark:text-green-400">
						{data.successRate}%
					</p>
					<div className="mt-2 h-1.5 w-full rounded-full bg-muted">
						<div
							className="h-1.5 rounded-full bg-green-500 transition-all"
							style={{ width: `${data.successRate}%` }}
						/>
					</div>
				</div>
			</div>

			{/* Graph + Latest Executions */}
			<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
				<WorkflowDefinitionGraph graph={graph} />

				<div>
					<div className="mb-4 flex items-center justify-between">
						<h2 className="font-semibold text-lg">
							Latest {data.executions.length} executions
						</h2>
					</div>

					{data.executions.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							No executions yet.
						</p>
					) : (
						<div className="space-y-3">
							{data.executions.slice(0, 20).map((exec) => (
								<Link
									key={exec.instanceId}
									href={`/dapr-workflows/executions/${encodeURIComponent(exec.instanceId)}`}
									className="block rounded-lg border p-4 transition-colors hover:bg-muted/50"
								>
									<div className="flex items-center justify-between">
										<div>
											<p className="font-mono text-sm">
												{exec.instanceId}
											</p>
											<p className="mt-1 text-xs text-muted-foreground">
												{formatTimestamp(exec.startTime)}
												{exec.executionTime &&
													` | ${exec.executionTime}`}
											</p>
										</div>
										<Badge
											variant="outline"
											className={getStatusBadgeClasses(exec.status)}
										>
											{exec.status}
										</Badge>
									</div>
								</Link>
							))}
						</div>
					)}

					{data.executions.length > 20 && (
						<div className="mt-4">
							<Link href={`/dapr-workflows?tab=executions&search=${encodeURIComponent(data.name)}`}>
								<Button variant="outline" className="text-emerald-600 border-emerald-500">
									See all executions
								</Button>
							</Link>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function StatCard({
	label,
	value,
	icon,
	color,
	bgColor,
}: {
	label: string;
	value: number;
	icon: React.ReactNode;
	color: string;
	bgColor: string;
}) {
	return (
		<div className={`rounded-lg border p-4 ${bgColor}`}>
			<div className="mb-1 flex items-center gap-2">
				{icon}
				<span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
					{label}
				</span>
			</div>
			<p className={`text-lg font-bold ${color}`}>{value}</p>
		</div>
	);
}
