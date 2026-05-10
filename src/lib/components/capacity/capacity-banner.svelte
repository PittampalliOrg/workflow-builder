<script lang="ts">
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Gauge, Hourglass } from '@lucide/svelte';
	import { createClusterQueueStream } from '$lib/stores/kueueviz/cluster-queues.svelte';

	type Props = {
		/**
		 * Workspace slug for the "View in Capacity" deep-link. When omitted,
		 * the banner resolves the caller's active workspace via
		 * `/api/v1/workspaces`. Pass explicitly when called from a route
		 * that already has the slug in scope (avoids the extra fetch).
		 */
		workspaceSlug?: string;
		/** Optional filter — only count queues whose name is in this list. */
		queueNames?: string[];
	};

	let { workspaceSlug, queueNames }: Props = $props();

	let resolvedSlug = $state<string | null>(workspaceSlug ?? null);

	$effect(() => {
		if (resolvedSlug !== null) return;
		void (async () => {
			try {
				const res = await fetch('/api/v1/workspaces');
				if (!res.ok) return;
				const body = (await res.json()) as {
					workspaces?: Array<{ slug: string; isCurrent?: boolean }>;
				};
				const list = body.workspaces ?? [];
				const active = list.find((w) => w.isCurrent) ?? list[0];
				if (active?.slug) resolvedSlug = active.slug;
			} catch {
				// best-effort — banner just falls back to /workspaces (no slug)
			}
		})();
	});

	const capacityHref = $derived(
		resolvedSlug ? `/workspaces/${resolvedSlug}/capacity/workloads` : '/workspaces',
	);

	const stream = createClusterQueueStream();

	const summary = $derived.by(() => {
		const queues = queueNames
			? stream.data.filter((cq) => queueNames.includes(cq.name))
			: stream.data;
		const pending = queues.reduce((acc, cq) => acc + cq.pendingWorkloads, 0);
		const reserving = queues.reduce((acc, cq) => acc + cq.reservingWorkloads, 0);
		return { pending, reserving, queues };
	});

	const show = $derived(summary.pending > 0 || summary.reserving > 0);
</script>

{#if show}
	<Alert class="border-amber-500/40 bg-amber-500/10">
		<AlertDescription class="text-xs flex items-center gap-2 flex-wrap">
			<Hourglass class="size-3.5 text-amber-600 dark:text-amber-400" />
			<span class="font-medium">Awaiting capacity:</span>
			{#if summary.pending > 0}
				<Badge variant="outline" class="text-[10px] font-mono border-amber-500/40">
					{summary.pending} pending
				</Badge>
			{/if}
			{#if summary.reserving > 0}
				<Badge variant="outline" class="text-[10px] font-mono border-sky-500/40">
					{summary.reserving} reserving
				</Badge>
			{/if}
			<span class="text-muted-foreground">
				across
				{#each summary.queues.filter((q) => q.pendingWorkloads > 0 || q.reservingWorkloads > 0) as q, i (q.name)}
					{i > 0 ? ', ' : ''}<span class="font-mono">{q.name}</span>
				{/each}
			</span>
			<a
				href={capacityHref}
				class="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
			>
				<Gauge class="size-3" />
				View in Capacity →
			</a>
		</AlertDescription>
	</Alert>
{/if}
