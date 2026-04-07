<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { Loader2, CheckCircle2, XCircle, CircleAlert } from 'lucide-svelte';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';
	import { Badge } from '$lib/components/ui/badge';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Table, TableBody, TableRow, TableCell } from '$lib/components/ui/table';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import OTelLogList, {
		type ObservabilityLogEntry
	} from '$lib/components/observability/otel-log-list.svelte';

	interface Span {
		traceId?: string;
		spanId: string;
		parentSpanId: string | null;
		operationName: string;
		serviceName: string;
		startTime: string;
		duration: number;
		status: 'ok' | 'error';
		statusCode?: string;
		statusMessage?: string;
		spanKind?: string;
		attributes?: Record<string, unknown>;
		resourceAttributes?: Record<string, unknown>;
		depth: number;
	}

	interface TraceDetail {
		traceId: string;
		spans: Span[];
		totalDuration: number;
		startTime: string;
	}

	let traceId = $derived(page.params.traceId);
	let trace = $state<TraceDetail | null>(null);
	let isLoading = $state(true);
	let error = $state<string | null>(null);
	let expandedSpans = $state<Set<string>>(new Set());
	let traceFilter = $state<'all' | 'llm'>('all');
	let selectedSpanId = $state<string | null>(null);
	let traceDetailTab = $state<'spans' | 'logs'>('spans');
	let traceLogs = $state<ObservabilityLogEntry[]>([]);
	let traceLogsLoading = $state(true);
	let traceLogsError = $state<string | null>(null);

	$effect(() => {
		if (!traceId) return;
		isLoading = true;
		error = null;

		fetch(`/api/observability/traces/${traceId}`)
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			})
			.then((data) => {
				if (data.error) {
					error = data.error;
				} else {
					trace = data;
				}
			})
			.catch((err) => {
				error = err.message ?? 'Failed to load trace';
			})
			.finally(() => {
				isLoading = false;
			});

		traceLogsLoading = true;
		traceLogsError = null;
		fetch(`/api/observability/traces/${traceId}/logs`)
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return res.json();
			})
			.then((data) => {
				if (data.error) {
					traceLogsError = data.error;
				} else {
					traceLogs = data.logs ?? [];
				}
			})
			.catch((err) => {
				traceLogsError = err.message ?? 'Failed to load logs';
			})
			.finally(() => {
				traceLogsLoading = false;
			});
	});

	function formatDuration(ms: number): string {
		if (ms < 1) return '<1ms';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
	}

	function formatTime(iso: string): string {
		return new Date(iso).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			fractionalSecondDigits: 3
		});
	}

	function toggleSpan(spanId: string) {
		selectedSpanId = selectedSpanId === spanId ? null : spanId;
		const next = new Set(expandedSpans);
		if (next.has(spanId)) {
			next.delete(spanId);
		} else {
			next.add(spanId);
		}
		expandedSpans = next;
	}

	function isLlmRelatedSpan(span: Span): boolean {
		const operation = span.operationName.toLowerCase();
		const service = span.serviceName.toLowerCase();
		const spanKind = span.spanKind?.toLowerCase() ?? '';
		const directSignals = [
			'chatcompletion',
			'responses',
			'callllm',
			'generatetext',
			'streamtext',
			'agent.run',
			'gen_ai',
			'openai',
			'anthropic',
			'llm'
		];
		if (directSignals.some((signal) => operation.includes(signal) || service.includes(signal) || spanKind.includes(signal))) {
			return true;
		}

		const records = [span.attributes, span.resourceAttributes].filter(Boolean) as Record<string, unknown>[];
		for (const record of records) {
			for (const [key, rawValue] of Object.entries(record)) {
				const normalizedKey = key.toLowerCase();
				const normalizedValue =
					typeof rawValue === 'string'
						? rawValue.toLowerCase()
						: JSON.stringify(rawValue).toLowerCase();
				if (
					normalizedKey.startsWith('gen_ai.') ||
					normalizedKey.includes('llm') ||
					normalizedKey.includes('model') ||
					normalizedValue.includes('gen_ai') ||
					normalizedValue.includes('llm') ||
					normalizedValue.includes('openai') ||
					normalizedValue.includes('anthropic')
				) {
					return true;
				}
			}
		}

		return false;
	}

	const filteredSpans = $derived.by(() => {
		if (!trace) return [];
		return traceFilter === 'llm' ? trace.spans.filter(isLlmRelatedSpan) : trace.spans;
	});

	const llmSpanCount = $derived.by(() => trace?.spans.filter(isLlmRelatedSpan).length ?? 0);
	const selectedSpan = $derived.by(() => {
		if (!trace || !selectedSpanId) return null;
		const match = trace.spans.find((span) => span.spanId === selectedSpanId);
		if (!match) return null;
		return {
			traceId: match.traceId ?? trace.traceId,
			spanId: match.spanId,
			label: match.operationName
		};
	});

	function barOffset(span: Span): number {
		if (!trace) return 0;
		const traceStart = new Date(trace.startTime).getTime();
		const spanStart = new Date(span.startTime).getTime();
		return trace.totalDuration > 0
			? ((spanStart - traceStart) / trace.totalDuration) * 100
			: 0;
	}

	function barWidth(span: Span): number {
		if (!trace || trace.totalDuration === 0) return 100;
		const pct = (span.duration / trace.totalDuration) * 100;
		return Math.max(pct, 0.5); // minimum visible width
	}

	// Service color map
	const serviceColors = [
		'bg-blue-500',
		'bg-green-500',
		'bg-orange-500',
		'bg-purple-500',
		'bg-pink-500',
		'bg-cyan-500',
		'bg-yellow-500',
		'bg-red-400'
	];

	function serviceColor(serviceName: string): string {
		if (!trace) return serviceColors[0];
		const uniqueServices = [...new Set(trace.spans.map((s) => s.serviceName))];
		const idx = uniqueServices.indexOf(serviceName);
		return serviceColors[idx % serviceColors.length];
	}
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
					<Breadcrumb.Page class="text-xs font-mono">{trace?.traceId?.slice(0, 16) ?? '...'}</Breadcrumb.Page>
				</Breadcrumb.Item>
			</Breadcrumb.List>
		</Breadcrumb.Root>
	</header>

	<div class="flex-1 overflow-auto">
		{#if isLoading}
			<div class="flex items-center justify-center p-12">
				<Loader2 size={24} class="animate-spin text-muted-foreground" />
			</div>
		{:else if error}
			<Alert variant="destructive" class="m-6">
				<CircleAlert class="size-4" />
				<AlertDescription>{error}</AlertDescription>
			</Alert>
		{:else if trace}
			<!-- Trace summary -->
			<div class="border-b border-border px-6 py-4">
				<div class="flex items-center gap-4 text-sm">
					<div>
						<span class="text-muted-foreground">Duration:</span>
						<span class="ml-1 font-mono font-medium">{formatDuration(trace.totalDuration)}</span>
					</div>
					<div>
						<span class="text-muted-foreground">Spans:</span>
						<span class="ml-1 font-medium">{filteredSpans.length} of {trace.spans.length}</span>
					</div>
					<div>
						<span class="text-muted-foreground">Started:</span>
						<span class="ml-1">{formatTime(trace.startTime)}</span>
					</div>
					<div class="flex items-center gap-2">
						<span class="text-muted-foreground">Services:</span>
						{#each [...new Set(trace.spans.map((s) => s.serviceName))] as svc}
							<Badge variant="outline" class="text-[10px]">
								<span class="mr-1 inline-block h-2 w-2 rounded-full {serviceColor(svc)}"></span>
								{svc}
							</Badge>
						{/each}
					</div>
					<div class="ml-auto flex items-center rounded-md border border-border p-0.5">
						<button
							class={`rounded px-2 py-1 text-xs transition-colors ${traceFilter === 'all' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
							onclick={() => {
								traceFilter = 'all';
							}}
						>
							All
						</button>
						<button
							class={`rounded px-2 py-1 text-xs transition-colors ${traceFilter === 'llm' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
							onclick={() => {
								traceFilter = 'llm';
							}}
						>
							LLM
							<span class="ml-1 text-[10px] text-muted-foreground">{llmSpanCount}</span>
						</button>
					</div>
				</div>
			</div>

			<Tabs value={traceDetailTab} onValueChange={(value) => (traceDetailTab = value as 'spans' | 'logs')}>
				<TabsList class="mx-6 mt-4">
					<TabsTrigger value="spans">Spans</TabsTrigger>
					<TabsTrigger value="logs">Logs</TabsTrigger>
				</TabsList>

				<TabsContent value="spans" class="mt-0">
					<div class="divide-y divide-border">
						{#if filteredSpans.length === 0}
							<div class="px-6 py-10 text-center text-sm text-muted-foreground">
								No LLM-related spans found in this trace.
							</div>
						{:else}
						{#each filteredSpans as span (span.spanId)}
							<div>
								<button
									onclick={() => toggleSpan(span.spanId)}
									class={`flex w-full items-start gap-2 px-6 py-2 text-left transition-colors ${selectedSpanId === span.spanId ? 'bg-accent/40' : 'hover:bg-accent/30'}`}
								>
									<div class="w-[340px] flex-shrink-0" style="padding-left: {span.depth * 16}px">
										<div class="flex items-center gap-1.5">
											{#if span.status === 'error'}
												<XCircle size={12} class="flex-shrink-0 text-red-500" />
											{:else}
												<CheckCircle2 size={12} class="flex-shrink-0 text-green-500" />
											{/if}
											<span class="truncate text-xs font-medium">{span.operationName}</span>
										</div>
										<div class="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground" style="padding-left: 18px">
											<span class="inline-block h-1.5 w-1.5 rounded-full {serviceColor(span.serviceName)}"></span>
											<span>{span.serviceName}</span>
											<span class="font-mono">{formatDuration(span.duration)}</span>
										</div>
									</div>

									<div class="relative flex-1 h-8">
										<div class="absolute inset-y-0 left-0 right-0 flex items-center">
											<div class="relative h-3 w-full rounded-sm bg-muted/30">
												<div
													class="absolute top-0 h-full rounded-sm {serviceColor(span.serviceName)} opacity-80"
													style="left: {barOffset(span)}%; width: {barWidth(span)}%"
												></div>
											</div>
										</div>
									</div>
								</button>

								{#if expandedSpans.has(span.spanId)}
									<div class="border-t border-border/50 bg-muted/20 px-6 py-3" style="padding-left: {span.depth * 16 + 24 + 18}px">
										<div class="text-[10px] font-medium text-muted-foreground mb-1.5">Span ID: <span class="font-mono">{span.spanId}</span></div>
										{#if Object.keys(span.attributes ?? {}).length > 0 || Object.keys(span.resourceAttributes ?? {}).length > 0}
											<Table class="text-[11px]">
												<TableBody>
													{#each Object.entries(span.attributes ?? {}) as [key, value]}
														<TableRow>
															<TableCell class="pr-3 py-0.5 text-muted-foreground align-top">{key}</TableCell>
															<TableCell class="py-0.5 font-mono break-all">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</TableCell>
														</TableRow>
													{/each}
													{#each Object.entries(span.resourceAttributes ?? {}) as [key, value]}
														<TableRow>
															<TableCell class="pr-3 py-0.5 text-muted-foreground align-top">resource.{key}</TableCell>
															<TableCell class="py-0.5 font-mono break-all">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</TableCell>
														</TableRow>
													{/each}
												</TableBody>
											</Table>
										{:else}
											<div class="text-[11px] text-muted-foreground">No attributes</div>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
						{/if}
					</div>
				</TabsContent>

				<TabsContent value="logs" class="px-6 py-4">
					<OTelLogList
						logs={traceLogs}
						isLoading={traceLogsLoading}
						error={traceLogsError}
						selectedSpan={selectedSpan}
						emptyMessage="No observability logs found for this trace."
					/>
				</TabsContent>
			</Tabs>
		{/if}
	</div>
</div>
