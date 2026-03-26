"use client";

import { useCallback, useEffect, useState } from "react";
import type {
	DurableExternalEventSummary,
	DurablePlanArtifactSummary,
	DurableTaskSummary,
} from "@/lib/types/durable-timeline";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { getRelativeTime } from "@/lib/utils/time";

// ── Types ────────────────────────────────────────────────────

type PlanTask = {
	id: string;
	subject: string;
	description: string;
	status: string;
	blocked?: boolean;
	blockedBy: string[];
	tool?: string;
	targetPaths: string[];
	acceptanceCriteria: string[];
	reasoning?: string;
};

type FullArtifact = {
	planJson: { tasks: PlanTask[] } | null;
	planMarkdown: string | null;
	sourcePrompt: string | null;
};

type BrowserArtifactSummary = Awaited<
	ReturnType<typeof api.workflow.getExecutionBrowserArtifacts>
>["artifacts"][number];
type BrowserArtifactDetail = Awaited<
	ReturnType<typeof api.workflow.getExecutionBrowserArtifactById>
>["artifact"];

type RunArtifactsTabProps = {
	executionId: string;
	planArtifacts: DurablePlanArtifactSummary[];
	externalEvents: DurableExternalEventSummary[];
};

// ── Task status helpers ──────────────────────────────────────

const TASK_STATUS_CONFIG: Record<
	string,
	{ label: string; icon: string; className: string }
> = {
	completed: {
		label: "Completed",
		icon: "\u2713",
		className:
			"border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
	},
	failed: {
		label: "Failed",
		icon: "\u2717",
		className: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
	},
	skipped: {
		label: "Skipped",
		icon: "\u21B7",
		className:
			"border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
	},
	in_progress: {
		label: "In Progress",
		icon: "\u25B6",
		className:
			"border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
	},
	pending: {
		label: "Pending",
		icon: "\u25CB",
		className:
			"border-gray-500/30 bg-gray-500/10 text-gray-600 dark:text-gray-400",
	},
};

function TaskStatusBadge({ status }: { status: string }) {
	const normalized = status.toLowerCase();
	const config = TASK_STATUS_CONFIG[normalized] ?? TASK_STATUS_CONFIG.pending;
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium",
				config.className,
			)}
		>
			<span className="text-[10px]">{config.icon}</span>
			{config.label}
		</span>
	);
}

// ── Progress bar ─────────────────────────────────────────────

function TaskProgressBar({ summary }: { summary: DurableTaskSummary }) {
	if (summary.total === 0) return null;
	const pct = (n: number) => `${((n / summary.total) * 100).toFixed(1)}%`;
	return (
		<div className="flex items-center gap-2">
			<div className="flex h-2 flex-1 overflow-hidden rounded-full bg-muted">
				{summary.completed > 0 && (
					<div
						className="bg-green-500"
						style={{ width: pct(summary.completed) }}
					/>
				)}
				{summary.failed > 0 && (
					<div className="bg-red-500" style={{ width: pct(summary.failed) }} />
				)}
				{summary.skipped > 0 && (
					<div
						className="bg-amber-400"
						style={{ width: pct(summary.skipped) }}
					/>
				)}
				{summary.inProgress > 0 && (
					<div
						className="bg-blue-500"
						style={{ width: pct(summary.inProgress) }}
					/>
				)}
				{summary.pending > 0 && (
					<div
						className="bg-gray-300 dark:bg-gray-600"
						style={{ width: pct(summary.pending) }}
					/>
				)}
			</div>
			<span className="shrink-0 text-muted-foreground text-xs">
				{summary.completed}/{summary.total}
				{summary.failed > 0 && (
					<span className="text-red-600 dark:text-red-400">
						{" "}
						{summary.failed} failed
					</span>
				)}
				{summary.skipped > 0 && (
					<span className="text-amber-600 dark:text-amber-400">
						{" "}
						{summary.skipped} skipped
					</span>
				)}
			</span>
		</div>
	);
}

// ── Artifact status badge ────────────────────────────────────

function ArtifactStatusBadge({ status }: { status: string }) {
	const normalized = status.toLowerCase();
	const styles: Record<string, string> = {
		draft: "border-gray-500/30 bg-gray-500/10 text-gray-600 dark:text-gray-400",
		approved:
			"border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
		executing:
			"border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
		executed:
			"border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
		failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
	};
	return (
		<span
			className={cn(
				"inline-flex rounded-md border px-1.5 py-0.5 text-xs font-medium capitalize",
				styles[normalized] ?? styles.draft,
			)}
		>
			{status}
		</span>
	);
}

// ── Task detail expansion ────────────────────────────────────

function TaskDetailPanel({ task }: { task: PlanTask }) {
	return (
		<div className="space-y-2 border-t bg-muted/30 px-4 py-3 text-xs">
			{task.description && (
				<div>
					<div className="mb-0.5 font-medium text-muted-foreground">
						Description
					</div>
					<div className="whitespace-pre-wrap">{task.description}</div>
				</div>
			)}
			{task.acceptanceCriteria.length > 0 && (
				<div>
					<div className="mb-0.5 font-medium text-muted-foreground">
						Acceptance Criteria
					</div>
					<ul className="list-inside list-disc space-y-0.5">
						{task.acceptanceCriteria.map((criterion, i) => (
							<li key={i}>{criterion}</li>
						))}
					</ul>
				</div>
			)}
			{task.reasoning && (
				<div>
					<div className="mb-0.5 font-medium text-muted-foreground">
						Reasoning
					</div>
					<div className="whitespace-pre-wrap text-muted-foreground">
						{task.reasoning}
					</div>
				</div>
			)}
			{task.tool && (
				<div>
					<span className="font-medium text-muted-foreground">Tool: </span>
					<code className="rounded bg-muted px-1 py-0.5">{task.tool}</code>
				</div>
			)}
		</div>
	);
}

// ── Expandable task list ─────────────────────────────────────

function TaskList({ tasks }: { tasks: PlanTask[] }) {
	const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

	return (
		<div className="border-t">
			<table className="w-full text-xs">
				<thead>
					<tr className="border-b bg-muted/50 text-left">
						<th className="px-3 py-1.5 font-medium">Status</th>
						<th className="px-3 py-1.5 font-medium">ID</th>
						<th className="px-3 py-1.5 font-medium">Subject</th>
						<th className="px-3 py-1.5 font-medium">Target Files</th>
						<th className="px-3 py-1.5 font-medium">Blocked By</th>
					</tr>
				</thead>
				<tbody>
					{tasks.map((task) => {
						const isExpanded = expandedTaskId === task.id;
						return (
							<>
								<tr
									className={cn(
										"cursor-pointer border-b transition-colors hover:bg-muted/40",
										isExpanded && "bg-muted/30",
									)}
									key={task.id}
									onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
								>
									<td className="px-3 py-1.5">
										<TaskStatusBadge status={task.status} />
									</td>
									<td className="px-3 py-1.5 font-mono">{task.id}</td>
									<td className="max-w-[340px] truncate px-3 py-1.5">
										{task.subject}
									</td>
									<td className="px-3 py-1.5">
										{task.targetPaths.length > 0 ? (
											<div className="flex flex-wrap gap-1">
												{task.targetPaths.slice(0, 3).map((path) => (
													<code
														className="rounded bg-muted px-1 py-0.5 text-[10px]"
														key={path}
													>
														{path.length > 40 ? `...${path.slice(-37)}` : path}
													</code>
												))}
												{task.targetPaths.length > 3 && (
													<span className="text-muted-foreground">
														+{task.targetPaths.length - 3}
													</span>
												)}
											</div>
										) : (
											<span className="text-muted-foreground">-</span>
										)}
									</td>
									<td className="px-3 py-1.5">
										{task.blockedBy.length > 0 ? (
											<span className="font-mono text-muted-foreground">
												{task.blockedBy.join(", ")}
											</span>
										) : (
											<span className="text-muted-foreground">-</span>
										)}
									</td>
								</tr>
								{isExpanded && (
									<tr key={`${task.id}-detail`}>
										<td colSpan={5}>
											<TaskDetailPanel task={task} />
										</td>
									</tr>
								)}
							</>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

// ── Expandable artifact row ──────────────────────────────────

function ArtifactRow({
	artifact,
	executionId,
}: {
	artifact: DurablePlanArtifactSummary;
	executionId: string;
}) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [fullArtifact, setFullArtifact] = useState<FullArtifact | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);

	const handleToggle = useCallback(async () => {
		if (isExpanded) {
			setIsExpanded(false);
			return;
		}

		setIsExpanded(true);

		if (fullArtifact) return;

		setIsLoading(true);
		setFetchError(null);
		try {
			const data = await api.workflow.getPlanArtifact(artifact.id);
			setFullArtifact({
				planJson: data.artifact.planJson,
				planMarkdown: data.artifact.planMarkdown,
				sourcePrompt: data.artifact.sourcePrompt,
			});
		} catch (err) {
			setFetchError(
				err instanceof Error ? err.message : "Failed to load artifact",
			);
		} finally {
			setIsLoading(false);
		}
	}, [artifact.id, fullArtifact, isExpanded]);

	return (
		<div className="border-b last:border-b-0">
			<button
				className={cn(
					"flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40",
					isExpanded && "bg-muted/20",
				)}
				onClick={handleToggle}
				type="button"
			>
				<span className="mt-0.5 text-muted-foreground text-xs">
					{isExpanded ? "\u25BC" : "\u25B6"}
				</span>
				<div className="min-w-0 flex-1 space-y-1.5">
					<div className="flex items-center gap-2">
						<ArtifactStatusBadge status={artifact.status} />
						<span className="truncate text-sm font-medium">
							{artifact.goal}
						</span>
						<span className="shrink-0 font-mono text-muted-foreground text-xs">
							{artifact.id.slice(0, 12)}...
						</span>
					</div>
					{artifact.taskSummary && (
						<TaskProgressBar summary={artifact.taskSummary} />
					)}
					<div className="flex items-center gap-3 text-muted-foreground text-xs">
						<span>Node: {artifact.nodeId}</span>
						<span>v{artifact.artifactVersion}</span>
						<span title={new Date(artifact.createdAt).toLocaleString()}>
							{getRelativeTime(artifact.createdAt)}
						</span>
					</div>
				</div>
			</button>

			{isExpanded && (
				<div className="px-3 pb-3">
					{isLoading && (
						<div className="rounded-md border border-dashed p-4 text-center text-muted-foreground text-xs">
							Loading task details...
						</div>
					)}
					{fetchError && (
						<div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-700 text-xs dark:text-red-300">
							{fetchError}
						</div>
					)}
					{fullArtifact && (
						<div className="overflow-hidden rounded-md border">
							{fullArtifact.planJson?.tasks &&
							fullArtifact.planJson.tasks.length > 0 ? (
								<TaskList tasks={fullArtifact.planJson.tasks} />
							) : (
								<div className="p-3 text-muted-foreground text-xs">
									No tasks found in plan.
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function BrowserArtifactStatusBadge({
	status,
}: {
	status: BrowserArtifactSummary["status"];
}) {
	const styles: Record<string, string> = {
		pending:
			"border-gray-500/30 bg-gray-500/10 text-gray-600 dark:text-gray-400",
		completed:
			"border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
		partial:
			"border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		failed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
	};
	return (
		<span
			className={cn(
				"inline-flex rounded-md border px-1.5 py-0.5 text-xs font-medium capitalize",
				styles[status] ?? styles.pending,
			)}
		>
			{status}
		</span>
	);
}

function BrowserArtifactRow({
	artifact,
	executionId,
	autoExpand = false,
}: {
	artifact: BrowserArtifactSummary;
	executionId: string;
	autoExpand?: boolean;
}) {
	const [isExpanded, setIsExpanded] = useState(autoExpand);
	const [detail, setDetail] = useState<BrowserArtifactDetail | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);

	const fetchDetail = useCallback(async () => {
		if (detail) return;
		setIsLoading(true);
		setFetchError(null);
		try {
			const data = await api.workflow.getExecutionBrowserArtifactById(
				executionId,
				artifact.id,
			);
			setDetail(data.artifact);
		} catch (err) {
			setFetchError(
				err instanceof Error ? err.message : "Failed to load browser artifact",
			);
		} finally {
			setIsLoading(false);
		}
	}, [artifact.id, detail, executionId]);

	const handleToggle = useCallback(async () => {
		if (isExpanded) {
			setIsExpanded(false);
			return;
		}
		setIsExpanded(true);
		await fetchDetail();
	}, [fetchDetail, isExpanded]);

	// Auto-fetch detail when autoExpand is true
	useEffect(() => {
		if (autoExpand && !detail && !isLoading) {
			void fetchDetail();
		}
	}, [autoExpand, detail, fetchDetail, isLoading]);

	return (
		<div className="border-b last:border-b-0">
			<button
				className={cn(
					"flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40",
					isExpanded && "bg-muted/20",
				)}
				onClick={handleToggle}
				type="button"
			>
				<span className="mt-0.5 text-muted-foreground text-xs">
					{isExpanded ? "\u25BC" : "\u25B6"}
				</span>
				<div className="min-w-0 flex-1 space-y-1.5">
					<div className="flex items-center gap-2">
						<BrowserArtifactStatusBadge status={artifact.status} />
						<span className="truncate text-sm font-medium">
							{artifact.manifest.steps[0]?.label || "Browser capture"}
						</span>
						<span className="shrink-0 text-muted-foreground text-xs">
							{
								artifact.manifest.steps.filter(
									(step) => step.status === "completed",
								).length
							}
							/{artifact.manifest.steps.length} captured
						</span>
					</div>
					<div className="flex items-center gap-3 text-muted-foreground text-xs">
						<span>Node: {artifact.nodeId}</span>
						<span>{artifact.manifest.baseUrl}</span>
						<span title={new Date(artifact.createdAt).toLocaleString()}>
							{getRelativeTime(artifact.createdAt)}
						</span>
					</div>
				</div>
			</button>

			{isExpanded && (
				<div className="space-y-3 px-3 pb-3">
					{isLoading && (
						<div className="rounded-md border border-dashed p-4 text-center text-muted-foreground text-xs">
							Loading browser capture...
						</div>
					)}
					{fetchError && (
						<div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-700 text-xs dark:text-red-300">
							{fetchError}
						</div>
					)}
					{detail && (
						<div className="space-y-3">
							<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
								{detail.manifest.steps.map((step) => (
									<div
										className="overflow-hidden rounded-md border bg-background"
										key={step.id}
									>
										<div className="border-b px-3 py-2">
											<div className="flex items-center justify-between gap-2">
												<div className="truncate font-medium text-sm">
													{step.label}
												</div>
												<span className="text-muted-foreground text-xs capitalize">
													{step.status}
												</span>
											</div>
											<div className="truncate text-muted-foreground text-xs">
												{step.url}
											</div>
										</div>
										{step.screenshotDataUrl ? (
											<img
												alt={step.label}
												className="aspect-video w-full object-cover"
												src={step.screenshotDataUrl}
											/>
										) : (
											<div className="flex aspect-video items-center justify-center bg-muted/40 text-muted-foreground text-xs">
												{step.error ? step.error : "No screenshot"}
											</div>
										)}
										<div className="space-y-1 px-3 py-2 text-xs">
											{step.title && (
												<div className="truncate text-muted-foreground">
													Title: {step.title}
												</div>
											)}
											{step.waitForSelector && (
												<div className="truncate text-muted-foreground">
													Selector: {step.waitForSelector}
												</div>
											)}
											{step.waitForText && (
												<div className="truncate text-muted-foreground">
													Text: {step.waitForText}
												</div>
											)}
											{step.capturedAt && (
												<div className="text-muted-foreground">
													{getRelativeTime(step.capturedAt)}
												</div>
											)}
										</div>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ── Main component ───────────────────────────────────────────

export function RunArtifactsTab({
	executionId,
	planArtifacts,
	externalEvents,
}: RunArtifactsTabProps) {
	const [browserArtifacts, setBrowserArtifacts] = useState<
		BrowserArtifactSummary[]
	>([]);
	const [browserArtifactsLoaded, setBrowserArtifactsLoaded] = useState(false);
	const [browserArtifactsError, setBrowserArtifactsError] = useState<
		string | null
	>(null);

	useEffect(() => {
		let cancelled = false;
		void api.workflow
			.getExecutionBrowserArtifacts(executionId)
			.then((response) => {
				if (cancelled) return;
				setBrowserArtifacts(response.artifacts);
				setBrowserArtifactsError(null);
				setBrowserArtifactsLoaded(true);
			})
			.catch((error) => {
				if (cancelled) return;
				setBrowserArtifacts([]);
				setBrowserArtifactsError(
					error instanceof Error
						? error.message
						: "Failed to load browser artifacts",
				);
				setBrowserArtifactsLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [executionId]);

	if (
		planArtifacts.length === 0 &&
		externalEvents.length === 0 &&
		browserArtifacts.length === 0 &&
		browserArtifactsLoaded &&
		!browserArtifactsError
	) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No durable artifacts or external events were recorded for this run.
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="rounded-md border bg-background">
				<div className="border-b px-3 py-2 font-medium text-sm">
					Plan Artifacts ({planArtifacts.length})
				</div>
				{planArtifacts.length === 0 ? (
					<div className="p-3 text-muted-foreground text-sm">
						No plan artifacts.
					</div>
				) : (
					<div>
						{planArtifacts.map((artifact) => (
							<ArtifactRow
								artifact={artifact}
								executionId={executionId}
								key={artifact.id}
							/>
						))}
					</div>
				)}
			</div>

			<div className="rounded-md border bg-background">
				<div className="border-b px-3 py-2 font-medium text-sm">
					Browser Artifacts ({browserArtifacts.length})
				</div>
				{browserArtifactsError ? (
					<div className="p-3 text-red-700 text-sm dark:text-red-300">
						{browserArtifactsError}
					</div>
				) : !browserArtifactsLoaded ? (
					<div className="p-3 text-muted-foreground text-sm">
						Loading browser artifacts...
					</div>
				) : browserArtifacts.length === 0 ? (
					<div className="p-3 text-muted-foreground text-sm">
						No browser artifacts.
					</div>
				) : (
					<div>
						{browserArtifacts.map((artifact, index) => (
							<BrowserArtifactRow
								artifact={artifact}
								autoExpand={index === 0 && artifact.status === "completed"}
								executionId={executionId}
								key={artifact.id}
							/>
						))}
					</div>
				)}
			</div>

			<div className="rounded-md border bg-background">
				<div className="border-b px-3 py-2 font-medium text-sm">
					External Events ({externalEvents.length})
				</div>
				{externalEvents.length === 0 ? (
					<div className="p-3 text-muted-foreground text-sm">
						No external events.
					</div>
				) : (
					<div className="max-h-[220px] overflow-auto">
						<table className="w-full text-sm">
							<thead className="sticky top-0 z-10 bg-background">
								<tr className="border-b text-left">
									<th className="px-3 py-2 font-medium">Event</th>
									<th className="px-3 py-2 font-medium">Type</th>
									<th className="px-3 py-2 font-medium">Node</th>
									<th className="px-3 py-2 font-medium">Approved</th>
									<th className="px-3 py-2 font-medium">Created</th>
								</tr>
							</thead>
							<tbody>
								{externalEvents.map((event) => (
									<tr className="border-b align-top" key={event.id}>
										<td className="max-w-[340px] truncate px-3 py-2">
											{event.eventName}
										</td>
										<td className="px-3 py-2">{event.eventType}</td>
										<td className="px-3 py-2 font-mono text-xs">
											{event.nodeId}
										</td>
										<td className="px-3 py-2">
											{event.approved === null ? "-" : String(event.approved)}
										</td>
										<td className="px-3 py-2">
											<span title={new Date(event.createdAt).toLocaleString()}>
												{getRelativeTime(event.createdAt)}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
}
