<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type { CapacityOwnerRef } from '$lib/types/capacity';

	type Props = {
		owners?: CapacityOwnerRef[] | null;
		max?: number;
		compact?: boolean;
	};

	let { owners = [], max = 3, compact = false }: Props = $props();

	const visible = $derived((owners ?? []).slice(0, max));
	const extra = $derived(Math.max(0, (owners?.length ?? 0) - visible.length));

	function kindLabel(kind: CapacityOwnerRef['kind']): string {
		if (kind === 'workflowRun') return 'Run';
		if (kind === 'benchmarkRun') return 'Bench';
		if (kind === 'benchmarkInstance') return 'Case';
		return kind.charAt(0).toUpperCase() + kind.slice(1);
	}
</script>

{#if visible.length > 0}
	<div class="flex min-w-0 flex-wrap items-center gap-1">
		{#each visible as owner (owner.kind + ':' + owner.id)}
			<a
				href={owner.href}
				class="inline-flex max-w-[11rem] items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground hover:text-foreground"
				title={`${kindLabel(owner.kind)}: ${owner.label}${owner.secondaryLabel ? ` (${owner.secondaryLabel})` : ''}`}
				onclick={(event) => event.stopPropagation()}
			>
				<span class="shrink-0 font-medium text-foreground/80">{kindLabel(owner.kind)}</span>
				{#if !compact}
					<span class="truncate">{owner.label}</span>
				{/if}
			</a>
		{/each}
		{#if extra > 0}
			<Badge variant="outline" class="text-[10px]">+{extra}</Badge>
		{/if}
	</div>
{/if}
