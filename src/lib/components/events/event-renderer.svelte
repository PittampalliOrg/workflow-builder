<script lang="ts">
	import { eventKindFor } from '$lib/components/sessions/event-type-pill.svelte';
	import { Reasoning, ReasoningTrigger, ReasoningContent } from '$lib/components/ui/ai-elements/reasoning';
	import Response from '$lib/components/ui/ai-elements/response/Response.svelte';
	import ProviderIcon from '$lib/components/ui/ai-elements/provider-icon.svelte';
	import JsonView from '$lib/components/sessions/json-view.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Task, TaskTrigger, TaskContent, TaskItem } from '$lib/components/ui/ai-elements/task';
	import {
		AlertTriangle,
		Bot,
		Cable,
		CheckCircle2,
		Download,
		Gauge,
		Loader2,
		ShieldCheck
	} from '@lucide/svelte';
	import ToolEventRenderer from './tool-event-renderer.svelte';
	import type { EventRendererVariant, RenderableEvent, RenderableToolPair } from './types';

	interface Props {
		event: RenderableEvent;
		/** When the renderer is given a single event but a paired event is
		 *  available, pass it here so tool_use + tool_result render together. */
		pairedResult?: RenderableEvent | null;
		variant?: EventRendererVariant;
		debug?: boolean;
		/** Avatar provider icon for agent.message in card variant. */
		agentModel?: string | null;
		hasFullPayload?: boolean;
		loadingFull?: boolean;
		onLoadFull?: () => void;
	}

	let {
		event,
		pairedResult = null,
		variant = 'card',
		debug = false,
		agentModel = null,
		hasFullPayload = false,
		loadingFull = false,
		onLoadFull
	}: Props = $props();

	const kind = $derived(eventKindFor(event.type));

	const data = $derived(event.data as Record<string, unknown>);

	const textContent = $derived.by(() => {
		const content = (data.content as Array<{ text?: string; type?: string }>) ?? [];
		const joined = Array.isArray(content)
			? content
				.map((c) => (typeof c?.text === 'string' ? c.text : ''))
				.filter(Boolean)
				.join('\n\n')
			: '';
		if (joined) return joined;
		const preview = data.preview;
		return typeof preview === 'string' ? preview : '';
	});

	type LlmUsageData = {
		model?: string;
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
		context_window_size?: number;
		context_input_tokens?: number;
		context_used_percentage?: number;
		context_remaining_percentage?: number;
		context_effective_window?: number;
		context_auto_compact_threshold?: number;
		context_until_auto_compact_percentage?: number;
		ttft_ms?: number | null;
		recovery_attempts?: number;
		success?: boolean;
		error?: string;
	};
	type ContextUsageData = {
		model?: string;
		context_source?: string;
		context_count_method?: string;
		context_window_size?: number;
		context_input_tokens?: number;
		context_used_percentage?: number;
		context_remaining_percentage?: number;
		context_auto_compact_threshold?: number;
		context_until_auto_compact_percentage?: number;
		context_message_tokens?: number;
		context_system_tokens?: number;
		context_tool_tokens?: number;
		context_message_count?: number;
		context_system_message_count?: number;
		context_tool_count?: number;
		turn?: number;
		turnId?: string;
	};

	const llmUsage = $derived(event.type === 'agent.llm_usage' ? (data as LlmUsageData) : null);
	const contextUsage = $derived(
		event.type === 'agent.context_usage' ? (data as ContextUsageData) : null
	);
	const llmUsageHitPct = $derived.by(() => {
		const u = llmUsage;
		if (!u) return null;
		const r = Number(u.cache_read_input_tokens ?? 0);
		const i = Number(u.input_tokens ?? 0);
		const denom = r + i;
		if (denom <= 0) return null;
		return Math.round((r / denom) * 100);
	});
	const llmContextUsage = $derived.by(() => contextStatsFor(llmUsage));
	const activeContextUsage = $derived.by(() => contextStatsFor(contextUsage));

	function contextStatsFor(
		u:
			| {
					context_input_tokens?: number;
					context_window_size?: number;
					context_used_percentage?: number;
					context_auto_compact_threshold?: number;
					context_until_auto_compact_percentage?: number;
			  }
			| null
	) {
		if (!u) return null;
		const input = Number(u.context_input_tokens ?? 0);
		const window = Number(u.context_window_size ?? 0);
		if (u.context_used_percentage == null && !(input > 0 && window > 0)) return null;
		const used = percentFromRatio(input, window, Number(u.context_used_percentage ?? 0));
		const threshold = Number(u.context_auto_compact_threshold ?? 0);
		const untilCompact =
			threshold > 0
				? clampPercent(((threshold - input) / threshold) * 100)
				: Number(u.context_until_auto_compact_percentage ?? 0);
		return {
			used,
			remaining: clampPercent(100 - used),
			input,
			window,
			untilCompact
		};
	}

	function fmtTokens(n: number | undefined): string {
		const v = Number(n ?? 0);
		if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
		if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
		return String(v);
	}

	function clampPercent(value: number): number {
		if (!Number.isFinite(value)) return 0;
		return Math.max(0, Math.min(100, value));
	}

	function percentFromRatio(input: number, window: number, fallback: number): number {
		if (Number.isFinite(input) && Number.isFinite(window) && input >= 0 && window > 0) {
			return clampPercent((input / window) * 100);
		}
		return clampPercent(fallback);
	}

	function fmtPercent(value: number): string {
		const v = clampPercent(value);
		if (v > 0 && v < 10) return `${v.toFixed(1).replace(/\.0$/, '')}%`;
		return `${Math.round(v)}%`;
	}

	// For tool dispatch in panel variant, build the pair from event + pairedResult.
	const toolPair = $derived.by<RenderableToolPair>(() => {
		if (kind === 'tool') {
			return { start: event, end: pairedResult ?? undefined };
		}
		if (kind === 'result') {
			return { start: pairedResult ?? undefined, end: event };
		}
		return {};
	});
</script>

{#if debug}
	<div class="text-[10px] font-mono text-muted-foreground mb-2">{event.type}</div>
	<JsonView value={data} />
{:else if hasFullPayload && variant === 'panel'}
	{#if loadingFull}
		<div class="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
			<Loader2 class="size-3 animate-spin" />
			<span>Loading full payload…</span>
		</div>
	{:else if onLoadFull}
		<div class="mb-2 flex items-center gap-2 rounded border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
			<span class="flex-1">Preview shape only — auto-load did not complete.</span>
			<Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-[11px]" onclick={onLoadFull}>
				<Download class="size-3" />
				Retry
			</Button>
		</div>
	{/if}
	{@render bodyRender()}
{:else}
	{@render bodyRender()}
{/if}

{#snippet bodyRender()}
	{#if kind === 'user' || kind === 'agent'}
		{#if variant === 'panel'}
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Content</div>
			<div class="prose prose-sm dark:prose-invert mt-2 max-w-none">
				{#if textContent}
					<Response content={textContent} parseIncompleteMarkdown={true} />
				{:else}
					<span class="text-muted-foreground">(empty)</span>
				{/if}
			</div>
		{:else if textContent && textContent.trim()}
			<div class="flex items-start gap-3 rounded-lg border border-border/40 bg-muted/30 px-4 py-3">
				<div class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background">
					<ProviderIcon model={agentModel ?? undefined} size={18} />
				</div>
				<div class="prose prose-sm dark:prose-invert max-w-none flex-1 text-sm leading-relaxed">
					<Response content={textContent} parseIncompleteMarkdown={true} />
				</div>
			</div>
		{/if}

	{:else if kind === 'thinking'}
		{#if textContent && textContent.trim()}
			<Reasoning defaultOpen={variant === 'panel'}>
				<ReasoningTrigger />
				<ReasoningContent>{textContent}</ReasoningContent>
			</Reasoning>
		{:else if variant === 'panel'}
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Reasoning</div>
			<div class="mt-2 text-sm text-muted-foreground italic">(no thinking text captured)</div>
		{/if}

	{:else if kind === 'tool' || kind === 'result'}
		<ToolEventRenderer pair={toolPair} {variant} />

	{:else if contextUsage}
		<div class="space-y-3">
			<div class="flex items-center gap-2">
				<span class="text-[10px] uppercase tracking-wider text-muted-foreground">Active context</span>
				<code class="text-xs">{contextUsage.model ?? 'unknown'}</code>
			</div>
			{#if activeContextUsage}
				<div class="grid grid-cols-2 gap-3 text-xs">
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Used</div>
						<div class="mt-1 font-mono">{fmtPercent(activeContextUsage.used)}</div>
					</div>
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Until compact</div>
						<div class="mt-1 font-mono">{fmtPercent(activeContextUsage.untilCompact)}</div>
					</div>
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Messages</div>
						<div class="mt-1 font-mono">
							{contextUsage.context_message_count ?? 0}
							{#if (contextUsage.context_system_message_count ?? 0) > 0}
								<span class="text-muted-foreground"> + {contextUsage.context_system_message_count} system</span>
							{/if}
						</div>
					</div>
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Tools</div>
						<div class="mt-1 font-mono">{contextUsage.context_tool_count ?? 0}</div>
					</div>
				</div>
				<div class="rounded border border-border/40 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
					<span class="font-mono text-foreground">{fmtTokens(activeContextUsage.input)}</span>
					<span> / </span>
					<span class="font-mono text-foreground">{fmtTokens(activeContextUsage.window)}</span>
					<span> active tokens from </span>
					<span class="font-mono text-foreground">{contextUsage.context_count_method ?? 'local_advisory'}</span>
					<span>, </span>
					<span class="font-mono text-foreground">{fmtPercent(activeContextUsage.remaining)}</span>
					<span> remaining</span>
				</div>
			{/if}
			<div class="grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
				<div>Messages <span class="font-mono text-foreground">{fmtTokens(contextUsage.context_message_tokens)}</span></div>
				<div>System <span class="font-mono text-foreground">{fmtTokens(contextUsage.context_system_tokens)}</span></div>
				<div>Tools <span class="font-mono text-foreground">{fmtTokens(contextUsage.context_tool_tokens)}</span></div>
			</div>
		</div>

	{:else if llmUsage}
		<div class="space-y-3">
			<div class="flex items-center gap-2">
				<span class="text-[10px] uppercase tracking-wider text-muted-foreground">Model</span>
				<code class="text-xs">{llmUsage.model ?? 'unknown'}</code>
				{#if llmUsage.success === false}
					<span class="rounded bg-rose-500/20 px-1.5 py-0 text-[10px] text-rose-200">failed</span>
				{/if}
			</div>
			<div class="grid grid-cols-2 gap-3 text-xs">
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Input</div>
					<div class="mt-1 font-mono">{fmtTokens(llmUsage.input_tokens)}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Output</div>
					<div class="mt-1 font-mono">{fmtTokens(llmUsage.output_tokens)}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
						Cache read{#if llmUsageHitPct !== null} (hit {llmUsageHitPct}%){/if}
					</div>
					<div class="mt-1 font-mono">{fmtTokens(llmUsage.cache_read_input_tokens)}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Cache created</div>
					<div class="mt-1 font-mono">{fmtTokens(llmUsage.cache_creation_input_tokens)}</div>
				</div>
				{#if llmUsage.ttft_ms != null}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">TTFT</div>
						<div class="mt-1 font-mono">{Math.round(Number(llmUsage.ttft_ms))}ms</div>
					</div>
				{/if}
				{#if llmContextUsage}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Context</div>
						<div class="mt-1 font-mono">{fmtPercent(llmContextUsage.used)} used</div>
					</div>
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Until compact</div>
						<div class="mt-1 font-mono">{fmtPercent(llmContextUsage.untilCompact)}</div>
					</div>
				{/if}
				{#if (llmUsage.recovery_attempts ?? 0) > 0}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Recoveries</div>
						<div class="mt-1 font-mono">{llmUsage.recovery_attempts}</div>
					</div>
				{/if}
			</div>
			{#if llmContextUsage}
				<div class="rounded border border-border/40 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
					<span class="font-mono text-foreground">{fmtTokens(llmContextUsage.input)}</span>
					<span> / </span>
					<span class="font-mono text-foreground">{fmtTokens(llmContextUsage.window)}</span>
					<span> context tokens, </span>
					<span class="font-mono text-foreground">{fmtPercent(llmContextUsage.remaining)}</span>
					<span> remaining</span>
				</div>
			{/if}
			{#if llmUsage.error}
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Error</div>
					<div class="mt-1 whitespace-pre-wrap text-xs text-rose-300">{llmUsage.error}</div>
				</div>
			{/if}
		</div>

	{:else if event.type === 'hook.decision'}
		{@const d = data as {
			hook_event?: string;
			matcher?: string | null;
			hook_type?: string;
			plugin_id?: string | null;
			outcome?: string;
			decision?: string | null;
			duration_ms?: number;
			exit_code?: number | null;
			reason?: string | null;
		}}
		{#if variant === 'card'}
			<div class="flex items-center gap-2 rounded-md border border-indigo-500/25 bg-indigo-500/5 px-3 py-1.5 text-[11px]">
				<ShieldCheck class="size-3 text-indigo-400" />
				<span class="font-mono text-indigo-200">{d.hook_event ?? 'hook'}</span>
				{#if d.matcher}<span class="text-muted-foreground">({d.matcher})</span>{/if}
				<span>·</span>
				<span class="text-foreground/90">{d.decision ?? d.outcome ?? '?'}</span>
				{#if d.duration_ms != null}<span class="ml-auto font-mono text-muted-foreground">{d.duration_ms}ms</span>{/if}
			</div>
		{:else}
			<div class="grid grid-cols-2 gap-3 text-xs">
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Hook event</div>
					<div class="mt-1 font-mono">{d.hook_event ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Decision</div>
					<div class="mt-1 font-mono">{d.decision ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Matcher</div>
					<div class="mt-1 font-mono truncate">{d.matcher ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Type</div>
					<div class="mt-1 font-mono">{d.hook_type ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Outcome</div>
					<div class="mt-1 font-mono">{d.outcome ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Duration</div>
					<div class="mt-1 font-mono">{d.duration_ms ?? 0}ms</div>
				</div>
				{#if d.plugin_id}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Plugin</div>
						<div class="mt-1 font-mono truncate">{d.plugin_id}</div>
					</div>
				{/if}
				{#if d.exit_code != null}
					<div>
						<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Exit code</div>
						<div class="mt-1 font-mono">{d.exit_code}</div>
					</div>
				{/if}
			</div>
			{#if d.reason}
				<div class="mt-3">
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Reason</div>
					<div class="mt-1 whitespace-pre-wrap text-xs">{d.reason}</div>
				</div>
			{/if}
		{/if}

	{:else if event.type === 'mcp.tool_call'}
		{@const m = data as {
			tool_name?: string;
			server?: string | null;
			transport?: string | null;
			duration_ms?: number;
			success?: boolean;
			error?: string | null;
		}}
		{#if variant === 'card'}
			<div class="flex items-center gap-2 rounded-md border border-cyan-500/25 bg-cyan-500/5 px-3 py-1.5 text-[11px]">
				<Cable class="size-3 text-cyan-400" />
				<span class="font-mono text-cyan-200">{m.tool_name ?? 'tool'}</span>
				{#if m.server}<span class="text-muted-foreground">@{m.server}</span>{/if}
				{#if m.success === false}
					<Badge variant="outline" class="text-[9px] border-red-500/30 text-red-300">failed</Badge>
				{/if}
				{#if m.duration_ms != null}<span class="ml-auto font-mono text-muted-foreground">{m.duration_ms}ms</span>{/if}
			</div>
		{:else}
			<div class="grid grid-cols-2 gap-3 text-xs">
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Tool</div>
					<div class="mt-1 font-mono truncate">{m.tool_name ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Server</div>
					<div class="mt-1 font-mono truncate">{m.server ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Transport</div>
					<div class="mt-1 font-mono">{m.transport ?? '-'}</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Duration</div>
					<div class="mt-1 font-mono">{m.duration_ms ?? 0}ms</div>
				</div>
				<div>
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Status</div>
					<div class="mt-1 font-mono">{m.success === false ? 'failed' : 'ok'}</div>
				</div>
			</div>
			{#if m.error}
				<div class="mt-3">
					<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Error</div>
					<div class="mt-1 whitespace-pre-wrap text-xs text-rose-300">{m.error}</div>
				</div>
			{/if}
		{/if}

	{:else if kind === 'alert'}
		{@const alertData = data}
		<div class="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px]">
			<AlertTriangle class="mt-0.5 size-3.5 shrink-0 text-red-400" />
			<div class="min-w-0 flex-1">
				<div class="font-medium text-red-300">
					{event.type.replace(/^(agent|session)\./, '').replace(/_/g, ' ')}
				</div>
				{#if event.type === 'agent.circuit_breaker_tripped'}
					<div class="text-muted-foreground">Reason: {String(alertData.reason ?? '?')} ({alertData.streak ?? '?'}/{alertData.threshold ?? '?'})</div>
				{:else if event.type === 'session.turn_timeout'}
					<div class="text-muted-foreground">Turn {alertData.turn ?? '?'} exceeded {alertData.timeout_seconds ?? '?'}s</div>
				{:else if event.type === 'agent.thread_images_compacted'}
					<div class="text-muted-foreground">Collapsed {alertData.collapsed ?? '?'} screenshot(s); kept last {alertData.kept ?? '?'}</div>
				{:else if event.type === 'session.error'}
					<div class="whitespace-pre-wrap text-muted-foreground">{String(alertData.error ?? '').slice(0, 400)}</div>
				{/if}
			</div>
		</div>

	{:else if event.type === 'run_started' && variant === 'card'}
		<div class="flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-4 py-3">
			<Bot class="size-4 text-cyan-400" />
			<span class="text-sm font-medium text-cyan-400">Agent started</span>
			{#if data.model}
				<Badge variant="outline" class="ml-auto text-[10px]">{data.model}</Badge>
			{/if}
		</div>

	{:else if event.type === 'llm_complete' && variant === 'card'}
		{@const content = data.content ? String(data.content).trim() : ''}
		{#if content}
			<div class="flex items-start gap-3 rounded-lg border border-border/40 bg-muted/30 px-4 py-3">
				<div class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background">
					<ProviderIcon model={agentModel ?? undefined} size={18} />
				</div>
				<div class="prose prose-sm dark:prose-invert max-w-none flex-1 text-sm leading-relaxed">
					<Response content={content} parseIncompleteMarkdown={true} />
				</div>
			</div>
		{/if}

	{:else if event.type === 'run_complete' && variant === 'card'}
		<div class="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3">
			<CheckCircle2 class="size-4 text-green-400" />
			<span class="text-sm font-medium text-green-400">Agent completed</span>
		</div>

	{:else if event.type === 'run_error' && variant === 'card'}
		<Task open={true}>
			<TaskTrigger title="❌ Agent error" />
			<TaskContent>
				<TaskItem>
					<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all rounded-md border border-red-500/20 bg-red-500/5 p-3 text-[11px] font-mono text-red-400">{data.error ? String(data.error) : 'Unknown error'}</pre>
				</TaskItem>
			</TaskContent>
		</Task>

	{:else if event.type === 'llm_start'}
		<!-- Intentionally empty: tool_call_start events render their own cards. -->

	{:else}
		<JsonView value={data} />
	{/if}
{/snippet}
