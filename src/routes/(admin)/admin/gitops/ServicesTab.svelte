<script lang="ts">
	import { LayoutGrid, PanelRight } from "@lucide/svelte";

	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import GitopsFilters, {
		type StatusFilter,
	} from "$lib/components/gitops/GitopsFilters.svelte";
	import InventoryFooter from "$lib/components/gitops/InventoryFooter.svelte";
	import ServiceDetail from "$lib/components/gitops/ServiceDetail.svelte";
	import ServiceTable from "$lib/components/gitops/ServiceTable.svelte";
	import {
		buildFleetServiceDrift,
		summarizeFleetDrift,
	} from "$lib/gitops/fleet-drift-view";
	import {
		buildServiceMatrix,
		summarizeMatrix,
		summarizeRow,
		type EnvName,
		type ServiceRow,
	} from "$lib/gitops/service-matrix";
	import type {
		DeploymentMetadataResponse,
		FleetDriftExtras,
	} from "$lib/types/deployment-metadata";

	import type { GitopsPageLinks } from "$lib/gitops/links";

	import FleetMatrixTable from "./FleetMatrixTable.svelte";

	type Props = {
		metadata: DeploymentMetadataResponse;
		tektonBase: string | null;
		links: GitopsPageLinks;
		now: number;
		/** Fleet-drift extras from `getFleetDriftExtras`; null until resolved. */
		extras?: FleetDriftExtras | null;
		/** True while the extras query has not resolved for the first time. */
		extrasLoading?: boolean;
	};

	let {
		metadata,
		tektonBase,
		links,
		now,
		extras = null,
		extrasLoading = false,
	}: Props = $props();

	let search = $state("");
	let statusFilter = $state<StatusFilter>("all");
	// Matrix (drift columns + lineage) is the default; detail keeps the
	// master/detail deep-dive.
	let view = $state<"matrix" | "detail">("matrix");
	// Ryzen column hidden by default (hub inventory doesn't index ryzen).
	let envsVisible = $state<Record<EnvName, boolean>>({
		ryzen: false,
		dev: true,
		staging: true,
	});

	const rows = $derived(
		buildServiceMatrix({
			inventory: metadata.inventory.data,
			releasePins: metadata.gitops.desiredImages,
			live: metadata.live.deployments,
			currentEnv: metadata.environment.name,
		}),
	);

	const drift = $derived(
		buildFleetServiceDrift(rows, extras, {
			workflowBuilderRepoUrl: links.workflowBuilderRepo,
			now,
		}),
	);
	const driftSummary = $derived(summarizeFleetDrift(drift));
	const driftChips = $derived.by(() => {
		const parts: string[] = [];
		if (driftSummary.buildsInFlight > 0) parts.push(`${driftSummary.buildsInFlight} building`);
		if (driftSummary.behindMain > 0) parts.push(`${driftSummary.behindMain} behind main`);
		if (driftSummary.stalePins > 0) {
			parts.push(`${driftSummary.stalePins} stale pin${driftSummary.stalePins === 1 ? "" : "s"}`);
		}
		return parts.join(" · ");
	});

	function rowMatchesStatus(row: ServiceRow, filter: StatusFilter): boolean {
		if (filter === "all") return true;
		if (filter === "sandbox") return row.specialCase === "sandbox-only";
		const overall = summarizeRow(row).overall;
		if (filter === "healthy") return overall === "healthy" || overall === "empty";
		// "attention"
		return overall === "drift" || overall === "degraded";
	}

	const filteredRows = $derived(
		rows.filter((row) => {
			if (search) {
				const needle = search.toLowerCase();
				if (!row.service.toLowerCase().includes(needle)) return false;
			}
			return rowMatchesStatus(row, statusFilter);
		}),
	);

	// URL-state: ?service=<name>. Falls back to the first row in the filtered
	// list so something is always selected.
	const selectedService = $derived.by(() => {
		const fromUrl = page.url.searchParams.get("service");
		if (fromUrl && filteredRows.some((r) => r.service === fromUrl)) return fromUrl;
		if (fromUrl && rows.some((r) => r.service === fromUrl)) return fromUrl;
		return filteredRows[0]?.service ?? rows[0]?.service ?? null;
	});

	const selectedRow = $derived(
		selectedService ? rows.find((r) => r.service === selectedService) ?? null : null,
	);

	function selectService(service: string) {
		const url = new URL(page.url);
		url.searchParams.set("service", service);
		goto(url.pathname + url.search, {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	function openDetail(service: string) {
		view = "detail";
		selectService(service);
	}

	// Local-only: summary is computed and used inside this component if needed
	// in future polish. The page-level summary is recomputed in +page.svelte.
	void summarizeMatrix; // keep import for future use
</script>

<div class="flex h-full flex-col overflow-hidden">
	<div class="flex flex-wrap items-center gap-3 border-b px-5 py-2">
		<div class="min-w-0 flex-1">
			<GitopsFilters
				{search}
				{statusFilter}
				{envsVisible}
				total={rows.length}
				filtered={filteredRows.length}
				onSearchChange={(v) => (search = v)}
				onStatusFilterChange={(v) => (statusFilter = v)}
				onEnvToggle={(env) => {
					envsVisible = { ...envsVisible, [env]: !envsVisible[env] };
				}}
			/>
		</div>
		<div class="flex items-center gap-2">
			{#if driftChips}
				<span class="hidden text-[0.7rem] text-muted-foreground lg:inline">{driftChips}</span>
			{/if}
			<div
				class="inline-flex items-center gap-0.5 rounded-lg bg-muted p-[3px] text-muted-foreground"
				role="group"
				aria-label="Services layout"
			>
				<button
					type="button"
					aria-pressed={view === "matrix"}
					onclick={() => (view = "matrix")}
					class="inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors {view === 'matrix' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
				>
					<LayoutGrid class="size-3" />
					Matrix
				</button>
				<button
					type="button"
					aria-pressed={view === "detail"}
					onclick={() => (view = "detail")}
					class="inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors {view === 'detail' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
				>
					<PanelRight class="size-3" />
					Detail
				</button>
			</div>
		</div>
	</div>

	{#if view === "matrix"}
		<div class="min-h-0 flex-1 overflow-hidden">
			<FleetMatrixTable
				rows={filteredRows}
				{drift}
				{extrasLoading}
				{envsVisible}
				{links}
				{tektonBase}
				{now}
				onOpenDetail={openDetail}
			/>
		</div>
	{:else}
		<div class="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[20rem_1fr] md:grid-rows-1 md:overflow-hidden lg:grid-cols-[22rem_1fr]">
			<aside class="h-64 overflow-hidden border-b bg-background md:h-auto md:min-h-0 md:border-b-0 md:border-r">
				<ServiceTable
					rows={filteredRows}
					{selectedService}
					onSelect={selectService}
				/>
			</aside>
			<main class="min-h-[20rem] bg-muted/10 md:min-h-0 md:overflow-y-auto">
				{#if selectedRow}
					<ServiceDetail
						row={selectedRow}
						{tektonBase}
						{envsVisible}
						{links}
						desiredImages={metadata.gitops.desiredImages}
						{now}
					/>
				{:else}
					<div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
						{filteredRows.length === 0
							? "No services match the current filter."
							: "Select a service to see its deployment detail."}
					</div>
				{/if}
			</main>
		</div>
	{/if}

	<div class="border-t bg-background px-5 py-2">
		<InventoryFooter inventory={metadata.inventory} generatedAt={metadata.generatedAt} />
	</div>
</div>
