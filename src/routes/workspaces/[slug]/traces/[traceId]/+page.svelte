<script lang="ts">
	import { page } from '$app/state';
	import { Loader2, CircleAlert, ArrowLeft, ExternalLink } from '@lucide/svelte';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import InvestigationStudio from '$lib/components/observability/investigation-studio.svelte';
	import TraceSummaryHeader from '$lib/components/observability/trace-summary-header.svelte';
	import type { ObservabilityInvestigationPayload } from '$lib/types/observability';

	const slug = $derived(page.params.slug);
	const traceId = $derived(page.params.traceId);
	let payload = $state<ObservabilityInvestigationPayload | null>(null);
	let isLoading = $state(true);
	let error = $state<string | null>(null);

	const sessionId = $derived(payload?.summary?.sessionId ?? null);

	async function loadInvestigation() {
		if (!traceId) return;
		isLoading = true;
		error = null;
		try {
			const res = await fetch(`/api/observability/traces/${traceId}/investigation`);
			if (!res.ok) throw new Error(res.status === 404 ? 'Trace not found in this workspace' : `HTTP ${res.status}`);
			const data = await res.json();
			if (data.error) error = data.error;
			else payload = data;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load trace';
		} finally {
			isLoading = false;
		}
	}

	$effect(() => {
		void traceId;
		loadInvestigation();
	});
</script>

<svelte:head><title>Trace {traceId?.slice(0, 12) ?? ''}</title></svelte:head>

<div class="flex h-full flex-col bg-[#0b0c0e]">
	<header class="flex h-12 shrink-0 items-center gap-3 border-b border-white/10 px-4 text-zinc-200">
		<a
			href={`/workspaces/${slug}/traces`}
			class="inline-flex size-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100"
			title="Back to traces"
		>
			<ArrowLeft size={16} />
		</a>
		<Breadcrumb.Root>
			<Breadcrumb.List class="gap-1 text-xs">
				<Breadcrumb.Item>
					<Breadcrumb.Link href={`/workspaces/${slug}/traces`} class="text-[10px] uppercase tracking-wide text-zinc-400">Traces</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="text-zinc-600 [&>svg]:size-3" />
				<Breadcrumb.Item>
					<Breadcrumb.Page class="font-mono text-xs text-zinc-200">{traceId?.slice(0, 18) ?? '...'}</Breadcrumb.Page>
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>
		{#if sessionId}
			<a
				href={`/workspaces/${slug}/sessions/${sessionId}`}
				class="ml-auto inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-zinc-300 transition hover:bg-white/10"
			>
				<ExternalLink size={11} /> Session
			</a>
		{/if}
	</header>

	<div class="min-h-0 flex-1 overflow-hidden">
		{#if isLoading}
			<div class="flex h-full items-center justify-center">
				<Loader2 size={24} class="animate-spin text-zinc-500" />
			</div>
		{:else if error}
			<Alert variant="destructive" class="m-6">
				<CircleAlert class="size-4" />
				<AlertDescription>{error}</AlertDescription>
			</Alert>
		{:else if payload}
			<div class="flex h-full flex-col">
				<TraceSummaryHeader
					summary={payload.summary}
					rootOperation={payload.traceSpans.find((s) => !s.parentSpanId)?.operationName ?? payload.traceSpans[0]?.operationName ?? null}
					rootService={payload.traceSpans.find((s) => !s.parentSpanId)?.serviceName ?? payload.traceSpans[0]?.serviceName ?? null}
					llmTurns={payload.agentDecisions.length}
					toolCalls={payload.toolSpans.length}
				/>
				<div class="min-h-0 flex-1">
					<InvestigationStudio {payload} mlflowHref={null} legacyTraceHref={null} onRefresh={loadInvestigation} />
				</div>
			</div>
		{/if}
	</div>
</div>
