<script lang="ts">
	/**
	 * Service graph — split by INTENT, not by query parameter.
	 *
	 *   Run view    — forensics on one execution: grouped live-aware run picker +
	 *                 the shared run-view (auto-detected Flow lens, Services lens,
	 *                 live polling, drilldown). Same component the run cockpit's
	 *                 Graph tab embeds.
	 *   System view — monitoring: services topology over a time window with an
	 *                 optional workflow filter.
	 *
	 * URL back-compat: legacy ?mode=&scope=&executionId=&window= deep-links map
	 * onto the views (scope=window → System; otherwise Run with mode as lens).
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { Activity } from '@lucide/svelte';
	import type { PageData } from './$types';
	import {
		SERVICE_GRAPH_WINDOWS,
		parseSelection,
		serializeSelection,
		type GraphSelection,
		type ServiceGraphPayload,
		type ServiceGraphWindow
	} from '$lib/types/service-graph';
	import { Button } from '$lib/components/ui/button';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { RefreshCw } from '@lucide/svelte';
	import ServiceGraphCanvas from '$lib/components/observability/service-graph-canvas.svelte';
	import ServiceGraphRunView from '$lib/components/observability/service-graph-run-view.svelte';
	import ServiceGraphRunPicker from '$lib/components/observability/service-graph-run-picker.svelte';

	let { data }: { data: PageData } = $props();

	// ── Initial state from URL (legacy params honored) ─────────────────────
	const params = page.url.searchParams;
	const legacyScope = params.get('scope');
	const legacyMode = params.get('mode');

	let view = $state<'run' | 'system'>(legacyScope === 'window' ? 'system' : 'run');
	let executionId = $state<string>(params.get('executionId') ?? data.defaultExecutionId ?? '');
	let lens = $state<'flow' | 'services'>(legacyMode === 'service' ? 'services' : 'flow');
	let windowKey = $state<ServiceGraphWindow>(
		(params.get('window') as ServiceGraphWindow) ?? '15m'
	);
	let workflowFilter = $state<string>(params.get('workflowId') ?? '');
	const initialSelection = parseSelection(params.get('sel'), params.get('selKind'));
	const initialRunId = params.get('executionId') ?? data.defaultExecutionId ?? '';
	let selection = $state<GraphSelection | null>(initialSelection);

	const WINDOWS = Object.keys(SERVICE_GRAPH_WINDOWS) as ServiceGraphWindow[];

	const selectedRun = $derived(data.executions.find((e) => e.id === executionId) ?? null);
	const runActive = $derived(
		selectedRun?.status === 'running' || selectedRun?.status === 'pending'
	);

	// ── URL reflection (legacy param names kept for deep-link stability) ───
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});
	$effect(() => {
		if (!mounted) return;
		const sp = new URLSearchParams();
		if (view === 'run') {
			sp.set('mode', lens === 'services' ? 'service' : 'step');
			sp.set('scope', 'execution');
			if (executionId) sp.set('executionId', executionId);
			if (selection) {
				sp.set('sel', serializeSelection(selection));
				if (selection.kind === 'node') sp.set('selKind', selection.nodeKind);
			}
		} else {
			sp.set('mode', 'service');
			sp.set('scope', 'window');
			sp.set('window', windowKey);
			if (workflowFilter) sp.set('workflowId', workflowFilter);
		}
		try {
			replaceState(`?${sp.toString()}`, {});
		} catch {
			/* router not ready yet */
		}
	});

	// ── System view fetch (Run view fetching lives in the shared component) ─
	let systemPayload = $state<ServiceGraphPayload | null>(null);
	let systemLoading = $state(false);
	let systemNonce = $state(0);
	$effect(() => {
		if (view !== 'system') return;
		void systemNonce;
		const sp = new URLSearchParams({ mode: 'service', scope: 'window', window: windowKey });
		if (workflowFilter) sp.set('workflowId', workflowFilter);
		const controller = new AbortController();
		systemLoading = true;
		fetch(`/api/observability/service-graph?${sp.toString()}`, { signal: controller.signal })
			.then((r) => r.json())
			.then((p: ServiceGraphPayload) => {
				if (!controller.signal.aborted) systemPayload = p;
			})
			.catch((e) => {
				if (e?.name !== 'AbortError') console.error('service-graph fetch failed', e);
			})
			.finally(() => {
				if (!controller.signal.aborted) systemLoading = false;
			});
		return () => controller.abort();
	});
</script>

<svelte:head>
	<title>Service graph · workflow-builder</title>
</svelte:head>

<div class="flex h-full flex-col">
	<div class="flex items-center gap-3 border-b px-4 py-3">
		<Activity size={18} class="text-primary" />
		<h1 class="text-lg font-semibold">Service graph</h1>

		<!-- Intent tabs: forensics vs monitoring. Each view carries only its own
		     controls — no invalid combinations exist. -->
		<div class="ml-2 inline-flex overflow-hidden rounded-md border">
			<Button
				variant={view === 'run' ? 'default' : 'ghost'}
				size="sm"
				class="h-7 rounded-none px-3 text-xs"
				onclick={() => (view = 'run')}>This run</Button
			>
			<Button
				variant={view === 'system' ? 'default' : 'ghost'}
				size="sm"
				class="h-7 rounded-none px-3 text-xs"
				onclick={() => (view = 'system')}>System</Button
			>
		</div>

		{#if view === 'run'}
			<ServiceGraphRunPicker
				value={executionId}
				runs={data.executions}
				onChange={(id) => (executionId = id)}
			/>
		{:else}
			<div class="flex items-center gap-2">
				<NativeSelect bind:value={windowKey} class="h-8 w-24 text-xs">
					{#each WINDOWS as w (w)}
						<option value={w}>{w}</option>
					{/each}
				</NativeSelect>
				<NativeSelect bind:value={workflowFilter} class="h-8 w-56 text-xs">
					<option value="">All workflows</option>
					{#each data.workflows as wf (wf.id)}
						<option value={wf.id}>{wf.name}</option>
					{/each}
				</NativeSelect>
				<Button
					variant="ghost"
					size="sm"
					class="h-8 gap-1 px-2 text-xs"
					disabled={systemLoading}
					onclick={() => (systemNonce += 1)}
				>
					<RefreshCw class="size-3 {systemLoading ? 'animate-spin' : ''}" /> Refresh
				</Button>
			</div>
		{/if}
	</div>

	{#if view === 'run'}
		{#if executionId}
			{#key executionId}
				<ServiceGraphRunView
					{executionId}
					active={runActive}
					initialLens={lens}
					initialSelection={executionId === initialRunId ? initialSelection : null}
					onLensChange={(l) => (lens = l)}
					onSelectionChange={(s) => (selection = s)}
				/>
			{/key}
		{:else}
			<div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
				Pick a run to see its graph.
			</div>
		{/if}
	{:else}
		<div class="min-h-0 flex-1">
			<ServiceGraphCanvas payload={systemPayload} loading={systemLoading} />
		</div>
		{#if systemPayload?.meta.degraded}
			<div class="border-t bg-destructive/10 px-4 py-2 text-xs text-destructive">
				Telemetry store unavailable — graph may be incomplete. {systemPayload.meta.warnings.join(
					' · '
				)}
			</div>
		{/if}
	{/if}
</div>
