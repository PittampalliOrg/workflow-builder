<script lang="ts">
	/**
	 * Mirrors `sessionHostAppId(sessionId)` from
	 * `src/lib/server/sessions/agent-workflow-host.ts:61` — SHA-256 of the
	 * session id, take the first 20 hex chars, prefix with `agent-session-`.
	 * Kept client-side to avoid an extra round trip; the server function is
	 * the source of truth and any divergence would be a bug.
	 */
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { ArrowRight, Gauge } from '@lucide/svelte';
	import { createWorkloadStream } from '$lib/stores/kueueviz/workloads.svelte';
	import WorkloadStatusBadge from './workload-status-badge.svelte';
	import StatusPill from './stream-status-pill.svelte';

	type Props = {
		sessionId: string;
		workspaceSlug: string;
	};

	let { sessionId, workspaceSlug }: Props = $props();

	let agentAppId = $state<string | null>(null);

	$effect(() => {
		// `sessionId` flows from a parent prop; recompute whenever it
		// changes (rare — once per page load).
		agentAppId = null;
		const target = sessionId;
		void (async () => {
			const enc = new TextEncoder().encode(target);
			const hash = await crypto.subtle.digest('SHA-256', enc);
			const hex = Array.from(new Uint8Array(hash))
				.map((b) => b.toString(16).padStart(2, '0'))
				.join('')
				.slice(0, 20);
			if (target === sessionId) agentAppId = `agent-session-${hex}`;
		})();
	});

	const stream = createWorkloadStream();

	const matched = $derived.by(() => {
		if (!agentAppId) return null;
		// Prefer an active workload; fall back to the most recent finished/
		// evicted one so the card is still useful after the session ends.
		const candidates = stream.data.filter(
			(wl) => wl.labels['agent-app-id'] === agentAppId,
		);
		if (candidates.length === 0) return null;
		const active = candidates.filter((wl) => wl.active);
		if (active.length > 0) return active[0];
		return candidates.sort((a, b) =>
			(a.creationTimestamp < b.creationTimestamp ? 1 : -1),
		)[0];
	});

	const detailHref = $derived(
		matched
			? `/workspaces/${workspaceSlug}/capacity/workloads?queue=${encodeURIComponent(matched.queueName || matched.clusterQueueName || '')}`
			: `/workspaces/${workspaceSlug}/capacity/workloads`,
	);

	const showCard = $derived(
		// Keep the card hidden until we have a definitive answer. If the
		// session never ran on Kueue (UI agents, browser-use), there's
		// nothing to show.
		matched !== null || stream.status === 'connecting' || agentAppId === null,
	);

	const isLoading = $derived(agentAppId === null || stream.status === 'connecting');
</script>

{#if showCard}
	<Card>
		<CardHeader class="pb-2">
			<div class="flex items-center justify-between gap-2">
				<div class="space-y-0.5">
					<CardTitle class="text-sm flex items-center gap-1.5">
						<Gauge class="size-3.5 text-muted-foreground" />
						Capacity
					</CardTitle>
					<CardDescription class="text-[11px]">
						Kueue Workload backing this session
					</CardDescription>
				</div>
				<StatusPill
					status={stream.status}
					lastUpdate={stream.lastUpdate}
					error={stream.error}
				/>
			</div>
		</CardHeader>
		<CardContent class="space-y-2 text-xs">
			{#if isLoading}
				<Skeleton class="h-4 w-2/3" />
				<Skeleton class="h-3 w-1/2" />
			{:else if matched}
				<div class="flex items-center gap-2">
					<WorkloadStatusBadge status={matched.status} />
					<span class="font-mono truncate" title={matched.name}>{matched.name}</span>
				</div>
				<dl class="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-[11px]">
					<dt class="text-muted-foreground">Namespace</dt>
					<dd class="font-mono">{matched.namespace}</dd>
					<dt class="text-muted-foreground">Queue</dt>
					<dd class="font-mono">
						{matched.queueName || '—'}
						{#if matched.clusterQueueName && matched.clusterQueueName !== matched.queueName}
							<span class="text-muted-foreground"> → {matched.clusterQueueName}</span>
						{/if}
					</dd>
					<dt class="text-muted-foreground">Pods</dt>
					<dd>{matched.totalPods}</dd>
					{#if matched.labels['benchmark-instance-id']}
						<dt class="text-muted-foreground">Instance</dt>
						<dd class="font-mono truncate" title={matched.labels['benchmark-instance-id']}>
							{matched.labels['benchmark-instance-id']}
						</dd>
					{/if}
				</dl>
				<div class="flex flex-wrap items-center gap-2 pt-1">
					<Button
						variant="outline"
						size="sm"
						class="h-7 text-[11px]"
						onclick={() => {
							window.location.href = detailHref;
						}}
					>
						View in Capacity <ArrowRight class="size-3" />
					</Button>
					<Badge variant="outline" class="font-mono text-[10px]">{agentAppId}</Badge>
				</div>
			{:else}
				<p class="text-muted-foreground text-[11px]">
					No matching Kueue Workload found for this session.
				</p>
			{/if}
		</CardContent>
	</Card>
{/if}
