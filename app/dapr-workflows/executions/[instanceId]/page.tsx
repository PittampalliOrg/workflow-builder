"use client";

import { format } from "date-fns";
import {
	ArrowLeft,
	Bell,
	Check,
	ChevronDown,
	Circle,
	Clock,
	Copy,
	Maximize2,
	MoreVertical,
	Play,
	RefreshCw,
	StopCircle,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { WorkflowDefinitionGraph } from "@/components/monitor/workflow-definition-graph";
import { api } from "@/lib/api-client";
import type {
	WorkflowExecutionDetail,
	WorkflowHistoryEvent,
} from "@/lib/types/workflow-dashboard";
import type { WorkflowRuntimeGraph } from "@/lib/types/workflow-graph";
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

type DetailTab = "history" | "graph" | "relationships";

export default function ExecutionDetailPage() {
	const params = useParams<{ instanceId: string }>();
	const router = useRouter();
	const instanceId = decodeURIComponent(params.instanceId);

	const [data, setData] = useState<WorkflowExecutionDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [tab, setTab] = useState<DetailTab>("graph");
	const [graph, setGraph] = useState<WorkflowRuntimeGraph | undefined>(
		undefined,
	);
	const [copiedId, setCopiedId] = useState(false);
	const [showContext, setShowContext] = useState(false);
	const [relationships, setRelationships] = useState<RelationshipRow[]>([]);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const fetchDetail = useCallback(async () => {
		try {
			const result = await api.workflowDashboard.getExecution(instanceId);
			setData(result);
		} catch (error) {
			console.error("Failed to fetch execution detail:", error);
			toast.error("Failed to load execution detail");
		} finally {
			setLoading(false);
		}
	}, [instanceId]);

	useEffect(() => {
		fetchDetail();
		api.workflowDashboard
			.getExecutionGraph(instanceId)
			.then(setGraph)
			.catch(() => {});
		api.workflowDashboard
			.getExecutionRelationships(instanceId)
			.then((r) => setRelationships(r.relationships))
			.catch(() => {});
	}, [fetchDetail, instanceId]);

	const handleTerminate = async () => {
		try {
			await api.workflowDashboard.terminateExecution(instanceId);
			toast.success("Workflow terminated");
			fetchDetail();
		} catch {
			toast.error("Failed to terminate workflow");
		}
	};

	const handleRerun = async () => {
		try {
			const result = await api.workflowDashboard.rerunExecution(instanceId);
			toast.success("New execution started");
			router.push(
				`/dapr-workflows/executions/${encodeURIComponent(result.newInstanceId)}`,
			);
		} catch {
			toast.error("Failed to rerun workflow");
		}
	};

	// Auto-refresh while running
	useEffect(() => {
		if (data?.status === "RUNNING" || data?.status === "PENDING") {
			intervalRef.current = setInterval(fetchDetail, 5_000);
		} else {
			intervalRef.current = setInterval(fetchDetail, 30_000);
		}
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [fetchDetail, data?.status]);

	const copyInstanceId = () => {
		navigator.clipboard.writeText(instanceId);
		setCopiedId(true);
		setTimeout(() => setCopiedId(false), 2000);
	};

	const copyJson = (value: unknown) => {
		navigator.clipboard.writeText(JSON.stringify(value, null, 2));
		toast.success("Copied to clipboard");
	};

	if (loading) {
		return (
			<div className="pointer-events-auto mx-auto max-w-6xl p-6">
				<Skeleton className="mb-2 h-5 w-24" />
				<Skeleton className="mb-2 h-8 w-64" />
				<Skeleton className="mb-6 h-5 w-96" />
				<div className="grid grid-cols-4 gap-4 mb-6">
					{Array.from({ length: 4 }).map((_, i) => (
						<Skeleton key={i} className="h-16" />
					))}
				</div>
				<Skeleton className="h-64 w-full rounded-lg" />
			</div>
		);
	}

	if (!data) {
		return (
			<div className="pointer-events-auto mx-auto max-w-6xl p-6">
				<p className="text-muted-foreground">Execution not found.</p>
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
			<div className="mb-1 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<div className="h-8 w-1 rounded-full bg-emerald-500" />
					<h1 className="font-semibold text-2xl">{data.workflowName}</h1>
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" className="size-8">
							<MoreVertical className="size-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={handleRerun}>
							<RefreshCw className="mr-2 size-4" />
							Run new from
						</DropdownMenuItem>
						<DropdownMenuItem
							className="text-red-600 dark:text-red-400"
							disabled={data.status !== "RUNNING" && data.status !== "PENDING"}
							onClick={handleTerminate}
						>
							<StopCircle className="mr-2 size-4" />
							Terminate Workflow
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="mb-2 ml-4 flex items-center gap-2">
				<span className="text-sm text-muted-foreground">Instance ID:</span>
				<code className="text-sm font-mono">{instanceId}</code>
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					onClick={copyInstanceId}
				>
					{copiedId ? (
						<Check className="size-3 text-green-500" />
					) : (
						<Copy className="size-3" />
					)}
				</Button>
			</div>
			<div className="mb-6 ml-4">
				<Link
					href="/dapr-workflows?tab=executions"
					className="text-sm text-emerald-600 hover:underline dark:text-emerald-400"
				>
					Workflow executions
				</Link>
			</div>

			{/* Metadata Bar */}
			<div className="mb-6 flex flex-wrap items-start gap-8 rounded-lg border p-4">
				<MetaItem label="APP ID">
					<span className="text-emerald-600 dark:text-emerald-400">
						{data.appId}
					</span>
				</MetaItem>
				<MetaItem label="START TIME">
					{formatTimestamp(data.startTime)}
				</MetaItem>
				<MetaItem label="END TIME">{formatTimestamp(data.endTime)}</MetaItem>
				<MetaItem label="EXECUTION TIME">{data.executionTime ?? "-"}</MetaItem>
			</div>

			{/* Status Badge */}
			<div className="mb-6">
				<Badge
					variant="outline"
					className={`text-sm px-3 py-1 ${getStatusBadgeClasses(data.status)}`}
				>
					{data.status}
				</Badge>
				{data.error && (
					<p className="mt-2 text-sm text-red-600 dark:text-red-400">
						{data.error}
					</p>
				)}
			</div>

			{/* Input / Output */}
			<div className="mb-8 grid gap-4 md:grid-cols-2">
				<JsonPanel
					title="Input"
					value={data.input}
					onCopy={() => copyJson(data.input)}
				/>
				<JsonPanel
					title="Output"
					value={data.output}
					onCopy={() => copyJson(data.output)}
				/>
			</div>

			{/* Tabs */}
			<div className="mb-4 flex border-b">
				{(
					[
						["history", "History"],
						["graph", "Graph"],
						["relationships", "Relationships"],
					] as const
				).map(([key, label]) => (
					<button
						key={key}
						type="button"
						className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
							tab === key
								? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
								: "border-transparent text-muted-foreground hover:text-foreground"
						}`}
						onClick={() => setTab(key)}
					>
						{label}
					</button>
				))}
			</div>

			{/* Tab Content */}
			{tab === "history" && <HistoryTab history={data.history} />}
			{tab === "graph" && (
				<div>
					<div className="mb-3 flex items-center justify-end gap-3">
						<div className="flex items-center gap-2">
							<Switch checked={showContext} onCheckedChange={setShowContext} />
							<label className="text-sm text-muted-foreground">
								Show context
							</label>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								api.workflowDashboard
									.getExecutionGraph(instanceId)
									.then(setGraph)
									.catch(() => {});
							}}
						>
							<RefreshCw className="mr-1.5 size-3.5" />
							Refresh
						</Button>
					</div>
					<WorkflowDefinitionGraph graph={graph} showContext={showContext} />
				</div>
			)}
			{tab === "relationships" && (
				<RelationshipsTab relationships={relationships} />
			)}
		</div>
	);
}

function MetaItem({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<span className="block text-xs font-bold uppercase tracking-wide text-muted-foreground mb-1">
				{label}
			</span>
			<span className="text-sm">{children}</span>
		</div>
	);
}

function JsonPanel({
	title,
	value,
	onCopy,
}: {
	title: string;
	value: unknown;
	onCopy: () => void;
}) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const json = value != null ? JSON.stringify(value, null, 2) : "null";
	const isLong = json.length > 500;

	return (
		<div className="rounded-lg border">
			<div className="flex items-center justify-between border-b px-4 py-2">
				<span className="text-sm font-medium">{title}</span>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 text-xs text-emerald-600 dark:text-emerald-400"
						onClick={onCopy}
					>
						Copy
					</Button>
					{isLong && (
						<Button
							variant="ghost"
							size="icon"
							className="size-7"
							onClick={() => setDialogOpen(true)}
						>
							<Maximize2 className="size-3.5" />
						</Button>
					)}
				</div>
			</div>
			<pre className="hidden" />
			<CodeBlock
				className={isLong ? "max-h-48" : undefined}
				code={json}
				language="json"
			/>
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent className="max-w-3xl max-h-[80vh]">
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
					</DialogHeader>
					<div className="flex justify-end">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 text-xs text-emerald-600 dark:text-emerald-400"
							onClick={onCopy}
						>
							Copy
						</Button>
					</div>
					<CodeBlock className="max-h-[60vh]" code={json} language="json" />
				</DialogContent>
			</Dialog>
		</div>
	);
}

type RelationshipRow = {
	instanceId: string;
	status: WorkflowUIStatus;
	relationship: "rerun-source" | "rerun-child";
	appId: string;
	startTime: string;
	endTime: string | null;
};

function RelationshipsTab({
	relationships,
}: {
	relationships: RelationshipRow[];
}) {
	if (relationships.length === 0) {
		return (
			<div className="rounded-lg border p-8 text-center text-muted-foreground text-sm">
				No related executions found.
			</div>
		);
	}

	return (
		<div className="rounded-md border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Instance ID</TableHead>
						<TableHead>Status</TableHead>
						<TableHead>Relationship</TableHead>
						<TableHead>App ID</TableHead>
						<TableHead>Start Time</TableHead>
						<TableHead>End Time</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{relationships.map((rel) => (
						<TableRow key={rel.instanceId}>
							<TableCell>
								<Link
									href={`/dapr-workflows/executions/${encodeURIComponent(rel.instanceId)}`}
									className="font-mono text-xs text-emerald-600 hover:underline dark:text-emerald-400"
								>
									{rel.instanceId}
								</Link>
							</TableCell>
							<TableCell>
								<Badge
									variant="outline"
									className={`text-xs ${getStatusBadgeClasses(rel.status)}`}
								>
									{rel.status}
								</Badge>
							</TableCell>
							<TableCell className="text-sm">
								{rel.relationship === "rerun-source" ? "Rerun Source" : "Rerun"}
							</TableCell>
							<TableCell className="text-sm text-emerald-600 dark:text-emerald-400">
								{rel.appId}
							</TableCell>
							<TableCell className="text-sm text-muted-foreground">
								{formatTimestamp(rel.startTime)}
							</TableCell>
							<TableCell className="text-sm text-muted-foreground">
								{formatTimestamp(rel.endTime)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function HistoryTab({
	history,
}: {
	history: WorkflowExecutionDetail["history"];
}) {
	const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set());

	if (history.length === 0) {
		return (
			<div className="rounded-lg border p-8 text-center text-muted-foreground text-sm">
				No history events.
			</div>
		);
	}

	const toggleEvent = (index: number) => {
		setExpandedEvents((prev) => {
			const next = new Set(prev);
			if (next.has(index)) next.delete(index);
			else next.add(index);
			return next;
		});
	};

	// Calculate duration between consecutive events
	const getDuration = (
		event: WorkflowHistoryEvent,
		index: number,
	): string | null => {
		if (index >= history.length - 1) return null;
		const nextEvent = history[index + 1];
		if (!event.timestamp || !nextEvent.timestamp) return null;
		const ms =
			new Date(nextEvent.timestamp).getTime() -
			new Date(event.timestamp).getTime();
		if (ms < 0) return null;
		if (ms < 1000) return `${ms.toFixed(2)}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
		const minutes = Math.floor(ms / 60000);
		const seconds = Math.round((ms % 60000) / 1000);
		return `${minutes}m ${seconds}s`;
	};

	const getEventIcon = (eventType: string) => {
		const type = eventType.toLowerCase();
		if (type.includes("started") || type.includes("created")) {
			return {
				icon: <Play className="size-3.5 text-white" />,
				bg: "bg-emerald-500",
			};
		}
		if (type.includes("completed")) {
			return {
				icon: <Check className="size-3.5 text-white" />,
				bg: "bg-emerald-500",
			};
		}
		if (type.includes("scheduled")) {
			return {
				icon: <Clock className="size-3.5 text-white" />,
				bg: "bg-amber-500",
			};
		}
		if (type.includes("failed") || type.includes("error")) {
			return {
				icon: <XCircle className="size-3.5 text-white" />,
				bg: "bg-red-500",
			};
		}
		if (type.includes("raised")) {
			return {
				icon: <Bell className="size-3.5 text-white" />,
				bg: "bg-blue-500",
			};
		}
		if (type.includes("timer")) {
			return {
				icon: <Clock className="size-3.5 text-white" />,
				bg: "bg-purple-500",
			};
		}
		return {
			icon: <Circle className="size-3.5 text-white" />,
			bg: "bg-gray-500",
		};
	};

	const getEventBadgeClasses = (eventType: string) => {
		const type = eventType.toLowerCase();
		if (type.includes("started") || type.includes("created")) {
			return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
		}
		if (type.includes("completed")) {
			return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
		}
		if (type.includes("scheduled")) {
			return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400";
		}
		if (type.includes("failed") || type.includes("error")) {
			return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
		}
		return "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400";
	};

	return (
		<div className="rounded-lg border p-6">
			<h3 className="mb-6 font-semibold text-base">Event history</h3>
			<div className="relative">
				{history.map((event, i) => {
					const { icon, bg } = getEventIcon(event.eventType);
					const isExpanded = expandedEvents.has(i);
					const duration = getDuration(event, i);
					const isLast = i === history.length - 1;
					const hasContent = event.input != null || event.output != null;

					return (
						<div
							key={event.eventId ?? i}
							className="relative flex gap-4 pb-8 last:pb-0"
						>
							{/* Timeline line */}
							{!isLast && (
								<div className="absolute left-[15px] top-[32px] bottom-0 w-[2px] bg-gray-200 dark:bg-gray-700" />
							)}
							{/* Icon */}
							<div
								className={`relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full ${bg}`}
							>
								{icon}
							</div>
							{/* Content */}
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2 flex-wrap">
									<span className="font-medium text-sm">
										{event.name ?? event.eventType}
									</span>
									<Badge
										variant="secondary"
										className={`text-[11px] px-2 py-0 font-medium ${getEventBadgeClasses(event.eventType)}`}
									>
										{event.eventType}
									</Badge>
									{hasContent && (
										<button
											type="button"
											className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
											onClick={() => toggleEvent(i)}
										>
											<ChevronDown
												className={`size-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
											/>
										</button>
									)}
								</div>
								<div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
									<span>{formatTimestamp(event.timestamp)}</span>
									{duration && (
										<span className="font-medium">({duration})</span>
									)}
								</div>
								{event.eventId != null && (
									<div className="mt-0.5 text-xs text-muted-foreground">
										Event ID: {event.eventId}
									</div>
								)}
								{/* Expanded content */}
								{isExpanded && hasContent && (
									<div className="mt-3 space-y-2">
										{event.input != null && (
											<div className="rounded-md bg-muted/50 p-3">
												<span className="text-xs font-medium text-muted-foreground">
													Input
												</span>
												<pre className="mt-1 overflow-auto text-xs font-mono max-h-40">
													{JSON.stringify(event.input, null, 2)}
												</pre>
											</div>
										)}
										{event.output != null && (
											<div className="rounded-md bg-muted/50 p-3">
												<span className="text-xs font-medium text-muted-foreground">
													Output
												</span>
												<pre className="mt-1 overflow-auto text-xs font-mono max-h-40">
													{JSON.stringify(event.output, null, 2)}
												</pre>
											</div>
										)}
									</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
