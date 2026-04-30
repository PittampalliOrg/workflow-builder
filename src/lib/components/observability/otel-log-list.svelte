<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Loader2, CircleAlert, ChevronDown, ChevronRight } from '@lucide/svelte';

	export interface ObservabilityLogEntry {
		timestamp: string;
		traceId: string;
		spanId: string;
		serviceName: string;
		severityText: string;
		body: string;
		resourceAttributes: Record<string, unknown>;
		logAttributes: Record<string, unknown>;
	}

	interface Props {
		logs: ObservabilityLogEntry[];
		isLoading?: boolean;
		error?: string | null;
		selectedSpan?: { traceId: string; spanId: string; label?: string | null } | null;
		emptyMessage?: string;
	}

	let {
		logs,
		isLoading = false,
		error = null,
		selectedSpan = null,
		emptyMessage = 'No observability logs found.'
	}: Props = $props();

	type LogFilterMode = 'all' | 'llm' | 'errors';
	let filterMode = $state<LogFilterMode>('all');
	let serviceFilter = $state('all');
	let expanded = $state<Set<string>>(new Set());

	function severityVariant(severityText: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		const normalized = severityText.toLowerCase();
		if (normalized.includes('error') || normalized.includes('fatal')) return 'destructive';
		if (normalized.includes('warn')) return 'outline';
		if (normalized.includes('debug') || normalized.includes('trace')) return 'secondary';
		return 'default';
	}

	function isLlmRelatedLog(log: ObservabilityLogEntry): boolean {
		const service = log.serviceName.toLowerCase();
		const body = log.body.toLowerCase();
		const records = [log.logAttributes, log.resourceAttributes];
		const signals = ['llm', 'gen_ai', 'openai', 'anthropic', 'model', 'callllm', 'responses'];
		if (signals.some((signal) => service.includes(signal) || body.includes(signal))) return true;

		for (const record of records) {
			for (const [key, value] of Object.entries(record ?? {})) {
				const normalizedKey = key.toLowerCase();
				const normalizedValue =
					typeof value === 'string' ? value.toLowerCase() : JSON.stringify(value).toLowerCase();
				if (signals.some((signal) => normalizedKey.includes(signal) || normalizedValue.includes(signal))) {
					return true;
				}
			}
		}

		return false;
	}

	function formatTimestamp(value: string): string {
		return new Date(value).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			fractionalSecondDigits: 3
		});
	}

	function toggleExpanded(key: string) {
		const next = new Set(expanded);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expanded = next;
	}

	const spanScopedLogs = $derived.by(() => {
		if (!selectedSpan) return logs;
		return logs.filter((log) => log.traceId === selectedSpan.traceId && log.spanId === selectedSpan.spanId);
	});

	const serviceOptions = $derived([...new Set(spanScopedLogs.map((log) => log.serviceName).filter(Boolean))]);
	const llmCount = $derived(spanScopedLogs.filter(isLlmRelatedLog).length);
	const errorCount = $derived(
		spanScopedLogs.filter((log) => {
			const severity = log.severityText.toLowerCase();
			return severity.includes('error') || severity.includes('fatal');
		}).length
	);

	const visibleLogs = $derived.by(() => {
		let next = spanScopedLogs;
		if (filterMode === 'llm') next = next.filter(isLlmRelatedLog);
		if (filterMode === 'errors') {
			next = next.filter((log) => {
				const severity = log.severityText.toLowerCase();
				return severity.includes('error') || severity.includes('fatal');
			});
		}
		if (serviceFilter !== 'all') next = next.filter((log) => log.serviceName === serviceFilter);
		return next;
	});
</script>

{#if isLoading}
	<div class="flex items-center justify-center py-12">
		<Loader2 size={24} class="animate-spin text-muted-foreground" />
	</div>
{:else if error}
	<Alert variant="destructive">
		<CircleAlert class="size-4" />
		<AlertDescription>{error}</AlertDescription>
	</Alert>
{:else}
	<div class="space-y-3">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="text-sm text-muted-foreground">
				{visibleLogs.length} of {spanScopedLogs.length} logs
				{#if selectedSpan}
					&middot; scoped to <span class="font-medium text-foreground">{selectedSpan.label ?? selectedSpan.spanId}</span>
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<div class="flex items-center rounded-md border border-border p-0.5">
					<button
						class={`rounded px-2 py-1 text-xs transition-colors ${filterMode === 'all' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
						onclick={() => {
							filterMode = 'all';
						}}
					>
						All
					</button>
					<button
						class={`rounded px-2 py-1 text-xs transition-colors ${filterMode === 'llm' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
						onclick={() => {
							filterMode = 'llm';
						}}
					>
						LLM
						<span class="ml-1 text-[10px] text-muted-foreground">{llmCount}</span>
					</button>
					<button
						class={`rounded px-2 py-1 text-xs transition-colors ${filterMode === 'errors' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
						onclick={() => {
							filterMode = 'errors';
						}}
					>
						Errors
						<span class="ml-1 text-[10px] text-muted-foreground">{errorCount}</span>
					</button>
				</div>
				<select
					class="h-8 rounded-md border border-border bg-background px-2 text-xs"
					bind:value={serviceFilter}
				>
					<option value="all">All services</option>
					{#each serviceOptions as service}
						<option value={service}>{service}</option>
					{/each}
				</select>
			</div>
		</div>

		{#if visibleLogs.length === 0}
			<div class="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
				{emptyMessage}
			</div>
		{:else}
			<div class="space-y-2">
				{#each visibleLogs as log, index (`${log.timestamp}-${log.traceId}-${log.spanId}-${index}`)}
					<button
						class="w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-muted/30 transition-colors"
						onclick={() => toggleExpanded(`${log.timestamp}-${log.traceId}-${log.spanId}-${index}`)}
					>
						<div class="flex flex-wrap items-start gap-2">
							<div class="min-w-[180px] text-[11px] text-muted-foreground">
								{formatTimestamp(log.timestamp)}
							</div>
							<Badge variant={severityVariant(log.severityText)} class="text-[10px]">
								{log.severityText || 'info'}
							</Badge>
							<Badge variant="outline" class="text-[10px]">{log.serviceName}</Badge>
							{#if selectedSpan && log.traceId === selectedSpan.traceId && log.spanId === selectedSpan.spanId}
								<Badge variant="secondary" class="text-[10px]">span</Badge>
							{/if}
							<div class="ml-auto flex items-center text-muted-foreground">
								{#if expanded.has(`${log.timestamp}-${log.traceId}-${log.spanId}-${index}`)}
									<ChevronDown size={14} />
								{:else}
									<ChevronRight size={14} />
								{/if}
							</div>
						</div>
						<p class="mt-2 whitespace-pre-wrap break-words text-sm">{log.body || '(empty log message)'}</p>

						{#if expanded.has(`${log.timestamp}-${log.traceId}-${log.spanId}-${index}`)}
							<div class="mt-3 grid gap-3 border-t border-border pt-3 text-[11px]">
								<div class="grid gap-1 text-muted-foreground">
									<div><span class="font-medium text-foreground">Trace:</span> <span class="font-mono">{log.traceId || 'none'}</span></div>
									<div><span class="font-medium text-foreground">Span:</span> <span class="font-mono">{log.spanId || 'none'}</span></div>
								</div>

								{#if Object.keys(log.logAttributes ?? {}).length > 0}
									<div>
										<p class="mb-1 font-medium text-foreground">Log attributes</p>
										<div class="space-y-1 font-mono text-[10px] text-muted-foreground">
											{#each Object.entries(log.logAttributes ?? {}) as [key, value]}
												<div class="break-all"><span class="text-foreground">{key}</span>: {typeof value === 'object' ? JSON.stringify(value) : String(value)}</div>
											{/each}
										</div>
									</div>
								{/if}

								{#if Object.keys(log.resourceAttributes ?? {}).length > 0}
									<div>
										<p class="mb-1 font-medium text-foreground">Resource attributes</p>
										<div class="space-y-1 font-mono text-[10px] text-muted-foreground">
											{#each Object.entries(log.resourceAttributes ?? {}) as [key, value]}
												<div class="break-all"><span class="text-foreground">{key}</span>: {typeof value === 'object' ? JSON.stringify(value) : String(value)}</div>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}
