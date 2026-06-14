<script lang="ts">
	/**
	 * Fleet row detail drawer — a live preview of "what's happening" inside a run
	 * without leaving the control plane. Kind-adaptive:
	 *   - session / benchmarkInstance → live session stream (pulse + recent events)
	 *   - workflowRun → live execution stream (stage, progress, steps, agent activity)
	 * Streams are created lazily ON OPEN and disposed on close/change, so an
	 * unopened drawer costs nothing.
	 */
	import * as Sheet from '$lib/components/ui/sheet';
	import { Badge } from '$lib/components/ui/badge';
	import { ExternalLink, Wrench, MessageSquare } from '@lucide/svelte';
	import { createSessionStream, type SessionStreamState } from '$lib/stores/session-stream.svelte';
	import { createExecutionStream, type ExecutionStreamState } from '$lib/stores/execution-stream.svelte';
	import EventRow from '$lib/components/sessions/event-row.svelte';
	import type { CapacityBusinessWorkItem } from '$lib/types/capacity';

	type Props = {
		open: boolean;
		item: CapacityBusinessWorkItem | null;
		onOpenChange: (next: boolean) => void;
	};
	let { open, item, onOpenChange }: Props = $props();

	const sessionId = $derived(
		item && (item.kind === 'session' || item.kind === 'benchmarkInstance') ? item.id : null
	);
	const executionId = $derived(item && item.kind === 'workflowRun' ? item.id : null);

	let sessionState = $state<SessionStreamState | null>(null);
	let execState = $state<ExecutionStreamState | null>(null);

	$effect(() => {
		if (!open || !sessionId) {
			sessionState = null;
			return;
		}
		const store = createSessionStream(sessionId);
		const unsub = store.subscribe((s) => (sessionState = s));
		return () => {
			unsub();
			store.dispose();
		};
	});
	$effect(() => {
		if (!open || !executionId) {
			execState = null;
			return;
		}
		const store = createExecutionStream(executionId);
		const unsub = store.subscribe((s) => (execState = s));
		return () => {
			unsub();
			store.dispose();
		};
	});

	const createdAtMs = $derived(
		sessionState?.session?.createdAt ? new Date(sessionState.session.createdAt).getTime() : null
	);
	const recentEvents = $derived((sessionState?.events ?? []).slice(-16).reverse());

	// Compact live vitals for the drawer. SessionPulse's grid is viewport-
	// responsive (too wide for a side drawer), so we compute the essentials from
	// the same event stream and render a drawer-fit 2-up grid; the full Pulse
	// lives one click away on the session detail page.
	let nowMs = $state(Date.now());
	$effect(() => {
		if (!open || !sessionId) return;
		const id = setInterval(() => (nowMs = Date.now()), 1000);
		return () => clearInterval(id);
	});
	function sumLlmUsage(field: string): number {
		let total = 0;
		for (const ev of sessionState?.events ?? []) {
			if (ev.type === 'agent.llm_usage') {
				const v = (ev.data as Record<string, unknown>)?.[field];
				if (typeof v === 'number') total += v;
			}
		}
		return total;
	}
	const tokensIn = $derived(sumLlmUsage('input_tokens'));
	const tokensOut = $derived(sumLlmUsage('output_tokens'));
	const llmCalls = $derived((sessionState?.events ?? []).filter((e) => e.type === 'agent.llm_usage').length);
	const turns = $derived((sessionState?.events ?? []).filter((e) => e.type === 'session.turn_started').length);
	const elapsedMs = $derived(createdAtMs ? Math.max(0, nowMs - createdAtMs) : null);
	const sessionLive = $derived(
		['running', 'rescheduling', 'idle', 'active', 'starting'].includes(
			(sessionState?.session?.status ?? '').toLowerCase()
		)
	);
	function fmtElapsed(ms: number | null): string {
		if (ms == null) return '—';
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${s % 60}s`;
		return `${Math.floor(m / 60)}h ${m % 60}m`;
	}

	const snapshot = $derived(execState?.snapshot ?? null);
	const recentSteps = $derived((snapshot?.steps ?? []).slice(-8).reverse());
	const recentAgentEvents = $derived((execState?.events ?? []).slice(-10).reverse());

	function kindLabel(kind: CapacityBusinessWorkItem['kind'] | undefined): string {
		if (kind === 'workflowRun') return 'Workflow';
		if (kind === 'benchmarkRun') return 'Benchmark';
		if (kind === 'benchmarkInstance') return 'Case';
		if (!kind) return '';
		return kind.charAt(0).toUpperCase() + kind.slice(1);
	}
	function statusTone(status: string | null | undefined): string {
		const s = (status ?? '').toLowerCase();
		if (s.includes('fail') || s.includes('error') || s.includes('timeout')) return 'text-rose-500';
		if (s.includes('terminat') || s.includes('cancel') || s === 'idle') return 'text-muted-foreground';
		if (s.includes('reschedul') || s.includes('queue') || s.includes('start') || s.includes('pend'))
			return 'text-sky-500';
		if (s.includes('run') || s === 'active' || s.includes('infer') || s.includes('evaluat'))
			return 'text-emerald-500';
		return 'text-foreground';
	}
	function stepTone(status: string): string {
		if (status === 'success') return 'bg-emerald-500';
		if (status === 'error') return 'bg-rose-500';
		if (status === 'running') return 'bg-sky-500 animate-pulse';
		return 'bg-muted-foreground/40';
	}
	function fmtDuration(ms: number | null | undefined): string {
		if (ms == null) return '';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.round(ms / 60_000)}m`;
	}
	function compact(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
		return `${n}`;
	}
	const detailLabel = $derived(item?.kind === 'workflowRun' ? 'run' : 'session');
</script>

<Sheet.Root {open} {onOpenChange}>
	<Sheet.Content side="right" class="flex w-full flex-col gap-0 p-0 sm:max-w-lg md:max-w-xl">
		{#if item}
			<Sheet.Header class="space-y-1 border-b px-4 py-3">
				<div class="flex min-w-0 items-center gap-2">
					<Badge variant="outline" class="shrink-0 text-[10px]">{kindLabel(item.kind)}</Badge>
					<Sheet.Title class="min-w-0 truncate text-sm">{item.title}</Sheet.Title>
				</div>
				<Sheet.Description class="flex items-center gap-2 text-xs">
					<span class="font-mono {statusTone(item.status)}">{item.status}</span>
					{#if item.model}<span class="truncate text-muted-foreground">{item.model}</span>{/if}
					{#if item.href}
						<a href={item.href} class="ml-auto inline-flex shrink-0 items-center gap-1 text-primary hover:underline">
							Open full {detailLabel}<ExternalLink class="size-3" />
						</a>
					{/if}
				</Sheet.Description>
			</Sheet.Header>

			<div class="flex-1 space-y-4 overflow-y-auto p-4">
				{#if sessionId}
					{#if sessionState}
						<div class="grid grid-cols-2 gap-2">
							<div class="rounded-md border bg-muted/20 px-3 py-2">
								<div class="text-[9px] uppercase tracking-wide text-muted-foreground">Tokens</div>
								<div class="font-mono text-base font-semibold leading-tight tabular-nums">{compact(tokensIn + tokensOut)}</div>
								<div class="text-[10px] text-muted-foreground">{compact(tokensIn)} in · {compact(tokensOut)} out</div>
							</div>
							<div class="rounded-md border bg-muted/20 px-3 py-2">
								<div class="text-[9px] uppercase tracking-wide text-muted-foreground">Turns</div>
								<div class="font-mono text-base font-semibold leading-tight tabular-nums">{turns}</div>
								<div class="text-[10px] text-muted-foreground">{llmCalls} LLM call{llmCalls === 1 ? '' : 's'}</div>
							</div>
							<div class="rounded-md border bg-muted/20 px-3 py-2">
								<div class="text-[9px] uppercase tracking-wide text-muted-foreground">Elapsed</div>
								<div class="flex items-center gap-1.5 font-mono text-base font-semibold leading-tight tabular-nums">
									{fmtElapsed(elapsedMs)}
									{#if sessionLive}<span class="size-1.5 rounded-full bg-emerald-500"></span>{/if}
								</div>
								<div class="text-[10px] text-muted-foreground">{sessionLive ? 'live' : 'idle'}</div>
							</div>
							<div class="rounded-md border bg-muted/20 px-3 py-2">
								<div class="text-[9px] uppercase tracking-wide text-muted-foreground">Events</div>
								<div class="font-mono text-base font-semibold leading-tight tabular-nums">{sessionState.events.length}</div>
								<div class="text-[10px] text-muted-foreground">{!item?.active ? 'history' : sessionState.isConnected ? 'streaming' : 'reconnecting'}</div>
							</div>
						</div>
						<div>
							<h3 class="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
								Recent activity
								{#if sessionState.isConsolidating}
									<span class="text-[10px] text-sky-500">catching up…</span>
								{:else if !sessionState.isConnected && item?.active}
									<span class="text-[10px] text-amber-500">reconnecting…</span>
								{:else if !item?.active}
									<span class="text-[10px] text-muted-foreground">history</span>
								{/if}
							</h3>
							<div class="space-y-0.5">
								{#each recentEvents as ev (ev.id)}
									<EventRow
										event={ev}
										elapsedMs={createdAtMs ? new Date(ev.createdAt).getTime() - createdAtMs : undefined}
									/>
								{:else}
									<p class="text-xs text-muted-foreground">No events yet.</p>
								{/each}
							</div>
						</div>
					{:else}
						<p class="text-xs text-muted-foreground">Connecting…</p>
					{/if}
				{:else if executionId}
					{#if execState}
						<div class="space-y-2 rounded-md border bg-muted/20 p-3">
							<div class="flex items-center justify-between gap-2 text-xs">
								<span class="text-muted-foreground">Current stage</span>
								<span class="min-w-0 truncate font-medium">{snapshot?.currentNodeName ?? execState.currentPhase ?? '—'}</span>
							</div>
							{#if snapshot?.progress != null}
								<div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
									<div class="h-full rounded-full bg-sky-500" style="width: {snapshot.progress}%"></div>
								</div>
								<div class="text-right text-[10px] tabular-nums text-muted-foreground">{snapshot.progress}%</div>
							{/if}
							<div class="grid grid-cols-3 gap-2 pt-1 text-center">
								<div class="rounded border bg-background px-2 py-1">
									<div class="text-[9px] uppercase text-muted-foreground">Tokens</div>
									<div class="font-mono text-xs tabular-nums">{compact(execState.tokenUsage.input + execState.tokenUsage.output)}</div>
								</div>
								<div class="rounded border bg-background px-2 py-1">
									<div class="text-[9px] uppercase text-muted-foreground">Tools</div>
									<div class="font-mono text-xs tabular-nums">{execState.toolCallTotal}</div>
								</div>
								<div class="rounded border bg-background px-2 py-1">
									<div class="text-[9px] uppercase text-muted-foreground">Iter</div>
									<div class="font-mono text-xs tabular-nums">
										{execState.iterationIndex >= 0 ? execState.iterationIndex : '—'}{execState.iterationMax ? `/${execState.iterationMax}` : ''}
									</div>
								</div>
							</div>
						</div>

						<div>
							<h3 class="mb-2 text-xs font-semibold text-muted-foreground">Steps</h3>
							<div class="space-y-0.5">
								{#each recentSteps as step (step.logId ?? step.stepName)}
									<div class="flex items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-muted/40">
										<span class="size-2 shrink-0 rounded-full {stepTone(step.status)}"></span>
										<span class="min-w-0 flex-1 truncate">{step.displayLabel ?? step.label ?? step.stepName}</span>
										<span class="shrink-0 font-mono tabular-nums text-muted-foreground">{fmtDuration(step.durationMs)}</span>
									</div>
								{:else}
									<p class="text-xs text-muted-foreground">No steps recorded yet.</p>
								{/each}
							</div>
						</div>

						{#if recentAgentEvents.length > 0}
							<div>
								<h3 class="mb-2 text-xs font-semibold text-muted-foreground">Agent activity</h3>
								<div class="space-y-0.5">
									{#each recentAgentEvents as ev (ev.id)}
										<div class="flex items-center gap-2 rounded px-2 py-1 text-[11px]">
											{#if ev.toolName}<Wrench class="size-3 shrink-0 text-muted-foreground" />{:else}<MessageSquare class="size-3 shrink-0 text-muted-foreground" />{/if}
											<span class="shrink-0 font-mono text-[10px] text-muted-foreground">{ev.type.replace(/^agent\./, '')}</span>
											{#if ev.toolName}<span class="min-w-0 truncate">{ev.toolName}</span>{/if}
										</div>
									{/each}
								</div>
							</div>
						{/if}
					{:else}
						<p class="text-xs text-muted-foreground">Connecting…</p>
					{/if}
				{:else}
					<p class="text-xs text-muted-foreground">
						Open the full page for this {kindLabel(item.kind).toLowerCase()}'s details.
					</p>
				{/if}
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
