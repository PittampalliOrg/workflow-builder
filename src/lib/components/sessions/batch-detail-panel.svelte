<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import EventTypePill, { eventKindFor } from './event-type-pill.svelte';
	import { EventRenderer } from '$lib/components/events';
	import { findToolPair } from '$lib/utils/tool-pair';
	import { ChevronDown, ChevronRight, Clock, X } from '@lucide/svelte';

	interface Props {
		/** Every event collapsed into this batch, in order. */
		children: SessionEventEnvelope[];
		/** All events in the session — used to resolve each batched tool_use to
		 *  its matching tool_result via findToolPair. Without this, expanded
		 *  rows can only render the input half. */
		events?: SessionEventEnvelope[];
		/** Session start time, ms — used to stamp elapsed on each child. */
		sessionStartMs: number | null;
		/** Debug mode: show raw JSON instead of `input`. */
		debug?: boolean;
		onClose?: () => void;
	}

	const { children, events = [], sessionStartMs, debug = false, onClose }: Props = $props();

	const kind = $derived(
		children.length > 0 ? eventKindFor(children[0].type) : 'tool',
	);
	const toolName = $derived.by(() => {
		if (children.length === 0) return 'Tool';
		const d = children[0].data as { name?: string; tool_name?: string };
		return String(d.name ?? d.tool_name ?? 'Tool');
	});

	// First child expanded by default, rest collapsed. Keyed by sevt id so the
	// open set survives stream updates that append new children.
	let openIds = $state(new Set<string>());
	$effect(() => {
		const first = children[0];
		if (first && openIds.size === 0) {
			openIds = new Set([String(first.id)]);
		}
	});
	function toggle(id: string) {
		const next = new Set(openIds);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		openIds = next;
	}

	function fmtElapsed(ms: number): string {
		const t = Math.floor(ms / 1000);
		const h = Math.floor(t / 3600);
		const m = Math.floor((t % 3600) / 60);
		const s = t % 60;
		return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
	}
	function fmtDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const mins = Math.floor(ms / 60_000);
		const secs = Math.floor((ms % 60_000) / 1000);
		return `${mins}m ${secs.toString().padStart(2, '0')}s`;
	}
	function preview(ev: SessionEventEnvelope): string {
		const d = ev.data as Record<string, unknown>;
		const input = d.input;
		if (input && typeof input === 'object') {
			for (const key of ['query', 'command', 'path', 'url', 'file_path']) {
				const v = (input as Record<string, unknown>)[key];
				if (typeof v === 'string' && v.trim()) return v.trim();
			}
			return JSON.stringify(input).slice(0, 80);
		}
		const ip = d.input_preview;
		if (typeof ip === 'string' && ip.trim()) return ip.trim();
		return String(d.name ?? d.tool_name ?? ev.type);
	}
	function pairFor(ev: SessionEventEnvelope): SessionEventEnvelope | null {
		if (events.length === 0) return null;
		const p = findToolPair(events, ev);
		if (p.start === ev) return p.end ?? null;
		if (p.end === ev) return p.start ?? null;
		return null;
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	<!-- Header: matches single-event header shape. -->
	<div class="flex items-start justify-between gap-2 border-b px-4 py-3">
		<div class="min-w-0 flex-1 space-y-1">
			<div class="flex items-center gap-2">
				<EventTypePill {kind} />
				<h3 class="text-sm font-semibold truncate">{toolName}</h3>
				<span class="text-[11px] text-muted-foreground">×{children.length}</span>
			</div>
			<div class="text-[11px] text-muted-foreground">
				{children.length} invocations
			</div>
		</div>
		{#if onClose}
			<Button variant="ghost" size="icon" class="size-7" onclick={onClose}>
				<X class="size-3.5" />
			</Button>
		{/if}
	</div>

	<div class="flex-1 overflow-y-auto">
		{#each children as ev, i (ev.id)}
			{@const isOpen = openIds.has(String(ev.id))}
			{@const data = ev.data as { duration_ms?: number; input?: unknown }}
			{@const elapsed =
				sessionStartMs !== null
					? new Date(ev.createdAt).getTime() - sessionStartMs
					: null}
			{@const paired = isOpen ? pairFor(ev) : null}
			<div class="border-b last:border-b-0">
				<button
					type="button"
					class="group flex w-full items-center gap-2 px-4 py-2 text-left text-xs transition-colors hover:bg-muted/40"
					onclick={() => toggle(String(ev.id))}
				>
					{#if isOpen}
						<ChevronDown class="size-3 text-muted-foreground" />
					{:else}
						<ChevronRight class="size-3 text-muted-foreground" />
					{/if}
					<EventTypePill kind="tool" label={toolName} size="xs" />
					<code class="min-w-0 flex-1 truncate text-foreground font-mono" title={preview(ev)}>
						{preview(ev)}
					</code>
					{#if data.duration_ms}
						<span class="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
							<Clock class="size-2.5" />
							{fmtDuration(data.duration_ms)}
						</span>
					{/if}
					{#if elapsed !== null}
						<span class="w-14 shrink-0 text-right font-mono text-[10px] text-muted-foreground/70">
							{fmtElapsed(elapsed)}
						</span>
					{/if}
				</button>
				{#if isOpen}
					<div class="border-t border-border/50 bg-muted/10 px-4 py-3">
						<div class="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
							<span>Invocation #{i + 1}</span>
							<code class="normal-case">{ev.id}</code>
						</div>
						<EventRenderer event={ev} pairedResult={paired} variant="panel" {debug} />
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>
