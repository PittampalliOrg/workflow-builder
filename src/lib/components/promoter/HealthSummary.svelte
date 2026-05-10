<script lang="ts">
	import { untrack } from "svelte";
	import { ChevronDown, ChevronRight } from "@lucide/svelte";

	import CheckRow from "$lib/components/promoter/CheckRow.svelte";
	import StatusIcon from "$lib/components/promoter/StatusIcon.svelte";
	import type { CheckCounts } from "$lib/promoter/pipeline-view";
	import type { CommitStatusEntry } from "$lib/server/promoter/types";

	type Props = {
		checks: CommitStatusEntry[];
		counts: CheckCounts;
		defaultOpen?: boolean;
		emptyLabel?: string;
	};

	let { checks, counts, defaultOpen = false, emptyLabel = "no checks" }: Props = $props();

	let open = $state(untrack(() => defaultOpen));

	const overall = $derived.by(() => {
		if (counts.failure > 0) return "failure";
		if (counts.total === 0) return "unknown";
		if (counts.success === counts.total) return "success";
		return "pending";
	});
</script>

{#if counts.total === 0}
	<div class="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
		<StatusIcon phase="unknown" size="xs" />
		{emptyLabel}
	</div>
{:else}
	<div class="space-y-1">
		<button
			type="button"
			class="flex w-full items-center gap-1 rounded text-[0.7rem] text-foreground hover:text-primary"
			onclick={() => (open = !open)}
		>
			{#if open}
				<ChevronDown class="size-3" />
			{:else}
				<ChevronRight class="size-3" />
			{/if}
			<StatusIcon phase={overall} size="xs" />
			<span class="font-medium">
				{counts.success}/{counts.total} Checks
			</span>
			{#if counts.failure > 0}
				<span class="text-destructive">· {counts.failure} failed</span>
			{:else if counts.pending > 0}
				<span class="text-amber-600 dark:text-amber-400">· {counts.pending} pending</span>
			{/if}
		</button>
		{#if open}
			<ul class="space-y-0.5 pl-4">
				{#each checks as check (check.key)}
					<li>
						<CheckRow {check} />
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
