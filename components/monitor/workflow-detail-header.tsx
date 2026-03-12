"use client";

import {
	Check,
	Circle,
	Pause,
	Play,
	Radio,
	RefreshCcw,
	Square,
	Trash2,
	WifiOff,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import { formatDateTime } from "@/lib/transforms/workflow-ui";
import {
	getPhaseColor,
	getPhaseLabel,
	getStatusVariant,
	type WorkflowDetail,
} from "@/lib/types/workflow-ui";
import { cn } from "@/lib/utils";

type WorkflowDetailHeaderProps = {
	workflow: WorkflowDetail;
	onRefresh?: () => void | Promise<void>;
};

function isRunnableTerminalStatus(status: WorkflowDetail["status"]): boolean {
	return (
		status === "COMPLETED" ||
		status === "FAILED" ||
		status === "CANCELLED" ||
		status === "TERMINATED"
	);
}

export function WorkflowDetailHeader({
	workflow,
	onRefresh,
}: WorkflowDetailHeaderProps) {
	const [copied, setCopied] = useState(false);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const runtimeStatus =
		workflow.daprStatus?.runtimeStatus ?? workflow.runtimeStatus;
	const executionId = workflow.executionId;
	const canPause = runtimeStatus === "RUNNING" || runtimeStatus === "PENDING";
	const canResume = runtimeStatus === "SUSPENDED";
	const canTerminate =
		runtimeStatus === "RUNNING" ||
		runtimeStatus === "PENDING" ||
		runtimeStatus === "SUSPENDED";
	const canRerun = Boolean(
		executionId && isRunnableTerminalStatus(workflow.status),
	);
	const canPurge = Boolean(
		executionId &&
			isRunnableTerminalStatus(workflow.status) &&
			workflow.daprInstanceId &&
			runtimeStatus &&
			runtimeStatus !== "UNKNOWN",
	);
	const canForcePurge = Boolean(
		executionId &&
			isRunnableTerminalStatus(workflow.status) &&
			workflow.daprInstanceId,
	);

	const handleCopyInstanceId = async () => {
		try {
			await navigator.clipboard.writeText(workflow.instanceId);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			console.error("Failed to copy:", err);
		}
	};

	const runAction = async (
		action: string,
		runner: () => Promise<unknown>,
		successMessage: string,
	) => {
		if (!executionId) {
			toast.error("Workflow execution is missing its database execution ID.");
			return;
		}
		setPendingAction(action);
		try {
			await runner();
			toast.success(successMessage);
			await onRefresh?.();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : `Failed to ${action} workflow`,
			);
		} finally {
			setPendingAction(null);
		}
	};

	return (
		<div className="space-y-4">
			{workflow.consistency?.statusDiverged && (
				<div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
					<span className="text-amber-300 text-sm">
						Runtime and persisted execution state differ. Showing runtime values
						while the workflow is active.
					</span>
				</div>
			)}

			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-3">
					<span className="text-gray-400 text-sm">INSTANCE ID:</span>
					<code className="font-mono text-sm text-white">
						{workflow.instanceId}
					</code>
					<Button
						className="h-auto px-0 py-0 text-teal-400 hover:bg-transparent hover:text-teal-300"
						onClick={handleCopyInstanceId}
						size="sm"
						variant="ghost"
					>
						{copied ? (
							<span className="flex items-center gap-1">
								<Check className="h-3.5 w-3.5" />
								Copied
							</span>
						) : (
							"Copy"
						)}
					</Button>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{canPause ? (
						<Button
							disabled={pendingAction !== null}
							onClick={() =>
								runAction(
									"pause",
									() => api.dapr.pause(executionId!),
									"Workflow paused",
								)
							}
							size="sm"
							variant="outline"
						>
							<Pause className="mr-2 h-4 w-4" />
							Pause
						</Button>
					) : null}
					{canResume ? (
						<Button
							disabled={pendingAction !== null}
							onClick={() =>
								runAction(
									"resume",
									() => api.dapr.resume(executionId!),
									"Workflow resumed",
								)
							}
							size="sm"
							variant="outline"
						>
							<Play className="mr-2 h-4 w-4" />
							Resume
						</Button>
					) : null}
					{canTerminate ? (
						<Button
							disabled={pendingAction !== null}
							onClick={() =>
								runAction(
									"terminate",
									() =>
										api.dapr.terminate(
											executionId!,
											"Terminated from workflow monitor",
										),
									"Workflow terminated",
								)
							}
							size="sm"
							variant="destructive"
						>
							<Square className="mr-2 h-4 w-4" />
							Terminate
						</Button>
					) : null}
					{canRerun ? (
						<Button
							disabled={pendingAction !== null}
							onClick={() =>
								runAction(
									"rerun",
									() =>
										api.dapr.rerun(executionId!, {
											reason: "Rerun requested from workflow monitor",
										}),
									"Workflow rerun started",
								)
							}
							size="sm"
							variant="outline"
						>
							<RefreshCcw className="mr-2 h-4 w-4" />
							Rerun
						</Button>
					) : null}
					{canPurge ? (
						<Button
							disabled={pendingAction !== null}
							onClick={() =>
								runAction(
									"purge",
									() => api.dapr.purge(executionId!),
									"Workflow runtime state purged",
								)
							}
							size="sm"
							variant="outline"
						>
							<Trash2 className="mr-2 h-4 w-4" />
							Purge
						</Button>
					) : null}
					{canForcePurge && !canPurge ? (
						<Button
							disabled={pendingAction !== null}
							onClick={() =>
								runAction(
									"force purge",
									() =>
										api.dapr.purge(executionId!, {
											force: true,
											recursive: true,
										}),
									"Workflow runtime state force-purged",
								)
							}
							size="sm"
							variant="outline"
						>
							<Trash2 className="mr-2 h-4 w-4" />
							Force Purge
						</Button>
					) : null}
				</div>
			</div>

			<div className="flex flex-wrap gap-8 rounded-lg border border-gray-700 bg-[#1e2433] px-5 py-4">
				<div className="flex flex-col gap-1">
					<span className="text-gray-500 text-xs uppercase tracking-wide">
						Status
					</span>
					<div className="flex items-center gap-2">
						<Badge
							className={cn(
								"w-fit gap-1",
								workflow.status === "COMPLETED" &&
									"bg-green-600 hover:bg-green-700",
								workflow.status === "RUNNING" &&
									"bg-amber-500 hover:bg-amber-600",
								workflow.status === "FAILED" && "bg-red-600 hover:bg-red-700",
							)}
							variant={getStatusVariant(workflow.status)}
						>
							{workflow.status === "COMPLETED" && <Check className="h-3 w-3" />}
							{workflow.status === "RUNNING" && (
								<Circle className="h-2 w-2 animate-pulse fill-current" />
							)}
							{workflow.status}
						</Badge>
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<div className="flex items-center">
										{workflow.daprStatus?.runtimeStatus &&
										workflow.daprStatus.runtimeStatus !== "UNKNOWN" ? (
											<Badge
												className="gap-1 border-teal-500/50 bg-teal-500/10 text-teal-400 text-xs"
												variant="outline"
											>
												<Radio className="h-2.5 w-2.5 animate-pulse" />
												Live
											</Badge>
										) : (
											<Badge
												className="gap-1 border-gray-600 bg-gray-800/50 text-gray-500 text-xs"
												variant="outline"
											>
												<WifiOff className="h-2.5 w-2.5" />
												DB
											</Badge>
										)}
									</div>
								</TooltipTrigger>
								<TooltipContent className="max-w-xs" side="bottom">
									{workflow.daprStatus?.runtimeStatus &&
									workflow.daprStatus.runtimeStatus !== "UNKNOWN" ? (
										<div className="space-y-1">
											<p className="font-medium text-teal-400">
												Live from Dapr Runtime
											</p>
											<p className="text-gray-400 text-xs">
												Status: {workflow.daprStatus.runtimeStatus}
											</p>
											{workflow.daprStatus.currentNodeName && (
												<p className="text-gray-400 text-xs">
													Current: {workflow.daprStatus.currentNodeName}
												</p>
											)}
										</div>
									) : (
										<div className="space-y-1">
											<p className="font-medium text-gray-300">From Database</p>
											<p className="text-gray-400 text-xs">
												Dapr workflow not found (may be purged after completion)
											</p>
										</div>
									)}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					</div>
				</div>

				{workflow.customStatus?.phase && (
					<div className="flex flex-col gap-1">
						<span className="text-gray-500 text-xs uppercase tracking-wide">
							Phase
						</span>
						<span
							className={cn(
								"font-medium text-sm capitalize",
								getPhaseColor(workflow.customStatus.phase),
							)}
						>
							{getPhaseLabel(workflow.customStatus.phase)}
						</span>
					</div>
				)}

				{workflow.customStatus?.progress != null &&
					workflow.status === "RUNNING" && (
						<div className="flex flex-col gap-1">
							<span className="text-gray-500 text-xs uppercase tracking-wide">
								Progress
							</span>
							<div className="flex items-center gap-2">
								<Progress
									className="h-2 w-24"
									value={workflow.customStatus.progress}
								/>
								<span className="font-medium text-sm text-white">
									{workflow.customStatus.progress}%
								</span>
							</div>
						</div>
					)}

				<div className="flex flex-col gap-1">
					<span className="text-gray-500 text-xs uppercase tracking-wide">
						App ID
					</span>
					<span className="font-medium text-sm text-white">
						{workflow.appId}
					</span>
				</div>

				<div className="flex flex-col gap-1">
					<span className="text-gray-500 text-xs uppercase tracking-wide">
						Type
					</span>
					<span className="font-medium text-sm text-white">
						{workflow.workflowType}
					</span>
				</div>

				{workflow.workflowVersion ? (
					<div className="flex flex-col gap-1">
						<span className="text-gray-500 text-xs uppercase tracking-wide">
							Version
						</span>
						<span className="font-mono text-sm text-white">
							{workflow.workflowVersion}
						</span>
					</div>
				) : null}

				<div className="flex flex-col gap-1">
					<span className="text-gray-500 text-xs uppercase tracking-wide">
						Start
					</span>
					<span className="font-medium text-sm text-white">
						{formatDateTime(workflow.startTime)}
					</span>
				</div>

				<div className="flex flex-col gap-1">
					<span className="text-gray-500 text-xs uppercase tracking-wide">
						End
					</span>
					<span className="font-medium text-sm text-white">
						{workflow.endTime ? formatDateTime(workflow.endTime) : "-"}
					</span>
				</div>

				<div className="flex flex-col gap-1">
					<span className="text-gray-500 text-xs uppercase tracking-wide">
						Duration
					</span>
					<span className="font-medium text-sm text-white">
						{workflow.executionDuration || "-"}
					</span>
				</div>

				{workflow.rerunOfExecutionId ? (
					<div className="flex flex-col gap-1">
						<span className="text-gray-500 text-xs uppercase tracking-wide">
							Rerun Of
						</span>
						<span className="font-mono text-sm text-white">
							{workflow.rerunOfExecutionId}
						</span>
					</div>
				) : null}

				{workflow.rerunFromEventId != null ? (
					<div className="flex flex-col gap-1">
						<span className="text-gray-500 text-xs uppercase tracking-wide">
							Rerun Event
						</span>
						<span className="font-mono text-sm text-white">
							{workflow.rerunFromEventId}
						</span>
					</div>
				) : null}
			</div>

			{workflow.status === "RUNNING" &&
				workflow.daprStatus?.currentNodeName && (
					<div className="rounded-lg border border-teal-500/30 bg-teal-500/5 px-4 py-3">
						<div className="flex items-center gap-2">
							<Circle className="h-2 w-2 animate-pulse fill-teal-400 text-teal-400" />
							<span className="text-gray-400 text-xs uppercase">
								Currently Executing:
							</span>
							<span className="font-medium text-sm text-teal-400">
								{workflow.daprStatus.currentNodeName}
							</span>
						</div>
					</div>
				)}

			{workflow.customStatus?.message && (
				<div className="rounded-lg border border-gray-700 bg-[#1e2433]/50 px-4 py-3">
					<span className="text-gray-300 text-sm">
						{workflow.customStatus.message}
					</span>
				</div>
			)}

			{workflow.daprStatus?.error && (
				<div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
					<div className="flex items-start gap-2">
						<span className="font-medium text-red-400 text-xs uppercase">
							Dapr Error:
						</span>
						<span className="text-red-300 text-sm">
							{workflow.daprStatus.error}
						</span>
					</div>
				</div>
			)}

			{workflow.errorStackTrace ? (
				<div className="rounded-lg border border-red-500/20 bg-black/30 px-4 py-3">
					<div className="mb-2 font-medium text-red-300 text-xs uppercase">
						Failure Stack Trace
					</div>
					<pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-red-200 text-xs">
						{workflow.errorStackTrace}
					</pre>
				</div>
			) : null}
		</div>
	);
}
