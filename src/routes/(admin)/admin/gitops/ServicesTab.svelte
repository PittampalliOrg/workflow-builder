<script lang="ts">
	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import GitopsFilters, {
		type StatusFilter,
	} from "$lib/components/gitops/GitopsFilters.svelte";
	import InventoryFooter from "$lib/components/gitops/InventoryFooter.svelte";
	import ServiceDetail from "$lib/components/gitops/ServiceDetail.svelte";
	import ServiceTable from "$lib/components/gitops/ServiceTable.svelte";
	import {
		buildServiceMatrix,
		summarizeMatrix,
		summarizeRow,
		type EnvName,
		type ServiceRow,
	} from "$lib/gitops/service-matrix";
	import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";

	import type { GitopsPageLinks } from "./+page.server";

	type Props = {
		metadata: DeploymentMetadataResponse;
		tektonBase: string | null;
		links: GitopsPageLinks;
		now: number;
	};

	let { metadata, tektonBase, links, now }: Props = $props();

	let search = $state("");
	let statusFilter = $state<StatusFilter>("all");
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

	// Local-only: summary is computed and used inside this component if needed
	// in future polish. The page-level summary is recomputed in +page.svelte.
	void summarizeMatrix; // keep import for future use
</script>

<div class="flex h-full flex-col overflow-hidden">
	<div class="border-b px-5 py-2">
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

	<div class="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[20rem_1fr] lg:grid-cols-[22rem_1fr]">
		<aside class="border-r bg-background md:border-b-0">
			<ServiceTable
				rows={filteredRows}
				{selectedService}
				onSelect={selectService}
			/>
		</aside>
		<main class="overflow-y-auto bg-muted/10">
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

	<div class="border-t bg-background px-5 py-2">
		<InventoryFooter inventory={metadata.inventory} generatedAt={metadata.generatedAt} />
	</div>
</div>
