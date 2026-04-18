<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Loader2, RefreshCw, Search, CircleAlert, X } from 'lucide-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Label } from '$lib/components/ui/label';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Switch } from '$lib/components/ui/switch';
	import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';

	interface Trace {
		traceId: string;
		serviceName: string;
		operationName: string;
		startTime: string;
		duration: number;
		spanCount: number;
		status: 'ok' | 'error';
	}

	let traces = $state<Trace[]>([]);
	let services = $state<string[]>([]);
	let selectedService = $state('');
	let isLoading = $state(false);
	let autoRefresh = $state(false);
	let error = $state<string | null>(null);

	// Session filter: read from URL (?sessionId=...) so deep-links from the
	// session detail page land pre-filtered. Clearable via the "clear" chip.
	const sessionIdFilter = $derived(page.url.searchParams.get('sessionId') ?? '');

	async function fetchTraces() {
		isLoading = true;
		error = null;
		try {
			const params = new URLSearchParams({ limit: '50' });
			if (selectedService) params.set('service', selectedService);
			if (sessionIdFilter) params.set('sessionId', sessionIdFilter);
			const res = await fetch(`/api/observability/traces?${params}`);
			const data = await res.json();
			if (data.error && !data.traces?.length) {
				error = data.error;
			}
			traces = data.traces ?? [];
			if (data.services?.length) {
				services = data.services;
			}
		} catch (err) {
			error = 'Failed to fetch traces';
			console.error(err);
		} finally {
			isLoading = false;
		}
	}

	// Initial load
	$effect(() => {
		fetchTraces();
	});

	// Auto-refresh
	$effect(() => {
		if (!autoRefresh) return;
		const interval = setInterval(fetchTraces, 5000);
		return () => clearInterval(interval);
	});

	// Refetch when service filter or the URL-backed session filter changes
	$effect(() => {
		void selectedService;
		void sessionIdFilter;
		fetchTraces();
	});

	function formatTime(iso: string): string {
		const d = new Date(iso);
		return d.toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
	}

	function formatDuration(ms: number): string {
		if (ms < 1) return '<1ms';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
	}

	function truncateId(id: string): string {
		return id.length > 16 ? id.slice(0, 16) + '...' : id;
	}
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div class="flex items-center gap-2">
			<h1 class="text-sm font-semibold tracking-tight">Traces</h1>
			{#if sessionIdFilter}
				<Badge variant="secondary" class="text-[10px] gap-1">
					session={sessionIdFilter.slice(0, 10)}
					<button
						type="button"
						class="ml-1 inline-flex size-3 items-center justify-center rounded hover:bg-background/50"
						onclick={() => goto('/observability')}
						aria-label="Clear session filter"
					>
						<X size={10} />
					</button>
				</Badge>
			{/if}
		</div>
		<div class="flex items-center gap-3">
			<!-- Service filter -->
			<div class="flex items-center gap-2">
				<Search size={14} class="text-muted-foreground" />
				<NativeSelect
					bind:value={selectedService}
					class="w-full"
				>
					<option value="">All services</option>
					{#each services as svc}
						<option value={svc}>{svc}</option>
					{/each}
				</NativeSelect>
			</div>

			<!-- Auto-refresh toggle -->
			<div class="flex items-center gap-1.5">
				<Switch bind:checked={autoRefresh} id="auto-refresh" />
				<Label for="auto-refresh" class="text-muted-foreground">Auto-refresh</Label>
			</div>

			<!-- Manual refresh -->
			<Button
				variant="ghost"
				size="icon"
				onclick={fetchTraces}
				disabled={isLoading}
				title="Refresh"
			>
				<RefreshCw size={16} class={isLoading ? 'animate-spin' : ''} />
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-auto">
		{#if error}
			<Alert variant="destructive" class="m-6">
				<CircleAlert class="size-4" />
				<AlertDescription>{error}</AlertDescription>
			</Alert>
		{/if}

		{#if isLoading && traces.length === 0}
			<div class="flex items-center justify-center p-12">
				<Loader2 size={24} class="animate-spin text-muted-foreground" />
			</div>
		{:else if traces.length === 0}
			<div class="p-12 text-center text-sm text-muted-foreground">
				No traces found. Make sure Jaeger is running and services are instrumented with OpenTelemetry.
			</div>
		{:else}
			<Table class="w-full text-sm">
				<TableHeader class="sticky top-0 bg-card border-b border-border">
					<TableRow class="text-left text-xs text-muted-foreground">
						<TableHead class="px-4 py-2.5 font-medium">Trace ID</TableHead>
						<TableHead class="px-4 py-2.5 font-medium">Service</TableHead>
						<TableHead class="px-4 py-2.5 font-medium">Operation</TableHead>
						<TableHead class="px-4 py-2.5 font-medium">Duration</TableHead>
						<TableHead class="px-4 py-2.5 font-medium">Spans</TableHead>
						<TableHead class="px-4 py-2.5 font-medium">Timestamp</TableHead>
						<TableHead class="px-4 py-2.5 font-medium">Status</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody class="divide-y divide-border">
					{#each traces as trace (trace.traceId)}
						<TableRow
							class="cursor-pointer hover:bg-accent/50 transition-colors"
							onclick={() => goto(`/observability/${trace.traceId}`)}
						>
							<TableCell class="px-4 py-2.5 font-mono text-xs">{truncateId(trace.traceId)}</TableCell>
							<TableCell class="px-4 py-2.5">
								<Badge variant="outline" class="text-[10px]">{trace.serviceName}</Badge>
							</TableCell>
							<TableCell class="px-4 py-2.5 max-w-[200px] truncate">{trace.operationName}</TableCell>
							<TableCell class="px-4 py-2.5 font-mono text-xs">{formatDuration(trace.duration)}</TableCell>
							<TableCell class="px-4 py-2.5 text-xs text-muted-foreground">{trace.spanCount}</TableCell>
							<TableCell class="px-4 py-2.5 text-xs text-muted-foreground">{formatTime(trace.startTime)}</TableCell>
							<TableCell class="px-4 py-2.5">
								{#if trace.status === 'error'}
									<Badge variant="destructive" class="text-[10px]">Error</Badge>
								{:else}
									<Badge variant="default" class="text-[10px]">OK</Badge>
								{/if}
							</TableCell>
						</TableRow>
					{/each}
				</TableBody>
			</Table>
		{/if}
	</div>
</div>
