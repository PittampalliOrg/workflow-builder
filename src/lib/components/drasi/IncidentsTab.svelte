<script lang="ts">
	import { onMount } from "svelte";
	import {
		AlertTriangle,
		Inbox as InboxIcon,
		LoaderCircle,
		RefreshCw,
		RotateCcw,
	} from "@lucide/svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import * as Table from "$lib/components/ui/table";
	import { drasiQueryName, listQueryRows, resolveDrasiQueryId } from "$lib/drasi/catalog";
	import { shortenId } from "$lib/drasi/format";
	import type {
		DrasiIncident,
		DrasiIncidentsResponse,
		DrasiIncidentSeverity,
	} from "$lib/types/drasi";
	import { relativeTime } from "$lib/utils/gitops-display";

	type LoadState = "loading" | "ok" | "empty" | "error";

	const REFRESH_INTERVAL_MS = 30_000;

	let loadState = $state<LoadState>("loading");
	let incidents = $state<DrasiIncident[]>([]);
	let truncated = $state(false);
	let refreshing = $state(false);
	let loadError = $state("");
	let refreshError = $state("");
	let requestController: AbortController | null = null;

	let severityFilter = $state<"all" | DrasiIncidentSeverity>("all");
	let queryFilter = $state<string>("all");

	const queryOptions = listQueryRows();
	// Incidents may carry either the physical Drasi query id (`…-vN`) or the
	// logical id persisted by ingest. `drasiQueryName` resolves both forms to
	// the configured friendly name; `resolveDrasiQueryId` canonicalizes for
	// filtering against the physical ids in the query select below.
	const severities: Array<"all" | DrasiIncidentSeverity> = [
		"all",
		"critical",
		"warning",
		"info",
	];

	let filtered = $derived(
		incidents.filter(
			(incident) =>
				(severityFilter === "all" || incident.severity === severityFilter) &&
				(queryFilter === "all" || resolveDrasiQueryId(incident.queryId) === queryFilter),
		),
	);

	let hasFilters = $derived(severityFilter !== "all" || queryFilter !== "all");

	function resetFilters() {
		severityFilter = "all";
		queryFilter = "all";
	}

	function severityBadgeClass(severity: DrasiIncidentSeverity): string {
		if (severity === "critical") return "";
		if (severity === "warning")
			return "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200";
		return "text-muted-foreground";
	}

	function isIncidentResponse(value: unknown): value is DrasiIncidentsResponse {
		return Boolean(
			value &&
				typeof value === "object" &&
				Array.isArray((value as DrasiIncidentsResponse).incidents) &&
				typeof (value as DrasiIncidentsResponse).truncated === "boolean",
		);
	}

	async function refreshIncidents(initial = false) {
		requestController?.abort();
		requestController = new AbortController();
		const controller = requestController;

		if (initial) {
			loadState = "loading";
			loadError = "";
		} else {
			refreshing = true;
			refreshError = "";
		}

		try {
			const response = await fetch("/api/admin/drasi/incidents?limit=100", {
				cache: "no-store",
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(
					response.status === 403
						? "Admin access is required to read the incident feed."
						: `Incident feed request failed (${response.status}).`,
				);
			}

			const payload: unknown = await response.json();
			if (!isIncidentResponse(payload)) {
				throw new Error("Incident feed returned an invalid response.");
			}

			incidents = payload.incidents;
			truncated = payload.truncated;
			loadState = incidents.length > 0 ? "ok" : "empty";
		} catch (error) {
			if (controller.signal.aborted) return;
			const message = error instanceof Error ? error.message : "Incident feed is unavailable.";
			if (initial || incidents.length === 0) {
				loadError = message;
				loadState = "error";
			} else {
				refreshError = message;
			}
		} finally {
			if (requestController === controller) {
				requestController = null;
				refreshing = false;
			}
		}
	}

	onMount(() => {
		void refreshIncidents(true);
		const refreshTimer = window.setInterval(() => void refreshIncidents(), REFRESH_INTERVAL_MS);
		return () => {
			window.clearInterval(refreshTimer);
			requestController?.abort();
		};
	});
</script>

<div class="flex min-h-0 min-w-0 max-w-full flex-1 flex-col">
	<div
		class="flex min-w-0 max-w-full flex-wrap items-center gap-2 border-b px-5 py-2.5 @max-md:flex-col @max-md:items-stretch @max-md:px-3"
	>
		<!-- Narrow containers: the four-button severity segment cannot fit, so
			substitute a compact native select with the same semantics. -->
		<label
			class="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground @md:hidden"
		>
			<span class="shrink-0">Severity</span>
			<select
				bind:value={severityFilter}
				aria-label="Filter by severity"
				class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-[0.7rem] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				{#each severities as severity (severity)}
					<option value={severity}>
						{severity === "all" ? "All severities" : severity}
					</option>
				{/each}
			</select>
		</label>
		<div
			class="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground @max-md:hidden"
			role="group"
			aria-label="Filter by severity"
		>
			{#each severities as severity (severity)}
				<button
					type="button"
					aria-pressed={severityFilter === severity}
					onclick={() => (severityFilter = severity)}
					class="inline-flex h-6 items-center rounded-md px-2 text-[0.7rem] font-medium capitalize transition-colors {severityFilter ===
					severity
						? 'bg-background text-foreground shadow-sm'
						: 'hover:text-foreground'}"
				>
					{severity === "all" ? "All severities" : severity}
				</button>
			{/each}
		</div>
		<label class="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
			<span class="shrink-0">Query</span>
			<select
				bind:value={queryFilter}
				aria-label="Filter by continuous query"
				class="h-7 min-w-0 max-w-[220px] rounded-md border border-input bg-background px-1.5 text-[0.7rem] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @max-md:h-8 @max-md:max-w-none @max-md:flex-1"
			>
				<option value="all">All queries</option>
				{#each queryOptions as query (query.id)}
					<option value={query.id}>{query.name}</option>
				{/each}
			</select>
		</label>
		<div class="ml-auto flex min-w-0 max-w-full items-center gap-2 @max-md:ml-0">
			{#if loadState === "ok"}
				<span class="text-[0.7rem] text-muted-foreground">
					{filtered.length} of {incidents.length} shown
				</span>
			{/if}
			{#if refreshError}
				<span class="text-[0.7rem] text-destructive" title={refreshError}>Refresh failed</span>
			{/if}
			<Button
				variant="ghost"
				size="icon"
				class="size-7 shrink-0"
				aria-label="Refresh incident feed"
				title="Refresh incident feed"
				disabled={refreshing || loadState === "loading"}
				onclick={() => void refreshIncidents()}
			>
				<RefreshCw class="size-3.5 {refreshing ? 'animate-spin' : ''}" />
			</Button>
		</div>
	</div>

	{#if loadState === "loading"}
		<div
			class="flex min-w-0 max-w-full flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center @max-md:px-4 @max-md:py-10"
			role="status"
		>
			<LoaderCircle class="size-5 shrink-0 animate-spin text-muted-foreground" />
			<p class="text-sm font-medium">Loading incident feed</p>
		</div>
	{:else if loadState === "error"}
		<div
			class="flex min-w-0 max-w-full flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center @max-md:px-4 @max-md:py-10"
			role="alert"
		>
			<AlertTriangle class="size-5 shrink-0 text-destructive" />
			<div class="min-w-0 max-w-full space-y-1">
				<p class="text-sm font-medium">Incident feed unavailable</p>
				<p class="max-w-md text-xs leading-relaxed text-muted-foreground">
					{loadError}
				</p>
			</div>
			<Button
				variant="outline"
				size="sm"
				class="h-7 gap-1.5"
				onclick={() => void refreshIncidents(true)}
			>
				<RefreshCw class="size-3" />
				Retry
			</Button>
		</div>
	{:else if loadState === "empty"}
		<div
			class="flex min-w-0 max-w-full flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center @max-md:px-4 @max-md:py-10"
		>
			<InboxIcon class="size-5 shrink-0 text-muted-foreground" />
			<div class="min-w-0 max-w-full space-y-1">
				<p class="text-sm font-medium">No incidents ingested</p>
				<p class="max-w-md text-xs leading-relaxed text-muted-foreground">
					When a continuous query produces added results, the Drasi reaction sends them
					through the incident trigger path for validation, correlation, deduplication,
					and analysis.
				</p>
			</div>
		</div>
	{:else}
		{#if truncated}
			<div class="border-b bg-muted/30 px-5 py-1.5 text-[0.7rem] text-muted-foreground">
				Showing the newest 100 incidents.
			</div>
		{/if}
		<!-- Dense table for comfortable widths. -->
		<div class="min-h-0 flex-1 overflow-auto @max-md:hidden">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-5">Severity</Table.Head>
						<Table.Head>Incident</Table.Head>
						<Table.Head>Query</Table.Head>
						<Table.Head>Correlation ID</Table.Head>
						<Table.Head>Time</Table.Head>
						<Table.Head class="pr-5">Linked work</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each filtered as incident (incident.id)}
						<Table.Row>
							<Table.Cell class="pl-5">
								<Badge
									variant={incident.severity === "critical" ? "destructive" : "outline"}
									class="h-5 px-1.5 text-[0.65rem] capitalize {severityBadgeClass(
										incident.severity,
									)}"
								>
									{incident.severity}
								</Badge>
							</Table.Cell>
							<Table.Cell class="max-w-[280px]">
								<span class="block truncate text-xs font-medium" title={incident.title}>
									{incident.title}
								</span>
								{#if incident.evidence.length > 0}
									<span
										class="block truncate text-[0.7rem] text-muted-foreground"
										title={incident.evidence.join(" · ")}
									>
										{incident.evidence[0]}
									</span>
								{/if}
							</Table.Cell>
							<Table.Cell
								class="text-xs"
								title={incident.queryId}
							>
								{drasiQueryName(incident.queryId) ?? incident.queryId}
							</Table.Cell>
							<Table.Cell
								class="font-mono text-[0.7rem] text-muted-foreground"
								title={incident.correlationId}
							>
								{shortenId(incident.correlationId)}
							</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground">
								{relativeTime(incident.occurredAt)}
							</Table.Cell>
							<Table.Cell class="pr-5">
								<div class="flex flex-wrap gap-1">
									{#if incident.workflowExecutionId}
										<Badge
											variant="outline"
											class="h-5 px-1.5 font-mono text-[0.65rem]"
											title="Workflow execution {incident.workflowExecutionId}"
										>
											exec {shortenId(incident.workflowExecutionId)}
										</Badge>
									{/if}
									{#if incident.sessionId}
										<Badge
											variant="outline"
											class="h-5 px-1.5 font-mono text-[0.65rem]"
											title="Session {incident.sessionId}"
										>
											session {shortenId(incident.sessionId)}
										</Badge>
									{/if}
									{#if !incident.workflowExecutionId && !incident.sessionId}
										<span class="text-xs text-muted-foreground">—</span>
									{/if}
								</div>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row>
							<Table.Cell colspan={6} class="h-32 text-center">
								<div class="flex flex-col items-center justify-center gap-2">
									<p class="text-sm text-muted-foreground">
										No incidents match the current filters.
									</p>
									{#if hasFilters}
										<Button
											variant="outline"
											size="sm"
											class="h-7 gap-1.5"
											onclick={resetFilters}
										>
											<RotateCcw class="size-3" />
											Reset filters
										</Button>
									{/if}
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
		<!-- Narrow containers: stacked cards keep every identifier inspectable
			without pushing content past an overflow boundary. -->
		<div class="min-h-0 flex-1 overflow-auto @md:hidden">
			{#if filtered.length === 0}
				<div
					class="flex h-full flex-col items-center justify-center gap-2 px-4 py-10 text-center"
				>
					<p class="text-sm text-muted-foreground">
						No incidents match the current filters.
					</p>
					{#if hasFilters}
						<Button variant="outline" size="sm" class="h-7 gap-1.5" onclick={resetFilters}>
							<RotateCcw class="size-3" />
							Reset filters
						</Button>
					{/if}
				</div>
			{:else}
				<ul class="divide-y">
					{#each filtered as incident (incident.id)}
						<li class="flex flex-col gap-2 px-4 py-3">
							<div class="flex items-start justify-between gap-2">
								<div class="min-w-0">
									<p class="break-words text-xs font-medium" title={incident.title}>
										{incident.title}
									</p>
									{#if incident.evidence.length > 0}
										<p
											class="break-words text-[0.7rem] text-muted-foreground"
											title={incident.evidence.join(" · ")}
										>
											{incident.evidence[0]}
										</p>
									{/if}
								</div>
								<Badge
									variant={incident.severity === "critical" ? "destructive" : "outline"}
									class="h-5 shrink-0 px-1.5 text-[0.65rem] capitalize {severityBadgeClass(
										incident.severity,
									)}"
								>
									{incident.severity}
								</Badge>
							</div>
							<dl class="space-y-1 text-[0.7rem]">
								<div class="flex items-start justify-between gap-3">
									<dt class="shrink-0 text-muted-foreground">Query</dt>
									<dd class="break-words text-right" title={incident.queryId}>
										{drasiQueryName(incident.queryId) ?? incident.queryId}
									</dd>
								</div>
								<div class="flex items-start justify-between gap-3">
									<dt class="shrink-0 text-muted-foreground">Correlation ID</dt>
									<dd
										class="break-all text-right font-mono text-[0.65rem] text-muted-foreground"
										title={incident.correlationId}
									>
										{shortenId(incident.correlationId)}
									</dd>
								</div>
								<div class="flex items-center justify-between gap-3">
									<dt class="text-muted-foreground">Time</dt>
									<dd class="text-muted-foreground">
										{relativeTime(incident.occurredAt)}
									</dd>
								</div>
							</dl>
							{#if incident.workflowExecutionId || incident.sessionId}
								<div class="flex flex-wrap gap-1">
									{#if incident.workflowExecutionId}
										<Badge
											variant="outline"
											class="h-auto min-h-5 max-w-full break-all px-1.5 py-0.5 font-mono text-[0.65rem]"
											title="Workflow execution {incident.workflowExecutionId}"
										>
											exec {shortenId(incident.workflowExecutionId)}
										</Badge>
									{/if}
									{#if incident.sessionId}
										<Badge
											variant="outline"
											class="h-auto min-h-5 max-w-full break-all px-1.5 py-0.5 font-mono text-[0.65rem]"
											title="Session {incident.sessionId}"
										>
											session {shortenId(incident.sessionId)}
										</Badge>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
		<p
			class="border-t px-5 py-2 text-[0.7rem] leading-relaxed text-muted-foreground @max-md:px-3"
		>
			A completed analysis does not prove the underlying condition resolved — verify the
			linked execution and the current observation before closing an incident.
		</p>
	{/if}
</div>
