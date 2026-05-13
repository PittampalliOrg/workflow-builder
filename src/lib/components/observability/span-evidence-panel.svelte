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

	type EvidenceTab = 'overview' | 'logs' | 'llm' | 'tools' | 'raw';

	interface Props {
		span: ObservabilityTraceSpan | null;
		selectedDecision?: ObservabilityAgentDecisionTurn | null;
		selectedLog?: ObservabilityLogEntry | null;
		logs?: ObservabilityLogEntry[];
		llmSpans?: ObservabilityLlmSpan[];
		toolSpans?: ObservabilityToolSpan[];
		/** When set, hides the internal tab bar and uses this tab instead */
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

	$effect(() => {
		if (externalTab) return; // skip if controlled externally
		if (!span) { internalTab = 'overview'; return; }
		if (llmSpans.length > 0) internalTab = 'llm';
		else if (toolSpans.length > 0) internalTab = 'tools';
		else if (logs.length > 0) internalTab = 'logs';
		else internalTab = 'overview';
	});

	function formatTimestamp(value: string | null | undefined): string {
		if (!value) return 'n/a';
		return new Date(value).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			fractionalSecondDigits: 3
		});
	}

	function formatDuration(value: number | null | undefined): string {
		if (value == null || !Number.isFinite(value)) return 'n/a';
		if (value < 1000) return `${Math.round(value)}ms`;
		return `${(value / 1000).toFixed(2)}s`;
	}

	function stringify(value: unknown): string {
		return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	}

	function roleTone(role: string): string {
		if (role === 'assistant') return 'bg-cyan-500/15 text-cyan-100';
		if (role === 'system') return 'bg-orange-500/15 text-orange-100';
		if (role === 'tool') return 'bg-emerald-500/15 text-emerald-100';
		return 'bg-white/5 text-zinc-300';
	}

	function summarizeMessage(message: ObservabilityLlmMessage): string {
		if (message.content?.trim()) return message.content.trim();
		if (message.toolCalls?.length) {
			return message.toolCalls
				.map((toolCall) => toolCall.function?.name ?? toolCall.id)
				.filter(Boolean)
				.join(', ');
		}
		return '(empty)';
	}

	function attributeEntries(source: Record<string, unknown> | null | undefined): Array<[string, string]> {
		return Object.entries(source ?? {})
			.map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)] as [string, string])
			.slice(0, 18);
	}
</script>

<aside class="{externalTab ? '' : 'rounded-[24px] border border-white/10 shadow-[0_14px_38px_rgba(0,0,0,0.24)]'} bg-[linear-gradient(180deg,rgba(15,15,19,0.98),rgba(9,9,12,0.98))]">
	{#if !span}
		<div class="flex min-h-[640px] flex-col items-center justify-center px-6 py-10 text-center">
			<p class="font-mono text-sm text-zinc-200">No span selected</p>
			<p class="mt-2 max-w-[26ch] text-sm leading-6 text-zinc-500">
				Select a span or correlated log to inspect exact telemetry, related LLM turns, tool calls, and raw attributes.
			</p>
		</div>
	{:else}
		<div class="border-b border-white/10 px-4 py-4">
			<div class="flex flex-wrap items-center gap-2">
				<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
					{span.serviceName}
				</Badge>
				<Badge variant={span.status === 'error' ? 'destructive' : 'secondary'} class="text-[10px]">
					{span.status}
				</Badge>
				{#if llmSpans.length > 0}
					<Badge variant="outline" class="border-cyan-500/20 bg-cyan-500/10 text-[10px] text-cyan-100">
						LLM {llmSpans.length}
					</Badge>
				{/if}
				{#if toolSpans.length > 0}
					<Badge variant="outline" class="border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-100">
						Tools {toolSpans.length}
					</Badge>
				{/if}
				{#if logs.length > 0}
					<Badge variant="outline" class="border-amber-500/20 bg-amber-500/10 text-[10px] text-amber-100">
						Logs {logs.length}
					</Badge>
				{/if}
			</div>
			<h3 class="mt-3 break-all font-mono text-[15px] font-semibold text-zinc-50">{span.operationName}</h3>
			<p class="mt-2 text-[11px] text-zinc-500">
				{formatTimestamp(span.startTime)} · {formatDuration(span.duration)}
			</p>
		</div>

		{#if !externalTab}
			<div class="border-b border-white/10 px-3 py-2">
				<div class="flex flex-wrap items-center gap-2">
					{#each ['overview', 'logs', 'llm', 'tools', 'raw'] as tab}
						<button
							class={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${activeTab === tab ? 'bg-white/10 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'}`}
							onclick={() => (internalTab = tab as EvidenceTab)}
						>
							{tab}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<div class="{externalTab ? '' : 'max-h-[640px]'} overflow-auto px-4 py-4">
			{#if activeTab === 'overview'}
				<div class="space-y-4">
					<div class="grid gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3 font-mono text-[11px] text-zinc-300">
						<div class="grid grid-cols-[88px_1fr] gap-2"><span class="text-zinc-500">Trace</span><span class="break-all">{span.traceId}</span></div>
						<div class="grid grid-cols-[88px_1fr] gap-2"><span class="text-zinc-500">Span</span><span class="break-all">{span.spanId}</span></div>
						<div class="grid grid-cols-[88px_1fr] gap-2"><span class="text-zinc-500">Parent</span><span class="break-all">{span.parentSpanId ?? 'none'}</span></div>
						<div class="grid grid-cols-[88px_1fr] gap-2"><span class="text-zinc-500">Kind</span><span>{span.spanKind ?? 'span'}</span></div>
						<div class="grid grid-cols-[88px_1fr] gap-2"><span class="text-zinc-500">Status</span><span>{span.status}</span></div>
					</div>

					{#if selectedDecision}
						<div class="rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.08] p-3">
							<p class="text-[11px] uppercase tracking-[0.2em] text-cyan-200">Decision</p>
							<div class="mt-3 grid gap-2 font-mono text-[11px] text-zinc-200">
								<div class="grid grid-cols-[96px_1fr] gap-2"><span class="text-zinc-500">Turn</span><span>{selectedDecision.turnIndex}</span></div>
								<div class="grid grid-cols-[96px_1fr] gap-2"><span class="text-zinc-500">Type</span><span>{selectedDecision.decisionType}</span></div>
								<div class="grid grid-cols-[96px_1fr] gap-2"><span class="text-zinc-500">Label</span><span>{selectedDecision.decisionLabel}</span></div>
								{#if selectedDecision.stopReason}
									<div class="grid grid-cols-[96px_1fr] gap-2"><span class="text-zinc-500">Stop</span><span>{selectedDecision.stopReason}</span></div>
								{/if}
							</div>
						</div>
					{/if}

					{#if selectedLog}
						<div class="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3">
							<p class="text-[11px] uppercase tracking-[0.2em] text-amber-200">Selected log</p>
							<p class="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] leading-6 text-zinc-100">{selectedLog.body}</p>
						</div>
					{/if}

					<div>
						<p class="mb-2 text-[11px] uppercase tracking-[0.2em] text-zinc-500">Attributes</p>
						<div class="space-y-1 rounded-2xl border border-white/10 bg-white/[0.03] p-3 font-mono text-[11px]">
							{#each attributeEntries(span.attributes) as [key, value]}
								<div class="grid grid-cols-[132px_1fr] gap-2">
									<span class="text-zinc-500">{key}</span>
									<span class="break-all text-zinc-300">{value}</span>
								</div>
							{/each}
						</div>
					</div>
				</div>
			{:else if activeTab === 'logs'}
				{#if logs.length === 0}
					<div class="py-10 text-center text-sm text-zinc-500">No logs are attached to this span.</div>
				{:else}
					<div class="space-y-3">
						{#each logs as log, index (`${log.timestamp}:${index}`)}
							<div class={`rounded-2xl border p-3 ${selectedLog && selectedLog.timestamp === log.timestamp && selectedLog.body === log.body ? 'border-amber-500/20 bg-amber-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
								<div class="flex flex-wrap items-center gap-2">
									<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
										{log.serviceName}
									</Badge>
									<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
										{log.severityText || 'INFO'}
									</Badge>
									<span class="font-mono text-[11px] text-zinc-500">{formatTimestamp(log.timestamp)}</span>
								</div>
								<pre class="mt-3 whitespace-pre-wrap break-words font-mono text-[12px] leading-6 text-zinc-100">{log.body}</pre>
							</div>
						{/each}
					</div>
				{/if}
			{:else if activeTab === 'llm'}
				{#if llmSpans.length === 0}
					<div class="py-10 text-center text-sm text-zinc-500">No LLM turns are attached to this span.</div>
				{:else}
					<div class="space-y-4">
						{#each llmSpans as llmSpan (`${llmSpan.traceId}:${llmSpan.spanId}`)}
							<div class="rounded-2xl border border-cyan-500/20 bg-cyan-500/[0.06] p-3">
								<div class="flex flex-wrap items-center gap-2">
									<Badge variant="outline" class="border-cyan-500/20 bg-cyan-500/10 text-[10px] text-cyan-100">
										{[llmSpan.provider, llmSpan.modelName].filter(Boolean).join('/')}
									</Badge>
									{#if llmSpan.totalTokens != null}
										<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
											{llmSpan.totalTokens} tokens
										</Badge>
									{/if}
									{#if llmSpan.cacheReadInputTokens}
										<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
											{llmSpan.cacheReadInputTokens} cache-read
										</Badge>
									{/if}
									{#if llmSpan.cacheCreationInputTokens}
										<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
											{llmSpan.cacheCreationInputTokens} cache-write
										</Badge>
									{/if}
									{#if llmSpan.reasoningTokens}
										<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
											{llmSpan.reasoningTokens} reasoning
										</Badge>
									{/if}
									{#if llmSpan.finishReason}
										<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
											{llmSpan.finishReason}
										</Badge>
									{/if}
								</div>

								<div class="mt-3 space-y-3">
									{#each [...llmSpan.inputMessages, ...llmSpan.outputMessages] as message, index (`${llmSpan.spanId}:${index}`)}
										<div class="rounded-xl border border-white/10 bg-black/20 p-3">
											<div class="flex items-center gap-2">
												<span class={`inline-flex rounded-full px-2 py-0.5 font-mono text-[10px] ${roleTone(message.role)}`}>{message.role}</span>
											</div>
											<pre class="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] leading-6 text-zinc-100">{summarizeMessage(message)}</pre>
										</div>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			{:else if activeTab === 'tools'}
				{#if toolSpans.length === 0}
					<div class="py-10 text-center text-sm text-zinc-500">No tool calls are attached to this span.</div>
				{:else}
					<div class="space-y-4">
						{#each toolSpans as toolSpan (`${toolSpan.traceId}:${toolSpan.spanId}`)}
							<div class="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
								<div class="flex flex-wrap items-center gap-2">
									<Badge variant="outline" class="border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-100">
										{toolSpan.toolName}
									</Badge>
									<Badge variant="outline" class="border-white/10 bg-white/5 font-mono text-[10px] text-zinc-300">
										{toolSpan.statusCode}
									</Badge>
								</div>
								<div class="mt-3 grid gap-3">
									<div>
										<p class="mb-2 text-[11px] uppercase tracking-[0.2em] text-zinc-500">Arguments</p>
										<pre class="overflow-x-auto rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-[11px] text-zinc-200">{stringify(toolSpan.toolArguments)}</pre>
									</div>
									<div>
										<p class="mb-2 text-[11px] uppercase tracking-[0.2em] text-zinc-500">Result</p>
										<pre class="overflow-x-auto rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-[11px] text-zinc-200">{stringify(toolSpan.toolResult)}</pre>
									</div>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			{:else}
				<pre class="overflow-x-auto rounded-2xl border border-white/10 bg-black/70 p-3 font-mono text-[11px] leading-6 text-zinc-100">{stringify({
	span,
	selectedLog,
	llmSpans,
	toolSpans,
	logs
})}</pre>
			{/if}
		</div>
	{/if}
</aside>
