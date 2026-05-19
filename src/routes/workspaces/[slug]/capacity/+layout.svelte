<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { Gauge, Layers, ListChecks, Tag } from '@lucide/svelte';

	type Props = {
		children: Snippet;
	};

	let { children }: Props = $props();

	const slug = $derived(page.params.slug as string);
	const pathname = $derived(page.url.pathname);

	const tabs = $derived([
		{
			id: 'overview',
			label: 'Overview',
			icon: Gauge,
			href: `/workspaces/${slug}/capacity/overview`
		},
		{
			id: 'workloads',
			label: 'Workloads',
			icon: ListChecks,
			href: `/workspaces/${slug}/capacity/workloads`
		},
		{
			id: 'queues',
			label: 'Queues',
			icon: Layers,
			href: `/workspaces/${slug}/capacity/queues`
		},
		{
			id: 'flavors',
			label: 'Flavors',
			icon: Tag,
			href: `/workspaces/${slug}/capacity/flavors`
		}
	]);
</script>

<div class="h-full min-w-0 space-y-4 overflow-y-auto p-4 md:p-6">
	<header class="space-y-1">
		<h1 class="text-xl font-semibold flex items-center gap-2">
			<Gauge class="size-5" /> Capacity
		</h1>
		<p class="text-xs text-muted-foreground">
			Live Kueue queue state from <code class="font-mono text-[11px]">kueue-kueueviz-backend</code>,
			combined with worker headroom from
			<code class="font-mono text-[11px]">capacity-observer</code>.
		</p>
	</header>

	<nav class="flex gap-1 overflow-x-auto border-b text-sm whitespace-nowrap" aria-label="Capacity sections">
		{#each tabs as tab (tab.id)}
			{@const active = pathname.startsWith(tab.href)}
			<a
				href={tab.href}
				class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 transition-colors {active
					? 'border-primary text-foreground font-medium'
					: 'border-transparent text-muted-foreground hover:text-foreground'}"
			>
				<tab.icon class="size-3.5" />
				{tab.label}
			</a>
		{/each}
	</nav>

	<div>
		{@render children()}
	</div>
</div>
