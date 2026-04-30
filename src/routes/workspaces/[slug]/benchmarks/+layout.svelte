<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import { Tabs, TabsList, TabsTrigger } from '$lib/components/ui/tabs';

	const { children } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');
	const subTab = $derived.by<'instances' | 'runs' | 'compare'>(() => {
		const path = page.url.pathname;
		if (path.includes('/benchmarks/runs')) return 'runs';
		if (path.includes('/benchmarks/compare')) return 'compare';
		return 'instances';
	});

	function selectSubTab(tab: string | undefined) {
		if (!tab) return;
		if (tab === 'instances') goto(`/workspaces/${slug}/benchmarks`, { keepFocus: true, noScroll: true });
		if (tab === 'runs') goto(`/workspaces/${slug}/benchmarks/runs`, { keepFocus: true, noScroll: true });
		if (tab === 'compare')
			goto(`/workspaces/${slug}/benchmarks/compare`, { keepFocus: true, noScroll: true });
	}

	function selectOptimizeTab(tab: string | undefined) {
		if (!tab) return;
		if (tab === 'evals') goto(`/workspaces/${slug}/evaluations?tab=evals`, { keepFocus: true });
		if (tab === 'datasets') goto(`/workspaces/${slug}/evaluations?tab=datasets`, { keepFocus: true });
	}
</script>

<div class="h-full min-h-0 overflow-y-auto">
	<div class="mx-auto w-full max-w-[1400px] space-y-4 p-6 pb-10">
		<AppBreadcrumb
			items={[{ label: 'Workspace', href: `/workspaces/${slug}` }, { label: 'Benchmarks' }]}
		/>

		<div class="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
			<Tabs value={subTab} onValueChange={selectSubTab}>
				<TabsList class="h-9">
					<TabsTrigger value="instances" class="text-xs">Instances</TabsTrigger>
					<TabsTrigger value="runs" class="text-xs">Runs</TabsTrigger>
					<TabsTrigger value="compare" class="text-xs">Compare</TabsTrigger>
				</TabsList>
			</Tabs>
			<Tabs value="benchmarks" onValueChange={selectOptimizeTab}>
				<TabsList class="h-9">
					<TabsTrigger value="datasets" class="text-xs">Datasets</TabsTrigger>
					<TabsTrigger value="evals" class="text-xs">Evals</TabsTrigger>
					<TabsTrigger value="benchmarks" class="text-xs">Benchmarks</TabsTrigger>
				</TabsList>
			</Tabs>
		</div>

		{@render children?.()}
	</div>
</div>
