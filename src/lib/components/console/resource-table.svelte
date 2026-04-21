<script lang="ts" generics="T extends { id: string }">
	import { Button } from '$lib/components/ui/button';
	import { ChevronLeft, ChevronRight } from 'lucide-svelte';
	import type { Snippet } from 'svelte';

	interface Props<U extends { id: string }> {
		rows: U[];
		loading?: boolean;
		header: Snippet;
		row: Snippet<[U]>;
		empty?: Snippet;
		onRowClick?: (row: U) => void;

		/** Current page (0-indexed). */
		page?: number;
		/** Whether there are more rows after this page. */
		hasNext?: boolean;
		onPrev?: () => void;
		onNext?: () => void;
	}

	let {
		rows,
		loading = false,
		header,
		row,
		empty,
		onRowClick,
		page = 0,
		hasNext = false,
		onPrev,
		onNext
	}: Props<T> = $props();
</script>

<!-- Wrap in a horizontal scroll container so wide column sets
     (e.g. the sessions table with 9 columns) don't clip on narrow
     viewports. The inner table keeps w-full so narrow tables still
     stretch to fill. -->
<div class="border rounded-md overflow-x-auto">
	<table class="w-full min-w-max text-sm">
		<thead class="bg-muted/30">
			<tr class="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b">
				{@render header()}
			</tr>
		</thead>
		<tbody class="divide-y">
			{#if loading && rows.length === 0}
				<tr>
					<td colspan="99" class="p-8 text-center text-xs text-muted-foreground">Loading…</td>
				</tr>
			{:else if rows.length === 0}
				<tr>
					<td colspan="99" class="p-12 text-center text-sm text-muted-foreground">
						{#if empty}{@render empty()}{:else}No items yet.{/if}
					</td>
				</tr>
			{:else}
				{#each rows as r (r.id)}
					<tr
						class="hover:bg-muted/30 transition-colors {onRowClick ? 'cursor-pointer' : ''}"
						onclick={() => onRowClick?.(r)}
					>
						{@render row(r)}
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

{#if onPrev || onNext}
	<div class="flex items-center gap-1 pt-3">
		<Button
			variant="outline"
			size="icon"
			class="size-8"
			onclick={onPrev}
			disabled={!onPrev || page === 0}
			aria-label="Previous page"
		>
			<ChevronLeft class="size-4" />
		</Button>
		<Button
			variant="outline"
			size="icon"
			class="size-8"
			onclick={onNext}
			disabled={!onNext || !hasNext}
			aria-label="Next page"
		>
			<ChevronRight class="size-4" />
		</Button>
	</div>
{/if}
