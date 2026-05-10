<script lang="ts">
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import {
		Table,
		TableBody,
		TableCell,
		TableHead,
		TableHeader,
		TableRow,
	} from '$lib/components/ui/table';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Badge } from '$lib/components/ui/badge';
	import { Tag } from '@lucide/svelte';
	import { createResourceFlavorStream } from '$lib/stores/kueueviz/resource-flavors.svelte';
	import { createClusterQueueStream } from '$lib/stores/kueueviz/cluster-queues.svelte';
	import StatusPill from '$lib/components/capacity/status-pill.svelte';
	import type { ResourceFlavorSnapshot } from '$lib/server/kueueviz';

	const flavors = createResourceFlavorStream();
	const clusterQueues = createClusterQueueStream();

	let selected = $state<ResourceFlavorSnapshot | null>(null);

	function flavorUsedByQueues(name: string): string[] {
		const out = new Set<string>();
		for (const cq of clusterQueues.data) {
			for (const fu of cq.flavorsUsage) {
				if (fu.flavor === name) out.add(cq.name);
			}
		}
		return Array.from(out);
	}

	const selectedUsedBy = $derived(selected ? flavorUsedByQueues(selected.name) : []);
</script>

<div class="space-y-4">
	<div class="flex items-center justify-between">
		<StatusPill status={flavors.status} lastUpdate={flavors.lastUpdate} error={flavors.error} />
		<span class="text-[11px] text-muted-foreground tabular-nums">
			{flavors.data.length} flavor{flavors.data.length === 1 ? '' : 's'}
		</span>
	</div>

	<Card>
		<CardHeader class="pb-2">
			<CardTitle class="text-base flex items-center gap-2">
				<Tag class="size-4 text-muted-foreground" />
				Resource Flavors
			</CardTitle>
		</CardHeader>
		<CardContent>
			{#if flavors.data.length === 0 && flavors.status !== 'open'}
				<div class="space-y-2">
					<Skeleton class="h-8 w-full" />
					<Skeleton class="h-8 w-full" />
				</div>
			{:else if flavors.data.length === 0}
				<p class="text-xs text-muted-foreground">No ResourceFlavors registered.</p>
			{:else}
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Node selector</TableHead>
							<TableHead class="text-right">Taints</TableHead>
							<TableHead class="text-right">Used by</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{#each flavors.data as flavor (flavor.name)}
							{@const usedBy = flavorUsedByQueues(flavor.name)}
							<TableRow
								class="cursor-pointer hover:bg-muted/40"
								onclick={() => (selected = flavor)}
							>
								<TableCell class="font-mono text-xs">{flavor.name}</TableCell>
								<TableCell class="text-xs">
									{#if Object.keys(flavor.nodeLabels).length === 0}
										<span class="text-muted-foreground">—</span>
									{:else}
										<div class="flex flex-wrap gap-1">
											{#each Object.entries(flavor.nodeLabels) as [k, v] (k)}
												<Badge variant="outline" class="text-[10px] font-mono">
													{k}=<span class="text-foreground">{v}</span>
												</Badge>
											{/each}
										</div>
									{/if}
								</TableCell>
								<TableCell class="text-right text-xs tabular-nums">
									{flavor.nodeTaints.length}
								</TableCell>
								<TableCell class="text-right text-xs">
									{#if usedBy.length === 0}
										<span class="text-muted-foreground">—</span>
									{:else}
										<div class="flex flex-wrap justify-end gap-1">
											{#each usedBy as cq (cq)}
												<Badge variant="outline" class="text-[10px] font-mono">{cq}</Badge>
											{/each}
										</div>
									{/if}
								</TableCell>
							</TableRow>
						{/each}
					</TableBody>
				</Table>
			{/if}
		</CardContent>
	</Card>
</div>

<Sheet.Root
	open={selected !== null}
	onOpenChange={(next) => {
		if (!next) selected = null;
	}}
>
	<Sheet.Content side="right" class="w-full sm:max-w-lg flex min-h-0 flex-col gap-0">
		<Sheet.Header class="border-b px-5 py-3 space-y-1">
			<Sheet.Title class="flex items-center gap-2 text-base">
				<Tag class="size-4" />
				<span class="font-mono text-sm">{selected?.name ?? ''}</span>
			</Sheet.Title>
			<Sheet.Description class="text-[11px]">
				ResourceFlavor — node selectors and taints determine which workers admit this flavor.
			</Sheet.Description>
		</Sheet.Header>
		<div class="flex-1 overflow-auto px-5 py-4 space-y-5">
			{#if selected}
				<section class="space-y-2">
					<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						Node labels
					</h3>
					{#if Object.keys(selected.nodeLabels).length === 0}
						<p class="text-xs text-muted-foreground">
							No node selector — this flavor admits any worker.
						</p>
					{:else}
						<dl class="grid grid-cols-[180px_1fr] gap-y-1 gap-x-3 text-[11px]">
							{#each Object.entries(selected.nodeLabels) as [k, v] (k)}
								<dt class="font-mono text-muted-foreground truncate" title={k}>{k}</dt>
								<dd class="font-mono">{v}</dd>
							{/each}
						</dl>
					{/if}
				</section>

				<section class="space-y-2">
					<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						Node taints
					</h3>
					{#if selected.nodeTaints.length === 0}
						<p class="text-xs text-muted-foreground">No taints required.</p>
					{:else}
						<ul class="space-y-1">
							{#each selected.nodeTaints as t (t.key + (t.value ?? ''))}
								<li class="rounded border bg-muted/30 p-2 text-[11px] font-mono">
									{t.key}{#if t.value}={t.value}{/if}:{t.effect}
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<section class="space-y-2">
					<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						Tolerations
					</h3>
					{#if selected.tolerations.length === 0}
						<p class="text-xs text-muted-foreground">No tolerations declared.</p>
					{:else}
						<ul class="space-y-1">
							{#each selected.tolerations as t, i (i)}
								<li class="rounded border bg-muted/30 p-2 text-[11px] font-mono">
									{t.key ?? ''}{#if t.operator}{' '}{t.operator}{/if}{#if t.value}={t.value}{/if}{#if t.effect}:{t.effect}{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<section class="space-y-2">
					<h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
						Used by Cluster Queues
					</h3>
					{#if selectedUsedBy.length === 0}
						<p class="text-xs text-muted-foreground">Not referenced by any Cluster Queue.</p>
					{:else}
						<div class="flex flex-wrap gap-1">
							{#each selectedUsedBy as cq (cq)}
								<Badge variant="outline" class="font-mono text-[10px]">{cq}</Badge>
							{/each}
						</div>
					{/if}
				</section>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
