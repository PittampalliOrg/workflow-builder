<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import type { SessionEventEnvelope } from '$lib/types/sessions';
	import EventTypePill, { eventKindFor } from './event-type-pill.svelte';
	import JsonView from './json-view.svelte';
	import { Check, Clock, Copy, X } from 'lucide-svelte';

	interface Props {
		event: SessionEventEnvelope;
		/** Elapsed time from session start, ms. */
		elapsedMs?: number;
		/** Debug mode: show raw JSON regardless of event kind. */
		debug?: boolean;
		onClose?: () => void;
	}

	const { event, elapsedMs, debug = false, onClose }: Props = $props();

	const kind = $derived(eventKindFor(event.type));

	const title = $derived.by(() => {
		if (kind === 'user') return 'Message';
		if (kind === 'agent') return 'Message';
		if (kind === 'thinking') return 'Thinking';
		if (kind === 'tool') {
			const d = event.data as { name?: string; tool_name?: string };
			return String(d.name ?? d.tool_name ?? 'Tool use');
		}
		if (kind === 'result') return 'Tool result';
		if (kind === 'model') return 'Model request';
		if (kind === 'status') return event.type.replace('session.status_', 'Status: ');
		return event.type;
	});

	const textContent = $derived.by(() => {
		const d = event.data as Record<string, unknown>;
		const content = (d.content as Array<{ text?: string }>) ?? [];
		return content
			.map((c) => (typeof c?.text === 'string' ? c.text : ''))
			.filter(Boolean)
			.join('\n\n');
	});

	const toolInput = $derived.by(() => {
		const d = event.data as { input?: unknown };
		return d.input ?? null;
	});

	const durationMs = $derived.by(() => {
		const d = event.data as { duration_ms?: number; durationMs?: number };
		const v = Number(d?.duration_ms ?? d?.durationMs ?? 0);
		return Number.isFinite(v) && v > 0 ? v : null;
	});

	let copied = $state(false);
	async function copyAll() {
		try {
			const text = debug
				? JSON.stringify(event.data, null, 2)
				: textContent || JSON.stringify(event.data, null, 2);
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => (copied = false), 1400);
		} catch {
			/* clipboard blocked */
		}
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
</script>

<div class="flex h-full flex-col overflow-hidden">
	<div class="flex items-start justify-between gap-2 border-b px-4 py-3">
		<div class="min-w-0 flex-1 space-y-1">
			<div class="flex items-center gap-2">
				<EventTypePill {kind} />
				<h3 class="text-sm font-semibold truncate">{title}</h3>
			</div>
			<div class="flex items-center gap-3 text-[11px] text-muted-foreground">
				{#if elapsedMs !== undefined}
					<span class="font-mono">{fmtElapsed(elapsedMs)}</span>
				{/if}
				{#if durationMs !== null}
					<span class="inline-flex items-center gap-1">
						<Clock class="size-3" />
						{fmtDuration(durationMs)}
					</span>
				{/if}
				<code class="text-[10px] text-muted-foreground/70">{event.id}</code>
			</div>
		</div>
		<div class="flex items-center gap-1">
			<Button variant="ghost" size="icon" class="size-7" onclick={copyAll} title="Copy contents">
				{#if copied}
					<Check class="size-3.5 text-green-500" />
				{:else}
					<Copy class="size-3.5" />
				{/if}
			</Button>
			{#if onClose}
				<Button variant="ghost" size="icon" class="size-7" onclick={onClose}>
					<X class="size-3.5" />
				</Button>
			{/if}
		</div>
	</div>

	<div class="flex-1 overflow-y-auto px-4 py-3">
		{#if debug}
			<div class="text-[10px] font-mono text-muted-foreground mb-2">{event.type}</div>
			<JsonView value={event.data} />
		{:else if kind === 'user' || kind === 'agent'}
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Content</div>
			<div class="prose prose-sm dark:prose-invert mt-2 max-w-none whitespace-pre-wrap">
				{textContent || '(empty)'}
			</div>
		{:else if kind === 'thinking'}
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Reasoning</div>
			<div class="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
				{textContent || '(no text captured)'}
			</div>
		{:else if kind === 'tool'}
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Input</div>
			<div class="mt-2">
				<JsonView value={toolInput} />
			</div>
		{:else}
			<JsonView value={event.data} />
		{/if}
	</div>
</div>
