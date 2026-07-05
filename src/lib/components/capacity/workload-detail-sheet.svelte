<script lang="ts">
	import * as Sheet from '$lib/components/ui/sheet';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import {
		AlertCircle,
		CheckCircle2,
		Clock,
		Code2,
		Info,
		ListChecks,
		RefreshCw,
		ScrollText,
	} from '@lucide/svelte';
	import {
		createWorkloadDetailStream,
		createWorkloadEventsStream,
	} from '$lib/stores/kueueviz/workload-detail.svelte';
	import StatusPill from './stream-status-pill.svelte';
	import WorkloadStatusBadge from './workload-status-badge.svelte';

	type Props = {
		open: boolean;
		namespace: string | null;
		name: string | null;
		onOpenChange: (next: boolean) => void;
	};

	let { open, namespace, name, onOpenChange }: Props = $props();

	type Tab = 'overview' | 'events' | 'yaml';
	let activeTab = $state<Tab>('overview');

	// Reset to Overview every time the drawer opens for a new workload.
	$effect(() => {
		if (open && name) activeTab = 'overview';
	});

	// Streams: only created while the sheet is open and we have a target.
	// Wrapping in a derived avoids creating them on every reactive tick.
	const detailStream = $derived(
		open && namespace && name ? createWorkloadDetailStream(namespace, name) : null,
	);
	const eventsStream = $derived(
		open && namespace && name && activeTab === 'events'
			? createWorkloadEventsStream(namespace, name)
			: null,
	);

	let yamlContent = $state<string | null>(null);
	let yamlError = $state<string | null>(null);
	let yamlLoading = $state(false);

	async function loadYaml() {
		if (!namespace || !name) return;
		yamlLoading = true;
		yamlError = null;
		try {
			const res = await fetch(
				`/api/kueueviz/yaml?type=workload&namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(name)}`,
			);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.message ?? `failed (${res.status})`);
			}
			const body = (await res.json()) as { content: string };
			yamlContent = body.content;
		} catch (err) {
			yamlError = err instanceof Error ? err.message : 'failed to load YAML';
		} finally {
			yamlLoading = false;
		}
	}

	$effect(() => {
		if (open && activeTab === 'yaml' && !yamlContent && !yamlLoading) {
			void loadYaml();
		}
		if (!open) {
			yamlContent = null;
			yamlError = null;
		}
	});

	function ageDisplay(iso: string | null | undefined): string {
		if (!iso) return '—';
		const ms = Date.now() - new Date(iso).getTime();
		if (!Number.isFinite(ms) || ms < 0) return '—';
		const seconds = Math.floor(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}

	const detail = $derived(detailStream?.data ?? null);
	const eventList = $derived(eventsStream?.data ?? []);
</script>

<Sheet.Root {open} onOpenChange={(next) => onOpenChange(next)}>
	<Sheet.Content side="right" class="w-full sm:max-w-2xl flex min-h-0 flex-col gap-0">
		<Sheet.Header class="border-b px-5 py-3 space-y-1">
			<Sheet.Title class="flex items-center gap-2 text-base">
				<ScrollText class="size-4" />
				<span class="font-mono text-sm">{name ?? ''}</span>
				{#if detail}
					<WorkloadStatusBadge status={detail.status} />
				{/if}
			</Sheet.Title>
			<Sheet.Description class="text-[11px] flex flex-wrap items-center gap-2">
				<span class="font-mono">{namespace ?? ''}</span>
				{#if detail?.queueName}
					<span class="text-muted-foreground/70">/</span>
					<span class="font-mono">{detail.queueName}</span>
				{/if}
				{#if detail?.clusterQueueName && detail.clusterQueueName !== detail.queueName}
					<span class="text-muted-foreground/70">→</span>
					<span class="font-mono">{detail.clusterQueueName}</span>
				{/if}
				{#if detailStream}
					<span class="ml-auto">
						<StatusPill
							status={detailStream.status}
							lastUpdate={detailStream.lastUpdate}
							error={detailStream.error}
						/>
					</span>
				{/if}
			</Sheet.Description>
		</Sheet.Header>

		<nav class="flex border-b text-sm" aria-label="Workload detail tabs">
			{#each [
				{ id: 'overview' as Tab, label: 'Overview', icon: Info },
				{ id: 'events' as Tab, label: 'Events', icon: ListChecks },
				{ id: 'yaml' as Tab, label: 'Raw YAML', icon: Code2 }
			] as tab (tab.id)}
				<button
					type="button"
					class="flex items-center gap-1.5 border-b-2 px-3 py-2 transition-colors {activeTab === tab.id
						? 'border-primary text-foreground font-medium'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeTab = tab.id)}
				>
					<tab.icon class="size-3.5" />
					{tab.label}
				</button>
			{/each}
		</nav>

		<div class="flex-1 overflow-auto px-5 py-4">
			{#if activeTab === 'overview'}
				{#if !detail && detailStream?.status !== 'open'}
					<div class="space-y-3">
						<Skeleton class="h-4 w-1/2" />
						<Skeleton class="h-3 w-full" />
						<Skeleton class="h-3 w-3/4" />
						<Skeleton class="h-24 w-full" />
					</div>
				{:else if !detail}
					<Alert>
						<AlertDescription class="text-xs">
							No data yet. The workload may have just been deleted.
						</AlertDescription>
					</Alert>
				{:else}
					<dl class="grid grid-cols-[120px_1fr] gap-y-2 gap-x-3 text-xs">
						<dt class="text-muted-foreground">Status</dt>
						<dd class="flex items-center gap-2">
							<WorkloadStatusBadge status={detail.status} />
							{#if detail.active}
								<span class="text-muted-foreground/80">{ageDisplay(detail.creationTimestamp)} old</span>
							{/if}
						</dd>
						<dt class="text-muted-foreground">Queue</dt>
						<dd class="font-mono">
							{detail.queueName || '—'}
							{#if detail.clusterQueueName && detail.clusterQueueName !== detail.queueName}
								<span class="text-muted-foreground"> → {detail.clusterQueueName}</span>
							{/if}
						</dd>
						{#if detail.priorityClassName || typeof detail.priority === 'number'}
							<dt class="text-muted-foreground">Priority</dt>
							<dd class="font-mono">
								{detail.priorityClassName ?? '(default)'}
								{#if typeof detail.priority === 'number'}
									<span class="text-muted-foreground"> · {detail.priority}</span>
								{/if}
							</dd>
						{/if}
						<dt class="text-muted-foreground">Pods</dt>
						<dd>{detail.totalPods} across {detail.podSetCount} pod set{detail.podSetCount === 1 ? '' : 's'}</dd>
					</dl>

					{#if Object.keys(detail.labels).length > 0}
						<section class="mt-5 space-y-2">
							<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
								Labels
							</h3>
							<ul class="flex flex-wrap gap-1">
								{#each Object.entries(detail.labels) as [k, v] (k)}
									<li>
										<Badge variant="outline" class="font-mono text-[10px]">
											{k}=<span class="text-foreground">{v}</span>
										</Badge>
									</li>
								{/each}
							</ul>
						</section>
					{/if}

					<section class="mt-5 space-y-2">
						<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
							Pod sets
						</h3>
						{#if detail.podSets.length === 0}
							<p class="text-xs text-muted-foreground">No pod sets reported.</p>
						{:else}
							<ul class="space-y-2">
								{#each detail.podSets as ps (ps.name)}
									<li class="rounded-md border bg-muted/30 p-3">
										<div class="flex items-center justify-between text-xs">
											<span class="font-mono font-semibold">{ps.name}</span>
											<span class="text-muted-foreground tabular-nums">{ps.count} pod{ps.count === 1 ? '' : 's'}</span>
										</div>
										{#if Object.keys(ps.requests).length > 0}
											<dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
												{#each Object.entries(ps.requests) as [r, q] (r)}
													<dt class="text-muted-foreground">{r}</dt>
													<dd class="font-mono">{q}</dd>
												{/each}
											</dl>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</section>

					{#if detail.admission}
						<section class="mt-5 space-y-2">
							<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
								Admission
							</h3>
							<p class="text-xs">
								Admitted into <span class="font-mono">{detail.admission.clusterQueue}</span>
							</p>
							{#if detail.admission.assignments.length > 0}
								<ul class="mt-2 space-y-1">
									{#each detail.admission.assignments as a (a.podSetName)}
										<li class="rounded border bg-background p-2 text-[11px]">
											<div class="flex items-center justify-between">
												<span class="font-mono">{a.podSetName}</span>
												{#if a.flavor}
													<Badge variant="outline" class="text-[10px]">{a.flavor}</Badge>
												{/if}
											</div>
											{#if Object.keys(a.resourceAssignments).length > 0}
												<dl class="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
													{#each Object.entries(a.resourceAssignments) as [r, q] (r)}
														<dt class="text-muted-foreground">{r}</dt>
														<dd class="font-mono text-right">{q}</dd>
													{/each}
												</dl>
											{/if}
										</li>
									{/each}
								</ul>
							{/if}
						</section>
					{/if}

					<section class="mt-5 space-y-2">
						<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
							Conditions
						</h3>
						{#if detail.conditions.length === 0}
							<p class="text-xs text-muted-foreground">No conditions reported.</p>
						{:else}
							<ul class="space-y-1">
								{#each detail.conditions as c (c.type + c.lastTransitionTime)}
									<li class="rounded border p-2 text-[11px]">
										<div class="flex items-center justify-between">
											<span class="font-mono font-medium">{c.type}</span>
											<Badge variant="outline" class="text-[10px]">{c.status}</Badge>
										</div>
										{#if c.reason}
											<div class="text-muted-foreground"><span class="text-foreground">Reason:</span> {c.reason}</div>
										{/if}
										{#if c.message}
											<div class="text-muted-foreground"><span class="text-foreground">Message:</span> {c.message}</div>
										{/if}
										{#if c.lastTransitionTime}
											<div class="text-muted-foreground/80 text-[10px] mt-0.5">{ageDisplay(c.lastTransitionTime)} ago</div>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}
			{:else if activeTab === 'events'}
				{#if !eventsStream || (eventsStream.status !== 'open' && eventList.length === 0)}
					<div class="space-y-3">
						<Skeleton class="h-3 w-3/4" />
						<Skeleton class="h-3 w-1/2" />
						<Skeleton class="h-3 w-2/3" />
					</div>
				{:else if eventList.length === 0}
					<p class="text-xs text-muted-foreground">No events yet for this workload.</p>
				{:else}
					<ol class="space-y-1.5">
						{#each eventList as ev (ev.lastTimestamp + ev.reason + ev.message)}
							<li class="flex gap-3 rounded border p-2 text-[11px]">
								<div class="pt-0.5">
									{#if ev.type === 'Warning'}
										<AlertCircle class="size-3.5 text-amber-500" />
									{:else}
										<CheckCircle2 class="size-3.5 text-emerald-500" />
									{/if}
								</div>
								<div class="flex-1 space-y-0.5">
									<div class="flex items-center justify-between gap-2">
										<span class="font-mono font-medium">{ev.reason || '(no reason)'}</span>
										<span class="text-muted-foreground tabular-nums">
											<Clock class="inline size-3 mr-0.5" />
											{ageDisplay(ev.lastTimestamp)} ago
										</span>
									</div>
									<p class="text-muted-foreground">{ev.message}</p>
									<div class="flex items-center gap-2 text-[10px] text-muted-foreground/80">
										{#if ev.count > 1}
											<span>×{ev.count}</span>
										{/if}
										{#if ev.source}
											<span class="font-mono">{ev.source}</span>
										{/if}
									</div>
								</div>
							</li>
						{/each}
					</ol>
				{/if}
			{:else if activeTab === 'yaml'}
				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<span class="text-[11px] text-muted-foreground">
							Fetched on demand from upstream KueueViz REST.
						</span>
						<Button variant="ghost" size="sm" class="h-7" onclick={() => { yamlContent = null; void loadYaml(); }} disabled={yamlLoading}>
							<RefreshCw class="size-3 {yamlLoading ? 'animate-spin' : ''}" />
							Refresh
						</Button>
					</div>
					{#if yamlError}
						<Alert variant="destructive">
							<AlertDescription class="text-xs">{yamlError}</AlertDescription>
						</Alert>
					{/if}
					{#if yamlLoading && !yamlContent}
						<Skeleton class="h-64 w-full" />
					{:else if yamlContent}
						<pre class="max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre">{yamlContent}</pre>
					{/if}
				</div>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
