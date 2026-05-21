<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { Activity } from '@lucide/svelte';
	import type { PageData } from './$types';
	import type {
		ServiceGraphMode,
		ServiceGraphPayload,
		ServiceGraphScope,
		ServiceGraphWindow
	} from '$lib/types/service-graph';
	import ServiceGraphControls from '$lib/components/observability/service-graph-controls.svelte';
	import ServiceGraphCanvas from '$lib/components/observability/service-graph-canvas.svelte';

	let { data }: { data: PageData } = $props();

	const params = page.url.searchParams;
	const hasExecutions = data.executions.length > 0;

	let mode = $state<ServiceGraphMode>((params.get('mode') as ServiceGraphMode) ?? 'service');
	let scope = $state<ServiceGraphScope>(
		(params.get('scope') as ServiceGraphScope) ?? (hasExecutions ? 'execution' : 'window')
	);
	let executionId = $state<string>(params.get('executionId') ?? data.defaultExecutionId ?? '');
	let workflowId = $state<string>(params.get('workflowId') ?? '');
	let windowKey = $state<ServiceGraphWindow>((params.get('window') as ServiceGraphWindow) ?? '1h');

	let payload = $state<ServiceGraphPayload | null>(null);
	let loading = $state(false);
	let refreshNonce = $state(0);

	// A request is valid to fire unless it's step+window without a workflow, or
	// per-run scope without a selected execution.
	let canFetch = $derived(
		!(scope === 'window' && mode === 'step' && !workflowId) &&
			!(scope === 'execution' && !executionId)
	);

	let queryString = $derived.by(() => {
		const sp = new URLSearchParams({ mode, scope });
		if (scope === 'execution') {
			sp.set('executionId', executionId);
		} else {
			sp.set('window', windowKey);
			if (workflowId) sp.set('workflowId', workflowId);
		}
		if (scope === 'execution' && workflowId) sp.set('workflowId', workflowId);
		return sp.toString();
	});

	let abort: AbortController | null = null;
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	// Reflect state in the URL for deep-linking. Separate effect + mounted guard:
	// replaceState throws if called during hydration (before the router inits), and
	// it must never block the data fetch below. Using replaceState (not goto) keeps
	// the page `load` from re-running — the selector lists load once.
	$effect(() => {
		const qs = queryString;
		if (!mounted) return;
		try {
			replaceState(`?${qs}`, {});
		} catch {
			/* router not ready yet — URL will sync on the next change */
		}
	});

	$effect(() => {
		// Track these so the effect re-runs on any control change or manual refresh.
		const qs = queryString;
		void refreshNonce;
		if (!canFetch) {
			payload = null;
			return;
		}

		abort?.abort();
		const controller = new AbortController();
		abort = controller;
		loading = true;
		fetch(`/api/observability/service-graph?${qs}`, { signal: controller.signal })
			.then((r) => r.json())
			.then((p: ServiceGraphPayload) => {
				if (!controller.signal.aborted) payload = p;
			})
			.catch((e) => {
				if (e?.name !== 'AbortError') console.error('service-graph fetch failed', e);
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});

		return () => controller.abort();
	});
</script>

<svelte:head>
	<title>Service graph · workflow-builder</title>
</svelte:head>

<div class="flex h-full flex-col">
	<div class="flex items-center gap-2 px-4 pt-4">
		<Activity size={18} class="text-primary" />
		<h1 class="text-lg font-semibold">Service graph</h1>
		<p class="text-sm text-muted-foreground">
			Metric-driven topology (rate · errors · duration) reconstructed from execution telemetry.
		</p>
	</div>

	<ServiceGraphControls
		bind:mode
		bind:scope
		bind:executionId
		bind:workflowId
		bind:windowKey
		executions={data.executions}
		workflows={data.workflows}
		{loading}
		onrefresh={() => (refreshNonce += 1)}
	/>

	<div class="min-h-0 flex-1">
		<ServiceGraphCanvas {payload} {loading} />
	</div>

	{#if payload?.meta.degraded}
		<div class="border-t bg-destructive/10 px-4 py-2 text-xs text-destructive">
			Telemetry store unavailable — graph may be incomplete. {payload.meta.warnings.join(' · ')}
		</div>
	{/if}
</div>
