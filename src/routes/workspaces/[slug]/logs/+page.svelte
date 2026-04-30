<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Info, RefreshCw } from '@lucide/svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';

	const slug = $derived((page.params.slug as string) ?? 'default');

	type Row = {
		timestamp: string;
		traceId: string;
		spanId: string;
		requestId: string | null;
		model: string | null;
		sessionId: string | null;
		type: string;
		serviceTier: string;
		inputTokens: number | null;
		outputTokens: number | null;
		durationMs: number;
		status: 'ok' | 'error';
	};
	type Row2 = Row & { id: string };

	let logs = $state<Row2[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let asOf = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function load() {
		try {
			const res = await fetch('/api/v1/logs/model-requests');
			if (!res.ok) {
				errorMessage = `Failed to load logs (${res.status})`;
				return;
			}
			const data = (await res.json()) as { logs: Row[]; error?: string; asOf: string };
			if (data.error && !data.logs?.length) {
				errorMessage = data.error;
			} else {
				errorMessage = null;
			}
			logs = (data.logs ?? []).map((r, i) => ({
				...r,
				id: `${r.traceId || r.spanId || r.requestId || i}-${i}`
			}));
			asOf = data.asOf;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function formatTimestamp(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleString(undefined, {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	onMount(() => {
		void load();
		// Auto-refresh every 30s — matches CMA's "Last refresh time" chip.
		timer = setInterval(() => void load(), 30_000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

<div class="p-6 space-y-5 max-w-7xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">Logs</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Every model request, one row per call. Backed by ClickHouse OpenTelemetry traces.
			</p>
		</div>
		<div class="flex items-center gap-3">
			{#if asOf}
				<span class="text-xs text-muted-foreground">
					Last refresh: {formatTimestamp(asOf)}
				</span>
			{/if}
			<Button variant="outline" size="sm" onclick={() => void load()}>
				<RefreshCw class="size-3.5" /> Refresh
			</Button>
		</div>
	</header>

	{#if errorMessage}
		<Alert>
			<AlertDescription class="text-xs flex items-center gap-2">
				<Info class="size-3.5" />
				{errorMessage}
			</AlertDescription>
		</Alert>
	{/if}

	<ResourceTable rows={logs} {loading}>
		{#snippet header()}
			<th class="px-4 py-2.5 font-medium">Time</th>
			<th class="px-4 py-2.5 font-medium">ID</th>
			<th class="px-4 py-2.5 font-medium">Model</th>
			<th class="px-4 py-2.5 font-medium text-right">Input</th>
			<th class="px-4 py-2.5 font-medium text-right">Output</th>
			<th class="px-4 py-2.5 font-medium">Type</th>
			<th class="px-4 py-2.5 font-medium">Tier</th>
			<th class="px-4 py-2.5 font-medium text-right">Duration</th>
			<th class="px-4 py-2.5 font-medium">Status</th>
		{/snippet}
		{#snippet row(r: Row2)}
			<td class="px-4 py-2.5 text-xs text-muted-foreground font-mono whitespace-nowrap">
				{formatTimestamp(r.timestamp)}
			</td>
			<td class="px-4 py-2.5">
				{#if r.requestId}
					<CopyIdButton value={r.requestId} />
				{:else}
					<CopyIdButton value={r.traceId} />
				{/if}
			</td>
			<td class="px-4 py-2.5">
				<code class="text-[11px]">{r.model ?? '—'}</code>
			</td>
			<td class="px-4 py-2.5 text-right text-xs">
				{r.inputTokens !== null ? r.inputTokens.toLocaleString() : '—'}
			</td>
			<td class="px-4 py-2.5 text-right text-xs">
				{r.outputTokens !== null ? r.outputTokens.toLocaleString() : '—'}
			</td>
			<td class="px-4 py-2.5 text-xs">{r.type}</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">{r.serviceTier}</td>
			<td class="px-4 py-2.5 text-right text-xs text-muted-foreground">
				{r.durationMs.toLocaleString()}ms
			</td>
			<td class="px-4 py-2.5">
				{#if r.status === 'error'}
					<Badge variant="destructive" class="text-[10px]">Error</Badge>
				{:else}
					<Badge variant="outline" class="text-[10px] bg-green-600/15 text-green-700 dark:text-green-400 border-transparent">OK</Badge>
				{/if}
			</td>
		{/snippet}
		{#snippet empty()}
			<div class="flex flex-col items-center justify-center py-10 space-y-3">
				<div class="text-muted-foreground text-sm">
					No model-request spans in ClickHouse yet.
				</div>
				<p class="text-xs text-muted-foreground max-w-md text-center">
					As soon as an agent makes an LLM call, the OTel collector will forward a
					<code>span.model_request_*</code> span and it will show up here.
				</p>
			</div>
		{/snippet}
	</ResourceTable>
</div>
