<script lang="ts">
	import { ArrowUpRight, RotateCcw, Search } from "@lucide/svelte";
	import { Button } from "$lib/components/ui/button";
	import { Input } from "$lib/components/ui/input";
	import * as Table from "$lib/components/ui/table";
	import { listQueryRows } from "$lib/drasi/catalog";
	import ObservedChip from "./ObservedChip.svelte";

	let { onInspect }: { onInspect: (nodeId: string) => void } = $props();

	const queries = listQueryRows();
	const sources = [...new Set(queries.map((query) => query.sourceId))];

	let search = $state("");
	let sourceFilter = $state<string>("all");

	let filtered = $derived.by(() => {
		const needle = search.trim().toLowerCase();
		return queries.filter((query) => {
			if (sourceFilter !== "all" && query.sourceId !== sourceFilter) return false;
			if (!needle) return true;
			return (
				query.name.toLowerCase().includes(needle) ||
				query.id.toLowerCase().includes(needle) ||
				query.condition.toLowerCase().includes(needle)
			);
		});
	});

	let hasFilters = $derived(search.trim() !== "" || sourceFilter !== "all");

	function resetFilters() {
		search = "";
		sourceFilter = "all";
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
		<div class="relative min-w-[180px] flex-1 sm:max-w-xs">
			<Search
				class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				type="search"
				bind:value={search}
				placeholder="Search name, id, or condition…"
				aria-label="Search continuous queries"
				class="h-8 pl-8 text-xs"
			/>
		</div>
		<div
			class="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground"
			role="group"
			aria-label="Filter by source"
		>
			<button
				type="button"
				aria-pressed={sourceFilter === "all"}
				onclick={() => (sourceFilter = "all")}
				class="inline-flex h-6 items-center rounded-md px-2 text-[0.7rem] font-medium transition-colors {sourceFilter ===
				'all'
					? 'bg-background text-foreground shadow-sm'
					: 'hover:text-foreground'}"
			>
				All sources
			</button>
			{#each sources as source (source)}
				<button
					type="button"
					aria-pressed={sourceFilter === source}
					onclick={() => (sourceFilter = source)}
					class="inline-flex h-6 items-center rounded-md px-2 font-mono text-[0.65rem] font-medium transition-colors {sourceFilter ===
					source
						? 'bg-background text-foreground shadow-sm'
						: 'hover:text-foreground'}"
				>
					{source}
				</button>
			{/each}
		</div>
		<span class="ml-auto text-[0.7rem] text-muted-foreground">
			{filtered.length} of {queries.length} configured
		</span>
	</div>

	<div class="min-h-0 flex-1 overflow-auto">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="pl-5">Name</Table.Head>
					<Table.Head>Physical ID</Table.Head>
					<Table.Head>Source</Table.Head>
					<Table.Head>Temporal condition</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head>Incidents</Table.Head>
					<Table.Head>Last activity</Table.Head>
					<Table.Head class="pr-5"><span class="sr-only">Actions</span></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each filtered as query (query.id)}
					<Table.Row>
						<Table.Cell class="pl-5 font-medium">{query.name}</Table.Cell>
						<Table.Cell class="font-mono text-[0.7rem] text-muted-foreground">
							{query.id}
						</Table.Cell>
						<Table.Cell class="font-mono text-[0.7rem] text-muted-foreground">
							{query.sourceLabel}
						</Table.Cell>
						<Table.Cell class="text-xs">{query.condition}</Table.Cell>
						<Table.Cell><ObservedChip status="unavailable" /></Table.Cell>
						<Table.Cell class="text-xs text-muted-foreground">Unavailable</Table.Cell>
						<Table.Cell class="text-xs text-muted-foreground">Unavailable</Table.Cell>
						<Table.Cell class="pr-5 text-right">
							<Button
								variant="ghost"
								size="sm"
								class="h-7 gap-1 px-2 text-xs"
								onclick={() => onInspect(query.id)}
								aria-label="Inspect {query.name}"
							>
								Inspect
								<ArrowUpRight class="size-3" />
							</Button>
						</Table.Cell>
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={8} class="h-32 text-center">
							<div class="flex flex-col items-center justify-center gap-2">
								<p class="text-sm text-muted-foreground">
									No continuous queries match the current filters.
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
		Status, incident counts, and last activity require a connected Drasi runtime. This
		environment shows configured state only; unavailable values are labeled rather than
		estimated.
	</p>
</div>
