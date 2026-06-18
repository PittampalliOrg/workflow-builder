<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type {
		ObservabilityAgentDecisionTurn,
		ObservabilityLlmMessage,
		ObservabilityLlmSpan,
		ObservabilityLogEntry,
		ObservabilityToolSpan,
		ObservabilityTraceSpan
	} from '$lib/types/observability';
	import { resolveSpanKind, SPAN_KIND_STYLE, ERROR_STYLE, formatDuration } from './span-kind';

	type EvidenceTab = 'overview' | 'logs' | 'llm' | 'tools' | 'raw';
	type ViewMode = 'pretty' | 'json' | 'raw';

	interface Props {
		span: ObservabilityTraceSpan | null;
		selectedDecision?: ObservabilityAgentDecisionTurn | null;
		selectedLog?: ObservabilityLogEntry | null;
		logs?: ObservabilityLogEntry[];
		llmSpans?: ObservabilityLlmSpan[];
		toolSpans?: ObservabilityToolSpan[];
		externalTab?: EvidenceTab | null;
	}

	let {
		span,
		selectedDecision = null,
		selectedLog = null,
		logs = [],
		llmSpans = [],
		toolSpans = [],
		externalTab = null
	}: Props = $props();

	let internalTab = $state<EvidenceTab>('overview');
	const activeTab = $derived(externalTab ?? internalTab);

	// Per-section render mode (Pretty / JSON / Raw) — the Braintrust pattern.
	let llmView = $state<ViewMode>('pretty');
	let toolView = $state<ViewMode>('pretty');

	$effect(() => {
		if (externalTab) return;
		if (!span) { internalTab = 'overview'; return; }
		if (llmSpans.length > 0) internalTab = 'llm';
		else if (toolSpans.length > 0) internalTab = 'tools';
		else if (logs.length > 0) internalTab = 'logs';
		else internalTab = 'overview';
	});

	const kindStyle = $derived(span ? (span.status === 'error' ? ERROR_STYLE : SPAN_KIND_STYLE[resolveSpanKind(span)]) : null);
	const kindMeta = $derived(span ? SPAN_KIND_STYLE[resolveSpanKind(span)] : null);

	function formatTimestamp(value: string | null | undefined): string {
		if (!value) return 'n/a';
		return new Date(value).toLocaleString(undefined, {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
			second: '2-digit', fractionalSecondDigits: 3
		});
	}

	/** Render a value per the chosen view mode (best-effort JSON parse for strings). */
	function render(value: unknown, mode: ViewMode): string {
		if (mode === 'raw') return typeof value === 'string' ? value : JSON.stringify(value);
		if (typeof value === 'string') {
			const t = value.trim();
			if ((t.startsWith('{') || t.startsWith('[')) && mode !== 'pretty') {
				try { return JSON.stringify(JSON.parse(t), null, 2); } catch { /* fall through */ }
			}
			if (mode === 'json') return JSON.stringify(value);
			return value;
		}
		return JSON.stringify(value, null, 2);
	}

	function roleStyle(role: string): string {
		if (role === 'assistant') return 'border-cyan-500/30 bg-cyan-500/[0.06] text-cyan-200';
		if (role === 'system') return 'border-violet-500/30 bg-violet-500/[0.06] text-violet-200';
		if (role === 'tool') return 'border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-200';
		if (role === 'user') return 'border-white/15 bg-white/[0.04] text-zinc-200';
		return 'border-white/10 bg-white/[0.03] text-zinc-300';
	}

	function messageText(message: ObservabilityLlmMessage, mode: ViewMode): string {
		if (mode === 'raw' || mode === 'json') return render(message, mode);
		if (message.content?.trim()) return message.content.trim();
		if (message.toolCalls?.length) {
			return message.toolCalls
				.map((tc) => `→ ${tc.function?.name ?? tc.id}(${tc.function?.arguments ?? ''})`)
				.join('\n');
		}
		return '(empty)';
	}

	// Important-attributes-first: float the keys that matter to the top.
	const ATTR_PRIORITY = [
		'openinference.span.kind', 'llm.model_name', 'gen_ai.request.model', 'gen_ai.response.model',
		'tool.name', 'session.id', 'workflow.execution.id', 'workflow.node.id',
		'http.method', 'http.route', 'http.target', 'http.status_code', 'rpc.method', 'error', 'exception.message'
	];
	function sortedAttributes(source: Record<string, unknown> | null | undefined): Array<[string, string]> {
		const entries = Object.entries(source ?? {}).map(
			([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string]
		);
		return entries.sort((a, b) => {
			const ia = ATTR_PRIORITY.indexOf(a[0]);
			const ib = ATTR_PRIORITY.indexOf(b[0]);
			if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
			return a[0].localeCompare(b[0]);
		});
	}

	const viewModes: ViewMode[] = ['pretty', 'json', 'raw'];
</script>

{#snippet viewToggle(current: ViewMode, set: (m: ViewMode) => void)}
	<div class="flex items-center rounded-md border border-white/10 bg-white/5 p-0.5">
		{#each viewModes as m (m)}
			<button
				class="rounded px-1.5 py-0.5 text-[10px] capitalize transition-colors {current === m ? 'bg-white/15 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}"
				onclick={() => set(m)}
			>{m}</button>
		{/each}
	</div>
{/snippet}

<aside class="bg-[#0b0c0e]">
	{#if !span}
		<div class="flex min-h-[400px] flex-col items-center justify-center px-6 py-10 text-center">
			<p class="font-mono text-sm text-zinc-300">No span selected</p>
			<p class="mt-2 max-w-[26ch] text-xs leading-6 text-zinc-500">
				Select a span in the waterfall to inspect its attributes, LLM messages, tool calls, and logs.
			</p>
		</div>
	{:else}
		<!-- Span-kind header -->
		<div class="border-b border-white/10 px-4 py-3">
			<div class="flex items-center gap-2">
				{#if kindMeta}
					{@const Icon = kindMeta.icon}
					<span class="flex size-6 items-center justify-center rounded-md {kindStyle?.bg} ring-1 ring-inset {kindStyle?.border}">
						<Icon size={13} class={kindStyle?.text} />
					</span>
					<span class="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide {kindStyle?.bg} {kindStyle?.text}">{kindMeta.label}</span>
				{/if}
				<span class="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{span.serviceName}</span>
				<Badge variant={span.status === 'error' ? 'destructive' : 'secondary'} class="text-[10px]">{span.status}</Badge>
				<span class="ml-auto font-mono text-[11px] tabular-nums text-zinc-400">{formatDuration(span.duration)}</span>
			</div>
			<h3 class="mt-2 break-all font-mono text-[13.5px] font-semibold text-zinc-50">{span.operationName}</h3>
			<p class="mt-1 text-[11px] text-zinc-500">{formatTimestamp(span.startTime)}</p>
		</div>

		{#if !externalTab}
			<div class="border-b border-white/10 px-3 py-2">
				<div class="flex flex-wrap items-center gap-1">
					{#each ['overview', 'logs', 'llm', 'tools', 'raw'] as tab (tab)}
						<button
							class={`rounded-md px-2.5 py-1 text-[11px] capitalize transition-colors ${activeTab === tab ? 'bg-white/10 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'}`}
							onclick={() => (internalTab = tab as EvidenceTab)}
						>{tab === 'llm' ? 'LLM' : tab}</button>
					{/each}
				</div>
			</div>
		{/if}

		<div class="{externalTab ? '' : 'max-h-[640px]'} overflow-auto px-4 py-3">
			{#if activeTab === 'overview'}
				<div class="space-y-4">
					<div class="grid gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] p-3 font-mono text-[11px] text-zinc-300">
						<div class="grid grid-cols-[64px_1fr] gap-2"><span class="text-zinc-500">Trace</span><span class="break-all">{span.traceId}</span></div>
						<div class="grid grid-cols-[64px_1fr] gap-2"><span class="text-zinc-500">Span</span><span class="break-all">{span.spanId}</span></div>
						<div class="grid grid-cols-[64px_1fr] gap-2"><span class="text-zinc-500">Parent</span><span class="break-all">{span.parentSpanId ?? 'root'}</span></div>
					</div>

					{#if selectedDecision}
						<div class="rounded-xl border border-cyan-500/20 bg-cyan-500/[0.06] p-3">
							<p class="text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">Agent turn {selectedDecision.turnIndex}</p>
							<p class="mt-1.5 text-[12px] text-zinc-200">{selectedDecision.decisionLabel}</p>
							{#if selectedDecision.stopReason}<p class="mt-1 text-[11px] text-zinc-500">stop: {selectedDecision.stopReason}</p>{/if}
						</div>
					{/if}

					<div>
						<p class="mb-2 text-[10px] uppercase tracking-[0.18em] text-zinc-500">Attributes</p>
						<div class="space-y-1 rounded-xl border border-white/10 bg-white/[0.03] p-3 font-mono text-[11px]">
							{#each sortedAttributes(span.attributes) as [k, v] (k)}
								<div class="grid grid-cols-[128px_1fr] gap-2">
									<span class="truncate text-zinc-500" title={k}>{k}</span>
									<span class="break-all text-zinc-300">{v}</span>
								</div>
							{:else}
								<p class="text-zinc-600">No attributes captured.</p>
							{/each}
						</div>
					</div>
				</div>
			{:else if activeTab === 'logs'}
				{#if logs.length === 0}
					<div class="py-10 text-center text-sm text-zinc-500">No logs attached to this span.</div>
				{:else}
					<div class="space-y-2.5">
						{#each logs as log, index (`${log.timestamp}:${index}`)}
							<div class="rounded-xl border border-white/10 bg-white/[0.03] p-3">
								<div class="flex flex-wrap items-center gap-2">
									<span class="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{log.severityText || 'INFO'}</span>
									<span class="font-mono text-[11px] text-zinc-500">{formatTimestamp(log.timestamp)}</span>
								</div>
								<pre class="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] leading-6 text-zinc-100">{log.body}</pre>
							</div>
						{/each}
					</div>
				{/if}
			{:else if activeTab === 'llm'}
				{#if llmSpans.length === 0}
					<div class="py-10 text-center text-sm text-zinc-500">No LLM messages attached to this span.</div>
				{:else}
					<div class="space-y-4">
						{#each llmSpans as llmSpan (`${llmSpan.traceId}:${llmSpan.spanId}`)}
							<div>
								<div class="mb-2 flex flex-wrap items-center gap-1.5">
									<span class="rounded border border-cyan-500/25 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200">{[llmSpan.provider, llmSpan.modelName].filter(Boolean).join('/') || 'model'}</span>
									{#if llmSpan.totalTokens != null}<span class="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">{llmSpan.totalTokens} tok</span>{/if}
									{#if llmSpan.cacheReadInputTokens}<span class="rounded border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-200">cache HIT {llmSpan.cacheReadInputTokens}</span>{/if}
									{#if llmSpan.reasoningTokens}<span class="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">{llmSpan.reasoningTokens} reason</span>{/if}
									{#if llmSpan.finishReason}<span class="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">{llmSpan.finishReason}</span>{/if}
									<span class="ml-auto">{@render viewToggle(llmView, (m) => (llmView = m))}</span>
								</div>
								<div class="space-y-2">
									{#each [...llmSpan.inputMessages, ...llmSpan.outputMessages] as message, index (`${llmSpan.spanId}:${index}`)}
										<div class="rounded-xl border p-2.5 {roleStyle(message.role)}">
											<div class="mb-1.5 flex items-center gap-2">
												<span class="font-mono text-[10px] font-semibold uppercase tracking-wide opacity-80">{message.role}</span>
												{#if message.name}<span class="font-mono text-[10px] opacity-60">{message.name}</span>{/if}
											</div>
											<pre class="whitespace-pre-wrap break-words font-mono text-[12px] leading-6 text-zinc-100">{messageText(message, llmView)}</pre>
										</div>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			{:else if activeTab === 'tools'}
				{#if toolSpans.length === 0}
					<div class="py-10 text-center text-sm text-zinc-500">No tool calls attached to this span.</div>
				{:else}
					<div class="space-y-4">
						{#each toolSpans as toolSpan (`${toolSpan.traceId}:${toolSpan.spanId}`)}
							<div class="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-3">
								<div class="flex flex-wrap items-center gap-1.5">
									<span class="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200">{toolSpan.toolName}</span>
									<span class="rounded border px-1.5 py-0.5 font-mono text-[10px] {toolSpan.statusCode === 'Error' ? 'border-red-500/30 bg-red-500/10 text-red-200' : 'border-white/10 bg-white/5 text-zinc-300'}">{toolSpan.statusCode}</span>
									<span class="ml-auto">{@render viewToggle(toolView, (m) => (toolView = m))}</span>
								</div>
								<div class="mt-2.5 space-y-2.5">
									<div>
										<p class="mb-1 text-[10px] uppercase tracking-[0.18em] text-zinc-500">Arguments</p>
										<pre class="overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-2.5 font-mono text-[11px] leading-5 text-zinc-200">{render(toolSpan.toolArguments, toolView)}</pre>
									</div>
									<div>
										<p class="mb-1 text-[10px] uppercase tracking-[0.18em] text-zinc-500">Result</p>
										<pre class="overflow-x-auto rounded-lg border border-white/10 bg-black/30 p-2.5 font-mono text-[11px] leading-5 text-zinc-200">{render(toolSpan.toolResult, toolView)}</pre>
									</div>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			{:else}
				<pre class="overflow-x-auto rounded-xl border border-white/10 bg-black/50 p-3 font-mono text-[11px] leading-5 text-zinc-100">{JSON.stringify({ span, llmSpans, toolSpans, logs }, null, 2)}</pre>
			{/if}
		</div>
	{/if}
</aside>
