"use client";

import {
	ArrowDown,
	ArrowUp,
	CheckCircle2,
	Clock,
	MoreVertical,
	RefreshCw,
	StopCircle,
	XCircle,
	Workflow,
} from "lucide-react";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import type {
	WorkflowNameSummary,
	WorkflowNamesResponse,
	AllExecutionsResponse,
} from "@/lib/types/workflow-dashboard";
import type { WorkflowUIStatus } from "@/lib/types/workflow-ui";

type Tab = "names" | "executions";
type SortKey = "name" | "appId" | "totalExecutions" | "running" | "success" | "failed";
type SortDir = "asc" | "desc";

export default function DaprWorkflowsPage() {
	return (
		<Suspense fallback={<div className="pointer-events-auto mx-auto max-w-6xl p-6"><Skeleton className="h-8 w-64" /></div>}>
			<DaprWorkflowsPageInner />
		</Suspense>
	);
}

function DaprWorkflowsPageInner() {
	const searchParams = useSearchParams();
	const [tab, setTab] = useState<Tab>((searchParams.get("tab") as Tab) || "names");
	const [data, setData] = useState<WorkflowNamesResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [search, setSearch] = useState(searchParams.get("search") || "");
	const [sortKey, setSortKey] = useState<SortKey>("name");
	const [sortDir, setSortDir] = useState<SortDir>("asc");
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const fetchData = useCallback(async () => {
		try {
			const result = await api.workflowDashboard.listNames({
				search: search || undefined,
			});
			setData(result);
		} catch (error) {
			console.error("Failed to fetch workflows:", error);
			toast.error("Failed to load workflows");
		} finally {
			setLoading(false);
		}
	}, [search]);

	useEffect(() => {
		setLoading(true);
		fetchData();
	}, [fetchData]);

	// Auto-refresh every 30s
	useEffect(() => {
		intervalRef.current = setInterval(fetchData, 30_000);
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [fetchData]);

	const handleSort = (key: SortKey) => {
		if (sortKey === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortKey(key);
			setSortDir("asc");
		}
	};

	const sorted = useMemo(() => {
		if (!data?.workflows) return [];
		const items = [...data.workflows];
		items.sort((a, b) => {
			let cmp: number;
			if (sortKey === "name" || sortKey === "appId") {
				cmp = (a[sortKey] ?? "").localeCompare(b[sortKey] ?? "");
			} else {
				cmp = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
			}
			return sortDir === "asc" ? cmp : -cmp;
		});
		return items;
	}, [data?.workflows, sortKey, sortDir]);

	const SortIndicator = ({ col }: { col: SortKey }) =>
		sortKey === col ? (
			sortDir === "asc" ? (
				<ArrowUp className="size-3 text-muted-foreground" />
			) : (
				<ArrowDown className="size-3 text-muted-foreground" />
			)
		) : null;

	return (
		<div className="pointer-events-auto mx-auto max-w-6xl p-6">
			{/* Header */}
			<div className="mb-6 flex items-center gap-3">
				<div className="h-8 w-1 rounded-full bg-emerald-500" />
				<h1 className="font-semibold text-2xl">Workflows</h1>
			</div>

			{/* Tabs */}
			<div className="mb-6 flex border-b">
				<button
					type="button"
					className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
						tab === "names"
							? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
							: "border-transparent text-muted-foreground hover:text-foreground"
					}`}
					onClick={() => setTab("names")}
				>
					Workflows
				</button>
				<button
					type="button"
					className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
						tab === "executions"
							? "border-emerald-500 text-emerald-600 dark:text-emerald-400"
							: "border-transparent text-muted-foreground hover:text-foreground"
					}`}
					onClick={() => setTab("executions")}
				>
					All workflow executions
				</button>
			</div>

			{/* Search + Refresh */}
			<div className="mb-4 flex items-center gap-3">
				<div className="relative flex-1">
					<Input
						placeholder="Search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
				<Button
					variant="outline"
					size="icon"
					onClick={() => {
						setLoading(true);
						fetchData();
					}}
				>
					<RefreshCw className="size-4" />
				</Button>
			</div>

			{tab === "names" ? (
				<WorkflowNamesTable
					loading={loading}
					workflows={sorted}
					totalRows={data?.totalRows ?? 0}
					sortKey={sortKey}
					onSort={handleSort}
					SortIndicator={SortIndicator}
				/>
			) : (
				<AllExecutionsView search={search} />
			)}
		</div>
	);
}

// ─── Workflow Names Table ───────────────────────────────────────────────────

function WorkflowNamesTable({
	loading,
	workflows,
	totalRows,
	sortKey,
	onSort,
	SortIndicator,
}: {
	loading: boolean;
	workflows: WorkflowNameSummary[];
	totalRows: number;
	sortKey: SortKey;
	onSort: (key: SortKey) => void;
	SortIndicator: React.ComponentType<{ col: SortKey }>;
}) {
	const columns: [SortKey, string][] = [
		["name", "Name"],
		["appId", "App ID"],
		["totalExecutions", "Total Executions"],
		["running", "Running"],
		["success", "Success"],
		["failed", "Failed"],
	];

	if (loading) {
		return (
			<div className="rounded-md border">
				<Table>
					<TableHeader>
						<TableRow>
							{columns.map(([, label]) => (
								<TableHead key={label}>{label}</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{Array.from({ length: 5 }).map((_, i) => (
							<TableRow key={i}>
								{columns.map(([, label]) => (
									<TableCell key={label}>
										<Skeleton className="h-4 w-20" />
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		);
	}

	if (workflows.length === 0) {
		return (
			<div className="py-16 text-center">
				<Workflow className="mx-auto mb-4 size-12 text-muted-foreground/50" />
				<p className="text-muted-foreground text-sm">
					No workflows found in the Dapr runtime.
				</p>
				<p className="mt-1 text-muted-foreground/70 text-xs">
					Workflows appear here when executed via the orchestrator.
				</p>
			</div>
		);
	}

	return (
		<>
			<div className="rounded-md border">
				<Table>
					<TableHeader>
						<TableRow>
							{columns.map(([col, label]) => (
								<TableHead
									key={col}
									className="cursor-pointer select-none"
									onClick={() => onSort(col)}
								>
									<div className="flex items-center gap-1">
										{label}
										<SortIndicator col={col} />
									</div>
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{workflows.map((wf) => (
							<TableRow key={wf.name}>
								<TableCell>
									<Link
										href={`/dapr-workflows/${encodeURIComponent(wf.appId)}/${encodeURIComponent(wf.name)}`}
										className="font-medium text-emerald-600 hover:underline dark:text-emerald-400"
									>
										{wf.name}
									</Link>
								</TableCell>
								<TableCell>
									<span className="text-sm text-emerald-600 dark:text-emerald-400">
										{wf.appId}
									</span>
								</TableCell>
								<TableCell className="text-sm">
									{wf.totalExecutions}
								</TableCell>
								<TableCell>
									<div className="flex items-center gap-1.5 text-sm">
										<Clock className="size-3.5 text-blue-500" />
										<span className="text-blue-600 dark:text-blue-400">
											{wf.running}
										</span>
									</div>
								</TableCell>
								<TableCell>
									<div className="flex items-center gap-1.5 text-sm">
										<CheckCircle2 className="size-3.5 text-green-500" />
										<span className="text-green-600 dark:text-green-400">
											{wf.success}
										</span>
									</div>
								</TableCell>
								<TableCell>
									<div className="flex items-center gap-1.5 text-sm">
										<XCircle className="size-3.5 text-red-500" />
										<span className="text-red-600 dark:text-red-400">
											{wf.failed}
										</span>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			<div className="mt-3 flex justify-end">
				<span className="text-muted-foreground text-xs">
					Total Rows: {totalRows}
				</span>
			</div>
		</>
	);
}

// ─── All Executions View ────────────────────────────────────────────────────

function getStatusBadgeClasses(status: WorkflowUIStatus): string {
	switch (status) {
		case "COMPLETED":
			return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
		case "RUNNING":
		case "PENDING":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
		case "FAILED":
		case "TERMINATED":
		case "CANCELLED":
			return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
		case "SUSPENDED":
			return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
		default:
			return "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400";
	}
}

function AllExecutionsView({ search }: { search: string }) {
	const [data, setData] = useState<AllExecutionsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [latestOnly, setLatestOnly] = useState(false);

	const fetchData = useCallback(() => {
		api.workflowDashboard
			.listAllExecutions({ search: search || undefined, latestOnly })
			.then((result) => {
				setData(result);
			})
			.catch(() => toast.error("Failed to load executions"))
			.finally(() => setLoading(false));
	}, [search, latestOnly]);

	useEffect(() => {
		setLoading(true);
		fetchData();
	}, [fetchData]);

	// Auto-refresh every 30 seconds
	useEffect(() => {
		const interval = setInterval(fetchData, 30_000);
		return () => clearInterval(interval);
	}, [fetchData]);

	const handleTerminate = async (instanceId: string) => {
		try {
			await api.workflowDashboard.terminateExecution(instanceId);
			toast.success("Workflow terminated");
			fetchData();
		} catch {
			toast.error("Failed to terminate workflow");
		}
	};

	const executions = data?.executions ?? [];
	const totalRows = data?.totalRows ?? 0;

	if (loading) {
		return (
			<div className="space-y-3">
				{Array.from({ length: 5 }).map((_, i) => (
					<Skeleton key={i} className="h-12 w-full" />
				))}
			</div>
		);
	}

	if (executions.length === 0) {
		return (
			<div className="py-16 text-center">
				<Workflow className="mx-auto mb-4 size-12 text-muted-foreground/50" />
				<p className="text-muted-foreground text-sm">No executions found.</p>
			</div>
		);
	}

	return (
		<>
			<div className="mb-4 flex items-center justify-end gap-3">
				<div className="flex items-center gap-2">
					<Switch checked={latestOnly} onCheckedChange={setLatestOnly} />
					<label className="text-sm text-muted-foreground">Latest only</label>
				</div>
			</div>
			<div className="rounded-md border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Instance ID</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Workflow Name</TableHead>
							<TableHead>App ID</TableHead>
							<TableHead>Start Time</TableHead>
							<TableHead>Execution Time</TableHead>
							<TableHead className="w-10" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{executions.map((exec) => (
							<TableRow key={exec.instanceId}>
								<TableCell>
									<Link
										href={`/dapr-workflows/executions/${encodeURIComponent(exec.instanceId)}`}
										className="font-medium font-mono text-sm text-emerald-600 hover:underline dark:text-emerald-400"
									>
										{exec.instanceId}
									</Link>
								</TableCell>
								<TableCell>
									<Badge
										variant="secondary"
										className={getStatusBadgeClasses(exec.status)}
									>
										{exec.status}
									</Badge>
								</TableCell>
								<TableCell className="text-sm">{exec.workflowName}</TableCell>
								<TableCell className="text-sm text-emerald-600 dark:text-emerald-400">
									{exec.appId}
								</TableCell>
								<TableCell className="text-sm text-muted-foreground">
									{new Date(exec.startTime).toLocaleString()}
								</TableCell>
								<TableCell className="text-sm text-muted-foreground">
									{exec.executionTime ?? "—"}
								</TableCell>
								<TableCell>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button variant="ghost" size="icon" className="size-7">
												<MoreVertical className="size-4" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem asChild>
												<Link href={`/dapr-workflows/executions/${encodeURIComponent(exec.instanceId)}`}>
													View details
												</Link>
											</DropdownMenuItem>
											<DropdownMenuItem
												className="text-red-600 dark:text-red-400"
												disabled={exec.status !== "RUNNING" && exec.status !== "PENDING"}
												onClick={() => handleTerminate(exec.instanceId)}
											>
												<StopCircle className="mr-2 size-4" />
												Terminate
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
			<div className="mt-3 flex justify-end">
				<span className="text-muted-foreground text-xs">
					Total Rows: {totalRows}
				</span>
			</div>
		</>
	);
}
