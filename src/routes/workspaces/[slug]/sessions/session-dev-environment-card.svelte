<script lang="ts">
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { ArrowRight, Boxes, ExternalLink } from '@lucide/svelte';
	import type { SessionDevContext } from './[id]/+page.server';

	interface Props {
		slug: string;
		devContext: SessionDevContext;
	}

	let { slug, devContext }: Props = $props();

	// Prefer the grouped multi-service view; fall back to the single-service (or
	// pending) anchor from getDevEnvironmentOrPending.
	const services = $derived(
		devContext.group?.services ??
			(devContext.environment ? [devContext.environment] : [])
	);
	const readyCount = $derived(services.filter((s) => s.ready).length);
	const devHref = $derived(`/workspaces/${slug}/dev/${devContext.executionId}`);
</script>

<Card>
	<CardHeader class="pb-2">
		<CardTitle class="text-sm flex items-center gap-2">
			<Boxes class="size-4" /> Dev environment
		</CardTitle>
	</CardHeader>
	<CardContent class="text-xs space-y-2">
		<div class="text-muted-foreground">
			{services.length} service{services.length === 1 ? '' : 's'} · {readyCount} ready
		</div>

		{#if services.length > 0}
			<ul class="space-y-1">
				{#each services as svc (svc.service)}
					<li class="flex items-center gap-2 min-w-0">
						<span
							class="size-1.5 rounded-full shrink-0 {svc.ready
								? 'bg-emerald-500'
								: 'bg-muted-foreground/40'}"
							title={svc.ready ? 'ready' : 'not ready'}
						></span>
						<span class="truncate flex-1" title={svc.service}>{svc.service}</span>
						{#if svc.browseUrl}
							<a
								href={svc.browseUrl}
								target="_blank"
								rel="noreferrer"
								class="text-primary hover:text-primary/80"
								title="Browse {svc.service}"
								aria-label="Browse {svc.service}"
							>
								<ExternalLink class="size-3" />
							</a>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-muted-foreground">No active service previews.</p>
		{/if}

		<a href={devHref} class="inline-flex items-center gap-1 text-primary hover:underline pt-0.5">
			Open dev environment <ArrowRight class="size-3" />
		</a>
	</CardContent>
</Card>
