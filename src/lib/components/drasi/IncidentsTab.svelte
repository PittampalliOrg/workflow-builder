<script lang="ts">
	import { onMount } from "svelte";
	import {
		AlertTriangle,
		Inbox as InboxIcon,
		RefreshCw,
		RotateCcw,
	} from "@lucide/svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import * as Table from "$lib/components/ui/table";
	import { listQueryRows } from "$lib/drasi/catalog";
	import { clipId, clipText, shortenId } from "$lib/drasi/format";
	import type { DrasiIncident, DrasiIncidentSeverity } from "$lib/types/drasi";
	import { relativeTime } from "$lib/utils/gitops-display";

	const INCIDENTS_URL = "/api/internal/drasi/incidents?limit=50";
	const MAX_INCIDENTS = 50;

	type LoadState = "loading" | "ok" | "empty" | "unavailable";

	let loadState = $state<LoadState>("loading");
	let incidents = $state<DrasiIncident[]>([]);
	let errorMessage = $state<string | null>(null);

	let severityFilter = $state<"all" | DrasiIncidentSeverity>("all");
	let queryFilter = $state<string>("all");

	const queryOptions = listQueryRows();
	const queryNames = new Map(queryOptions.map((query) => [query.id, query.name]));
	const severities: Array<"all" | DrasiIncidentSeverity> = [
		"all",
		"critical",
		"warning",
		"info",
	];

	/** Defensive normalization — the wire is untrusted even from our own API. */
	function sanitizeIncidents(raw: unknown): DrasiIncident[] {
		if (!Array.isArray(raw)) return [];
		const out: DrasiIncident[] = [];
		for (const item of raw.slice(0, MAX_INCIDENTS)) {
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			const id = clipId(record.id);
			const correlationId = clipId(record.correlationId);
			if (!id || !correlationId) continue;
			const severityRaw = clipText(record.severity, 16);
			const severity: DrasiIncidentSeverity =
				severityRaw === "critical" || severityRaw === "warning" ? severityRaw : "info";
			const evidenceRaw = Array.isArray(record.evidence) ? record.evidence : [];
			out.push({
				id,
				correlationId,
				queryId: clipId(record.queryId, 120),
				severity,
				title: clipText(record.title, 140) || "Incident",
				occurredAt: clipText(record.occurredAt, 40),
				workflowExecutionId: clipId(record.workflowExecutionId) || null,
				sessionId: clipId(record.sessionId) || null,
				evidence: evidenceRaw
					.slice(0, 3)
					.map((entry) => clipText(entry, 160))
					.filter(Boolean),
			});
		}
		return out;
	}

	async function loadIncidents() {
		loadState = "loading";
		errorMessage = null;
		try {
			const res = await fetch(INCIDENTS_URL, { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
			const body: unknown = await res.json();
			const list =
				body && typeof body === "object"
					? (body as { incidents?: unknown }).incidents
					: undefined;
			incidents = sanitizeIncidents(list);
			loadState = incidents.length > 0 ? "ok" : "empty";
		} catch (err) {
			incidents = [];
			errorMessage = err instanceof Error ? err.message : String(err);
			loadState = "unavailable";
		}
	}

	let filtered = $derived(
		incidents.filter(
			(incident) =>
				(severityFilter === "all" || incident.severity === severityFilter) &&
				(queryFilter === "all" || incident.queryId === queryFilter),
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

	onMount(() => {
		void loadIncidents();
	});
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
		<div
			class="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground"
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
			Query
			<select
				bind:value={queryFilter}
				aria-label="Filter by continuous query"
				class="h-7 max-w-[220px] rounded-md border border-input bg-background px-1.5 text-[0.7rem] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<option value="all">All queries</option>
				{#each queryOptions as query (query.id)}
					<option value={query.id}>{query.name}</option>
				{/each}
			</select>
		</label>
		<div class="ml-auto flex items-center gap-2">
			{#if loadState === "ok"}
				<span class="text-[0.7rem] text-muted-foreground">
					{filtered.length} of {incidents.length} shown
				</span>
			{/if}
			<Button
				variant="outline"
				size="sm"
				class="h-7"
				onclick={() => void loadIncidents()}
				disabled={loadState === "loading"}
			>
				{#if loadState === "loading"}
					<RefreshCw class="size-3.5 motion-safe:animate-spin" />
				{:else}
					<RefreshCw class="size-3.5" />
				{/if}
				Refresh
			</Button>
		</div>
	</div>

	{#if loadState === "loading"}
		<div class="space-y-2 p-5" aria-busy="true" aria-label="Loading incidents">
			{#each Array.from({ length: 5 }, (_, i) => i) as row (row)}
				<Skeleton class="h-9 w-full" />
			{/each}
		</div>
	{:else if loadState === "unavailable"}
		<div
			class="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center"
			role="alert"
		>
			<AlertTriangle class="size-5 text-destructive" />
			<div class="space-y-1">
				<p class="text-sm font-medium">Incident feed unavailable</p>
				<p class="max-w-md text-xs leading-relaxed text-muted-foreground">
					The reaction forwards added results to
					<span class="font-mono text-[0.7rem]">POST /api/internal/drasi/incidents/ingest</span>;
					the incident read API did not respond{#if errorMessage}
						(<span class="font-mono text-[0.7rem]">{clipText(errorMessage, 80)}</span>){/if}.
					This is an honest degraded state — no incidents are synthesized.
				</p>
			</div>
			<Button variant="outline" size="sm" class="h-7 gap-1.5" onclick={() => void loadIncidents()}>
				<RefreshCw class="size-3" />
				Retry
			</Button>
		</div>
	{:else if loadState === "empty"}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
			<InboxIcon class="size-5 text-muted-foreground" />
			<div class="space-y-1">
				<p class="text-sm font-medium">No incidents ingested</p>
				<p class="max-w-md text-xs leading-relaxed text-muted-foreground">
					When a continuous query produces added results, the reaction posts them to
					Workflow Builder, which validates, correlates, deduplicates, and starts
					<span class="font-mono text-[0.7rem]">platform-incident-analysis</span> with a
					read-only incident analyst. Nothing has been ingested yet.
				</p>
			</div>
		</div>
	{:else}
		<div class="min-h-0 flex-1 overflow-auto">
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
								{queryNames.get(incident.queryId) ?? incident.queryId}
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
		<p class="border-t px-5 py-2 text-[0.7rem] leading-relaxed text-muted-foreground">
			A completed analysis does not prove the underlying condition resolved — verify the
			linked execution and the current observation before closing an incident.
		</p>
	{/if}
</div>
