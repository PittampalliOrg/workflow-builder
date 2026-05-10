<script lang="ts">
	import { ArrowDown, ArrowUp, Inbox, Search } from "@lucide/svelte";

	import InboxRow from "$lib/components/promoter/InboxRow.svelte";
	import { Input } from "$lib/components/ui/input";
	import { buildInboxRows, sortInboxRows, type InboxSortKey } from "$lib/promoter/inbox-view";
	import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";

	import type { GitopsPageLinks } from "../../../routes/(admin)/admin/gitops/+page.server";

	type Props = {
		promotions: PromotionStrategiesResponse;
		links: GitopsPageLinks;
		onOpenStrategy: (name: string) => void;
	};

	let { promotions, links, onOpenStrategy }: Props = $props();

	let search = $state("");
	let sortKey = $state<InboxSortKey>("lastUpdated");
	let sortDirection = $state<"asc" | "desc">("desc");

	const baseRows = $derived(
		buildInboxRows(promotions.strategies, { pullRequests: promotions.pullRequests }),
	);
	const filteredRows = $derived(
		baseRows.filter((row) => {
			if (!search) return true;
			const needle = search.toLowerCase();
			return (
				row.name.toLowerCase().includes(needle) ||
				row.namespace.toLowerCase().includes(needle) ||
				(row.latestDrySubject ?? "").toLowerCase().includes(needle) ||
				(row.gitRepositoryName ?? "").toLowerCase().includes(needle)
			);
		}),
	);
	const sortedRows = $derived(sortInboxRows(filteredRows, sortKey, sortDirection));

	function toggleSort(key: InboxSortKey) {
		if (sortKey === key) {
			sortDirection = sortDirection === "asc" ? "desc" : "asc";
		} else {
			sortKey = key;
			sortDirection = key === "name" ? "asc" : "desc";
		}
	}
</script>

<div class="flex flex-1 min-h-0 flex-col overflow-hidden">
	<div class="flex items-center justify-between gap-3 border-b px-5 py-2">
		<div class="flex items-center gap-2">
			<Inbox class="size-4 text-muted-foreground" />
			<span class="text-sm font-medium">Promotion Inbox</span>
			<span class="text-[0.65rem] text-muted-foreground">
				{sortedRows.length} of {baseRows.length}
			</span>
		</div>
		<div class="relative">
			<Search class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
			<Input
				type="text"
				placeholder="Filter strategies…"
				bind:value={search}
				class="h-7 w-64 pl-7 text-sm"
			/>
		</div>
	</div>

	<div class="flex-1 overflow-y-auto">
		{#if baseRows.length === 0}
			<div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
				{promotions.error ?? "No promotion strategies in scope."}
			</div>
		{:else}
			<table class="min-w-full text-left">
				<thead class="sticky top-0 z-10 bg-muted/40 backdrop-blur">
					<tr class="border-b text-[0.65rem] uppercase tracking-wider text-muted-foreground">
						<th class="px-3 py-2">
							<button
								type="button"
								class="inline-flex items-center gap-1 hover:text-foreground"
								onclick={() => toggleSort("name")}
							>
								Strategy
								{#if sortKey === "name"}
									{#if sortDirection === "asc"}
										<ArrowUp class="size-3" />
									{:else}
										<ArrowDown class="size-3" />
									{/if}
								{/if}
							</button>
						</th>
						<th class="px-3 py-2">
							<button
								type="button"
								class="inline-flex items-center gap-1 hover:text-foreground"
								onclick={() => toggleSort("phase")}
							>
								Phase
								{#if sortKey === "phase"}
									{#if sortDirection === "asc"}
										<ArrowUp class="size-3" />
									{:else}
										<ArrowDown class="size-3" />
									{/if}
								{/if}
							</button>
						</th>
						<th class="px-3 py-2">Latest Dry · Subject</th>
						<th class="px-3 py-2">
							<button
								type="button"
								class="inline-flex items-center gap-1 hover:text-foreground"
								onclick={() => toggleSort("lastUpdated")}
							>
								Last Promo
								{#if sortKey === "lastUpdated"}
									{#if sortDirection === "asc"}
										<ArrowUp class="size-3" />
									{:else}
										<ArrowDown class="size-3" />
									{/if}
								{/if}
							</button>
						</th>
						<th class="px-3 py-2">Stuck on</th>
						<th class="px-3 py-2 text-right">Links</th>
					</tr>
				</thead>
				<tbody>
					{#each sortedRows as row (row.namespace + "/" + row.name)}
						<InboxRow
							{row}
							argoCdBase={links.argoCdBase}
							stacksRepo={links.stacksRepo}
							{onOpenStrategy}
						/>
					{/each}
				</tbody>
			</table>
			{#if sortedRows.length === 0}
				<div class="flex h-32 items-center justify-center text-xs text-muted-foreground">
					No strategies match "{search}".
				</div>
			{/if}
		{/if}
	</div>
</div>
