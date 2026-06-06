<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import { AlertTriangle, FlaskConical } from '@lucide/svelte';
	import InstanceTable from '$lib/components/benchmarks/instance-table.svelte';
	import LaunchRunSheet from '$lib/components/benchmarks/launch-run-sheet.svelte';
	import InstanceDetailDrawer from '$lib/components/benchmarks/instance-detail-drawer.svelte';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');

	// Launch Sheet state
	let launchOpen = $state(false);
	let launchInstanceIds = $state<string[]>([]);
	let launchSuiteSlug = $state<string>('SWE-bench_Verified');
	let launchRequirePrevalidatedEnvironments = $state(false);

	// Instance detail drawer state
	let drawerOpen = $state(false);
	let drawerInstanceId = $state<string | null>(null);
	let drawerSuiteSlug = $state<string | null>(null);

	function handleLaunch(args: {
		instanceIds: string[];
		suiteSlug: string;
		requirePrevalidatedEnvironments?: boolean;
	}) {
		launchInstanceIds = args.instanceIds;
		launchSuiteSlug = args.suiteSlug;
		launchRequirePrevalidatedEnvironments = args.requirePrevalidatedEnvironments === true;
		launchOpen = true;
	}

	function handleInstanceClick(args: { instanceId: string; suiteSlug: string }) {
		drawerInstanceId = args.instanceId;
		drawerSuiteSlug = args.suiteSlug;
		drawerOpen = true;
	}

	// Backwards-compat: legacy ?run=<id> deep links land here.
	// Redirect into the new /runs/[runId] route preserving the param-less URL
	// after navigation.
	onMount(() => {
		const legacyRunId = page.url.searchParams.get('run');
		if (legacyRunId) {
			goto(`/workspaces/${slug}/benchmarks/runs/${encodeURIComponent(legacyRunId)}`, {
				replaceState: true
			});
		}
	});
</script>

<svelte:head><title>SWE-bench instances · Benchmarks</title></svelte:head>

<div class="space-y-5">
	<header class="flex flex-wrap items-start justify-between gap-4">
		<div class="min-w-0">
			<h1 class="flex items-center gap-2 text-2xl font-semibold">
				<FlaskConical class="size-6" /> SWE-bench instances
			</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Browse Verified ({data.suiteFacets.find((s) => s.slug === 'SWE-bench_Verified')
					?.instanceCount ?? 0}) and Lite ({data.suiteFacets.find((s) => s.slug === 'SWE-bench_Lite')
					?.instanceCount ?? 0}) instances. Select or randomly sample, then launch a parallel run
				through the SWE-bench coordinator.
			</p>
			<div class="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
				{#each data.suiteFacets as suite (suite.slug)}
					<span class="rounded-md border border-border bg-background px-2 py-1">
						{suite.name}: {suite.environmentCoverage?.validated ?? 0} validated
						{#if suite.environmentCoverage?.building}
							· {suite.environmentCoverage.building} building
						{/if}
						{#if suite.environmentCoverage?.failed}
							· {suite.environmentCoverage.failed} failed
						{/if}
						{#if suite.environmentCoverage?.notBuilt}
							· {suite.environmentCoverage.notBuilt} not built
						{/if}
					</span>
				{/each}
			</div>
		</div>
		<Button variant="outline" onclick={() => goto(`/workspaces/${slug}/benchmarks/runs`)}>
			View runs →
		</Button>
	</header>

	<div class="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
		<AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
		<p>
			SWE-bench Lite and Verified are useful for internal regression and harness debugging.
			Treat them as contaminated for frontier capability claims; OpenAI recommends SWE-bench
			Pro for current public reporting.
		</p>
	</div>

	{#if data.runnableAgents.length === 0}
		<div class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
			No registered durable coding agents (<code class="rounded bg-amber-100 px-1 text-[11px] dark:bg-amber-900/40">dapr-agent-py</code>,
			<code class="rounded bg-amber-100 px-1 text-[11px] dark:bg-amber-900/40">adk-agent-py</code>,
			or <code class="rounded bg-amber-100 px-1 text-[11px] dark:bg-amber-900/40">claude-agent-py</code>)
			in this workspace. Publish one to launch SWE-bench runs.
		</div>
	{/if}

	<InstanceTable
		instances={data.instances}
		repoFacets={data.repoFacets}
		suiteFacets={data.suiteFacets}
		canLaunch={data.runnableAgents.length > 0}
		onLaunch={handleLaunch}
		onInstanceClick={handleInstanceClick}
	/>
</div>

<LaunchRunSheet
	bind:open={launchOpen}
	instanceIds={launchInstanceIds}
	suiteSlug={launchSuiteSlug}
	requirePrevalidatedEnvironments={launchRequirePrevalidatedEnvironments}
	runnableAgents={data.runnableAgents}
	suiteFacets={data.suiteFacets}
	onOpenChange={(next) => (launchOpen = next)}
/>

<InstanceDetailDrawer
	bind:open={drawerOpen}
	instanceId={drawerInstanceId}
	suiteSlug={drawerSuiteSlug}
	onOpenChange={(next) => (drawerOpen = next)}
/>
