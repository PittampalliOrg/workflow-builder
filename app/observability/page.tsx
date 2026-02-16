"use client";

import { Eye, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TracesTable } from "@/components/observability/traces-table";
import { TracesTools } from "@/components/observability/traces-tools";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { useObservabilityEntities } from "@/hooks/use-observability-entities";
import { useObservabilityTraces } from "@/hooks/use-observability-traces";
import type { ObservabilityTraceFilters } from "@/lib/types/observability";

function toIso(value: string): string | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return undefined;
	}
	return parsed.toISOString();
}

function toDateTimeInput(value: string | null): string {
	if (!value) {
		return "";
	}

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return "";
	}

	const year = parsed.getFullYear();
	const month = `${parsed.getMonth() + 1}`.padStart(2, "0");
	const day = `${parsed.getDate()}`.padStart(2, "0");
	const hours = `${parsed.getHours()}`.padStart(2, "0");
	const minutes = `${parsed.getMinutes()}`.padStart(2, "0");
	return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export default function ObservabilityPage() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const [selectedEntityId, setSelectedEntityId] = useState(
		() => searchParams.get("entityId") ?? "all",
	);
	const [search, setSearch] = useState(() => searchParams.get("search") ?? "");
	const [from, setFrom] = useState(() =>
		toDateTimeInput(searchParams.get("from")),
	);
	const [to, setTo] = useState(() => toDateTimeInput(searchParams.get("to")));

	const {
		entities,
		isLoading: isEntitiesLoading,
		isError: isEntitiesError,
		error: entitiesError,
	} = useObservabilityEntities();

	const filters = useMemo<ObservabilityTraceFilters>(
		() => ({
			entityType: selectedEntityId !== "all" ? "workflow" : undefined,
			entityId: selectedEntityId !== "all" ? selectedEntityId : undefined,
			search: search.trim() || undefined,
			from: toIso(from),
			to: toIso(to),
			limit: 25,
		}),
		[from, search, selectedEntityId, to],
	);

	const {
		traces,
		hasNextPage,
		isLoading,
		isLoadingMore,
		isError,
		error,
		refresh,
		loadMore,
	} = useObservabilityTraces({ filters });

	const handleReset = () => {
		setSelectedEntityId("all");
		setSearch("");
		setFrom("");
		setTo("");
		router.replace("/observability");
	};

	useEffect(() => {
		const params = new URLSearchParams();
		if (selectedEntityId !== "all") {
			params.set("entityId", selectedEntityId);
		}
		if (search.trim()) {
			params.set("search", search.trim());
		}
		const fromIso = toIso(from);
		if (fromIso) {
			params.set("from", fromIso);
		}
		const toIsoValue = toIso(to);
		if (toIsoValue) {
			params.set("to", toIsoValue);
		}

		const query = params.toString();
		const nextUrl = query ? `/observability?${query}` : "/observability";
		const currentQuery = searchParams.toString();
		const currentUrl = currentQuery
			? `/observability?${currentQuery}`
			: "/observability";

		if (nextUrl !== currentUrl) {
			router.replace(nextUrl, { scroll: false });
		}
	}, [from, router, search, searchParams, selectedEntityId, to]);

	return (
		<div className="container mx-auto space-y-6 py-6">
			<div className="space-y-2">
				<div className="flex items-center gap-3">
					<SidebarToggle />
					<h1 className="flex items-center gap-2 font-bold text-3xl">
						<Eye className="h-7 w-7" />
						Observability
					</h1>
				</div>
				<p className="text-muted-foreground">
					Explore OpenTelemetry traces correlated to Dapr workflow executions.
				</p>
			</div>

			<TracesTools
				entities={entities}
				from={from}
				isLoading={isLoading || isLoadingMore}
				onEntityIdChange={setSelectedEntityId}
				onFromChange={setFrom}
				onRefresh={refresh}
				onReset={handleReset}
				onSearchChange={setSearch}
				onToChange={setTo}
				search={search}
				selectedEntityId={selectedEntityId}
				to={to}
			/>

			{isEntitiesError && (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
					Failed to load workflows for filters:{" "}
					{entitiesError instanceof Error
						? entitiesError.message
						: "Unknown error"}
				</div>
			)}

			{isError && (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
					Failed to load traces:{" "}
					{error instanceof Error ? error.message : "Unknown error"}
				</div>
			)}

			<TracesTable traces={traces} isLoading={isLoading || isEntitiesLoading} />

			{hasNextPage && (
				<div className="flex justify-center">
					<Button disabled={isLoadingMore} onClick={loadMore} variant="outline">
						{isLoadingMore ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								Loading more...
							</>
						) : (
							"Load more"
						)}
					</Button>
				</div>
			)}
		</div>
	);
}
