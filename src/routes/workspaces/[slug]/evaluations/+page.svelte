<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import DatasetsList from '$lib/components/evaluations/datasets-list.svelte';
	import EvalsList from '$lib/components/evaluations/evals-list.svelte';
	import { Tabs, TabsList, TabsTrigger } from '$lib/components/ui/tabs';

	type Tab = 'datasets' | 'evals' | 'benchmarks';

	const slug = $derived((page.params.slug as string) ?? 'default');

	// Read activeTab from URL on every navigation (back/forward + direct links).
	const activeTab: Tab = $derived(
		(page.url.searchParams.get('tab') as Tab) === 'datasets' ? 'datasets' : 'evals'
	);

	function selectTab(tab: Tab) {
		if (tab === 'benchmarks') {
			goto(`/workspaces/${slug}/benchmarks`, { keepFocus: true, noScroll: true });
			return;
		}
		const url = new URL(page.url);
		url.searchParams.set('tab', tab);
		goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
	}

	// Old `?tab=swebench` falls through to the legacy editor until the new wizard
	// preset lands in step 8.
	$effect(() => {
		if (page.url.searchParams.get('tab') === 'swebench') {
			goto(`/workspaces/${slug}/evaluations/evals-legacy?tab=swebench`, { replaceState: true });
		}
	});
</script>

<svelte:head>
	<title>Evaluations</title>
</svelte:head>

<div class="flex flex-col h-full">
	<header class="border-b px-6 py-4">
		<AppBreadcrumb
			items={[
				{ label: 'Workspaces', href: `/workspaces/${slug}` },
				{ label: 'Evaluations' }
			]}
		/>
		<div class="mt-3 flex items-baseline justify-between gap-4 flex-wrap">
			<h1 class="text-xl font-semibold tracking-tight">Evaluation</h1>
			<Tabs value={activeTab} onValueChange={(v) => selectTab(v as Tab)}>
				<TabsList class="h-9">
					<TabsTrigger value="datasets" class="text-xs">Datasets</TabsTrigger>
					<TabsTrigger value="evals" class="text-xs">Evals</TabsTrigger>
					<TabsTrigger value="benchmarks" class="text-xs">Benchmarks</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>
	</header>

	<div class="flex-1 min-h-0 overflow-y-auto">
		{#if activeTab === 'datasets'}
			<DatasetsList {slug} />
		{:else}
			<EvalsList {slug} />
		{/if}
	</div>
</div>
