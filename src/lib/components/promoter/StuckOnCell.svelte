<script lang="ts">
	import StatusIcon from "$lib/components/promoter/StatusIcon.svelte";
	import type { InboxRow } from "$lib/promoter/inbox-view";

	type Props = { stuckOn: InboxRow["stuckOn"] };

	let { stuckOn }: Props = $props();

	const checks = $derived(
		stuckOn ? [...stuckOn.failingChecks.map((k) => ({ k, phase: "failure" as const })), ...stuckOn.pendingChecks.map((k) => ({ k, phase: "pending" as const }))] : [],
	);
</script>

{#if !stuckOn}
	<span class="text-xs text-muted-foreground">—</span>
{:else}
	<div class="flex items-center gap-1 text-xs">
		<StatusIcon phase={stuckOn.failingChecks.length > 0 ? "failure" : "pending"} size="xs" />
		<span class="font-mono text-[0.7rem] text-foreground">{stuckOn.branch}</span>
		{#if checks.length > 0}
			<span class="text-muted-foreground">·</span>
			<span class="flex items-center gap-1">
				{#each checks as { k, phase } (k)}
					<span
						class="rounded px-1 text-[0.6rem] font-medium {phase === 'failure'
							? 'bg-destructive/10 text-destructive'
							: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'}"
						title={k}
					>
						{k}
					</span>
				{/each}
			</span>
		{/if}
	</div>
{/if}
