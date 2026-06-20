<script lang="ts">
	/** Merged "Cost & Usage" analytics page — two dual aspects of one token
	 *  dataset (Phase 1 of the Observe-hub consolidation). The old /cost page
	 *  redirects here (?tab=cost). */
	import { page } from '$app/state';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import UsagePanel from '$lib/components/analytics/usage-panel.svelte';
	import CostPanel from '$lib/components/analytics/cost-panel.svelte';

	// Initial tab from ?tab= (the old /cost route redirects here with ?tab=cost).
	let tab = $state(page.url.searchParams.get('tab') === 'cost' ? 'cost' : 'usage');
</script>

<div class="h-full overflow-y-auto flex flex-col gap-4 p-6 max-w-7xl mx-auto w-full">
	<header>
		<h1 class="text-2xl font-semibold">Cost &amp; Usage</h1>
		<p class="text-sm text-muted-foreground mt-1">
			Token usage and estimated cost across every API and UI session in this workspace.
		</p>
	</header>

	<Tabs bind:value={tab} class="flex flex-col gap-4">
		<TabsList class="w-fit">
			<TabsTrigger value="usage">Usage</TabsTrigger>
			<TabsTrigger value="cost">Cost</TabsTrigger>
		</TabsList>
		<TabsContent value="usage">
			<UsagePanel />
		</TabsContent>
		<TabsContent value="cost">
			<CostPanel />
		</TabsContent>
	</Tabs>
</div>
