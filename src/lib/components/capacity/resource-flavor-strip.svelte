<script lang="ts">
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Tag } from '@lucide/svelte';
	import type { ResourceFlavorSnapshot } from '$lib/server/kueueviz';

	type Props = {
		flavors: ResourceFlavorSnapshot[];
	};

	let { flavors }: Props = $props();
</script>

<Card>
	<CardHeader class="pb-2">
		<CardTitle class="text-base flex items-center gap-2">
			<Tag class="size-4 text-muted-foreground" />
			Resource Flavors
		</CardTitle>
	</CardHeader>
	<CardContent>
		{#if flavors.length === 0}
			<p class="text-xs text-muted-foreground">No flavors registered.</p>
		{:else}
			<ul class="flex flex-wrap gap-2">
				{#each flavors as flavor (flavor.name)}
					<li class="flex flex-col gap-1 rounded-md border bg-muted/30 p-2 min-w-[180px]">
						<div class="flex items-center justify-between">
							<span class="font-mono text-xs font-medium">{flavor.name}</span>
							{#if flavor.nodeTaints.length > 0}
								<Badge variant="outline" class="text-[10px]">tainted</Badge>
							{/if}
						</div>
						{#if Object.keys(flavor.nodeLabels).length === 0}
							<span class="text-[10px] text-muted-foreground">no node selector</span>
						{:else}
							<ul class="space-y-0.5 text-[10px] text-muted-foreground">
								{#each Object.entries(flavor.nodeLabels) as [k, v] (k)}
									<li class="font-mono truncate" title={`${k}=${v}`}>
										{k}=<span class="text-foreground/80">{v}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</CardContent>
</Card>
