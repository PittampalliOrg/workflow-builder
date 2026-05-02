<script lang="ts">
	import { page } from '$app/state';
	import { Loader2, CircleAlert } from '@lucide/svelte';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import InvestigationStudio from '$lib/components/observability/investigation-studio.svelte';
	import type { ObservabilityInvestigationPayload } from '$lib/types/observability';

	let traceId = $derived(page.params.traceId);
	let payload = $state<ObservabilityInvestigationPayload | null>(null);
	let isLoading = $state(true);
	let error = $state<string | null>(null);

	async function loadInvestigation() {
		if (!traceId) return;
		isLoading = true;
		error = null;
		try {
			const res = await fetch(`/api/observability/traces/${traceId}/investigation`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (data.error) {
				error = data.error;
			} else {
				payload = data;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load trace';
		} finally {
			isLoading = false;
		}
	}

	$effect(() => {
		loadInvestigation();
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center gap-3 border-b border-border px-6">
		<Breadcrumb.Root>
			<Breadcrumb.List class="gap-1 text-xs">
				<Breadcrumb.Item>
					<Breadcrumb.Link href="/observability" class="text-[10px] uppercase tracking-wide">Traces</Breadcrumb.Link>
				</Breadcrumb.Item>
				<Breadcrumb.Separator class="[&>svg]:size-3" />
				<Breadcrumb.Item>
					<Breadcrumb.Page class="text-xs font-mono">{traceId?.slice(0, 16) ?? '...'}</Breadcrumb.Page>
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>
	</header>

	<div class="flex-1 overflow-hidden">
		{#if isLoading}
			<div class="flex items-center justify-center p-12">
				<Loader2 size={24} class="animate-spin text-muted-foreground" />
			</div>
		{:else if error}
			<Alert variant="destructive" class="m-6">
				<CircleAlert class="size-4" />
				<AlertDescription>{error}</AlertDescription>
			</Alert>
		{:else if payload}
			<InvestigationStudio
				{payload}
				mlflowHref={traceId ? `/api/observability/mlflow/traces/${encodeURIComponent(traceId)}` : null}
				legacyTraceHref={payload.summary.sessionId ? `/api/observability/phoenix/sessions/${encodeURIComponent(payload.summary.sessionId)}` : null}
				onRefresh={loadInvestigation}
			/>
		{/if}
	</div>
</div>
