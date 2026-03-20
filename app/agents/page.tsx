"use client";

import { format } from "date-fns";
import {
	ArrowDown,
	ArrowUp,
	Bot,
	ChevronDown,
	Filter,
	Workflow,
	X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import type {
	AgentType,
	DiscoveredAgent,
	DiscoveredAgentsResponse,
} from "@/lib/types/discovered-agent";

type SortKey = "name" | "role" | "type" | "appId" | "registered";
type SortDir = "asc" | "desc";

function formatTimestamp(iso: string | null): string {
	if (!iso) return "-";
	try {
		return format(new Date(iso), "dd MMM yyyy h:mm:ss a");
	} catch {
		return iso;
	}
}

function TypeIcon({ type }: { type: AgentType }) {
	if (type === "Durable agent") {
		return <Workflow className="size-4 text-muted-foreground" />;
	}
	return <Bot className="size-4 text-muted-foreground" />;
}

export default function AgentsPage() {
	const [data, setData] = useState<DiscoveredAgentsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [search, setSearch] = useState("");
	const [filterAppId, setFilterAppId] = useState("");
	const [filterType, setFilterType] = useState("");
	const [pendingAppId, setPendingAppId] = useState("");
	const [pendingType, setPendingType] = useState("");
	const [filtersOpen, setFiltersOpen] = useState(false);
	const [sortKey, setSortKey] = useState<SortKey>("name");
	const [sortDir, setSortDir] = useState<SortDir>("asc");
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const fetchAgents = useCallback(async () => {
		try {
			const result = await api.discoveredAgent.list({
				search: search || undefined,
				appId: filterAppId || undefined,
				type: filterType || undefined,
			});
			setData(result);
		} catch (error) {
			console.error("Failed to fetch discovered agents:", error);
			toast.error("Failed to load agents");
		} finally {
			setLoading(false);
		}
	}, [search, filterAppId, filterType]);

	useEffect(() => {
		setLoading(true);
		fetchAgents();
	}, [fetchAgents]);

	// Auto-refresh every 30s
	useEffect(() => {
		intervalRef.current = setInterval(fetchAgents, 30_000);
		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current);
		};
	}, [fetchAgents]);

	const handleSort = (key: SortKey) => {
		if (sortKey === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortKey(key);
			setSortDir("asc");
		}
	};

	const sortedAgents = useMemo(() => {
		if (!data?.agents) return [];
		const agents = [...data.agents];
		agents.sort((a, b) => {
			let aVal: string | null = null;
			let bVal: string | null = null;
			switch (sortKey) {
				case "name":
					aVal = a.name;
					bVal = b.name;
					break;
				case "role":
					aVal = a.role;
					bVal = b.role;
					break;
				case "type":
					aVal = a.type;
					bVal = b.type;
					break;
				case "appId":
					aVal = a.appId;
					bVal = b.appId;
					break;
				case "registered":
					aVal = a.registered;
					bVal = b.registered;
					break;
			}
			const cmp = (aVal ?? "").localeCompare(bVal ?? "");
			return sortDir === "asc" ? cmp : -cmp;
		});
		return agents;
	}, [data?.agents, sortKey, sortDir]);

	const activeFilterCount = (filterAppId ? 1 : 0) + (filterType ? 1 : 0);

	const applyFilters = () => {
		setFilterAppId(pendingAppId);
		setFilterType(pendingType);
		setFiltersOpen(false);
	};

	const clearFilters = () => {
		setPendingAppId("");
		setPendingType("");
		setFilterAppId("");
		setFilterType("");
		setFiltersOpen(false);
	};

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
				<h1 className="font-semibold text-2xl">Agents</h1>
			</div>

			{/* Search + Filters */}
			<div className="mb-4 flex items-center gap-3">
				<div className="relative flex-1">
					<Input
						placeholder="Search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>

				<Popover
					open={filtersOpen}
					onOpenChange={(open) => {
						setFiltersOpen(open);
						if (open) {
							setPendingAppId(filterAppId);
							setPendingType(filterType);
						}
					}}
				>
					<PopoverTrigger asChild>
						<Button variant="outline" className="gap-2">
							<Filter className="size-4" />
							Filters
							{activeFilterCount > 0 && (
								<Badge
									variant="secondary"
									className="ml-1 h-5 min-w-5 px-1 text-xs"
								>
									{activeFilterCount}
								</Badge>
							)}
						</Button>
					</PopoverTrigger>
					<PopoverContent className="w-80" align="end">
						<div className="space-y-4">
							<div>
								<label className="mb-1.5 block text-sm font-medium">
									App IDs
								</label>
								<select
									className="w-full rounded-md border bg-background px-3 py-2 text-sm"
									value={pendingAppId}
									onChange={(e) => setPendingAppId(e.target.value)}
								>
									<option value="">All</option>
									{data?.appIds.map((id) => (
										<option key={id} value={id}>
											{id}
										</option>
									))}
								</select>
							</div>
							<div>
								<label className="mb-1.5 block text-sm font-medium">Type</label>
								<select
									className="w-full rounded-md border bg-background px-3 py-2 text-sm"
									value={pendingType}
									onChange={(e) => setPendingType(e.target.value)}
								>
									<option value="">All</option>
									<option value="Agent">Agent</option>
									<option value="Durable agent">Durable agent</option>
								</select>
							</div>
							<div className="flex items-center justify-between pt-2">
								<Button variant="ghost" size="sm" onClick={clearFilters}>
									Clear all
								</Button>
								<div className="flex gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={() => setFiltersOpen(false)}
									>
										Cancel
									</Button>
									<Button size="sm" onClick={applyFilters}>
										Apply
									</Button>
								</div>
							</div>
						</div>
					</PopoverContent>
				</Popover>

				{activeFilterCount > 0 && (
					<Button
						variant="ghost"
						size="sm"
						onClick={clearFilters}
						className="gap-1 text-muted-foreground"
					>
						<X className="size-3" />
						Clear filters
					</Button>
				)}
			</div>

			{/* Data Grid */}
			{loading ? (
				<div className="rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Type</TableHead>
								<TableHead>App ID</TableHead>
								<TableHead>Registered</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{Array.from({ length: 5 }).map((_, i) => (
								<TableRow key={i}>
									<TableCell>
										<Skeleton className="h-4 w-32" />
									</TableCell>
									<TableCell>
										<Skeleton className="h-4 w-40" />
									</TableCell>
									<TableCell>
										<Skeleton className="h-4 w-24" />
									</TableCell>
									<TableCell>
										<Skeleton className="h-4 w-28" />
									</TableCell>
									<TableCell>
										<Skeleton className="h-4 w-36" />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			) : sortedAgents.length === 0 ? (
				<div className="py-16 text-center">
					<Bot className="mx-auto mb-4 size-12 text-muted-foreground/50" />
					<p className="text-muted-foreground text-sm">
						No agents discovered from the Dapr runtime.
					</p>
					<p className="mt-1 text-muted-foreground/70 text-xs">
						Agents register themselves via the AgentRegistry when their services
						start.
					</p>
				</div>
			) : (
				<div className="rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								{(
									[
										["name", "Name"],
										["role", "Role"],
										["type", "Type"],
										["appId", "App ID"],
										["registered", "Registered"],
									] as const
								).map(([col, label]) => (
									<TableHead
										key={col}
										className="cursor-pointer select-none"
										onClick={() => handleSort(col)}
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
							{sortedAgents.map((agent) => (
								<TableRow key={agent.id}>
									<TableCell>
										<Link
											href={`/agents/${encodeURIComponent(agent.appId)}/${encodeURIComponent(agent.name)}`}
											className="font-medium text-emerald-600 hover:underline dark:text-emerald-400"
										>
											{agent.name}
										</Link>
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{agent.role ?? "-"}
									</TableCell>
									<TableCell>
										<div className="flex items-center gap-2 text-sm">
											<TypeIcon type={agent.type} />({agent.type})
										</div>
									</TableCell>
									<TableCell>
										<Link
											href="/dapr"
											className="text-sm text-emerald-600 hover:underline dark:text-emerald-400"
										>
											{agent.appId}
										</Link>
									</TableCell>
									<TableCell className="text-muted-foreground text-sm">
										{formatTimestamp(agent.registered)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}

			{/* Footer */}
			{!loading && (
				<div className="mt-3 flex justify-end">
					<span className="text-muted-foreground text-xs">
						Total Rows: {data?.totalRows ?? 0}
					</span>
				</div>
			)}
		</div>
	);
}
