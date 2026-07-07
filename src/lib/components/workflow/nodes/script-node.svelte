<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import { Bot, GitFork, ArrowRight, Layers, Play, Square, Diamond, Repeat } from '@lucide/svelte';
	import type { ScriptNodeVariant } from '$lib/utils/script-graph-adapter';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const variant = $derived((data.variant as ScriptNodeVariant) ?? 'agent');
	const label = $derived((data.label as string) ?? '');
	const inLoop = $derived(Boolean(data.inLoop));
	const callCount = $derived(data.callCount as number | undefined);

	// Per-variant visual identity — a distinct hue + icon so the phase lanes and
	// call kinds read at a glance (the dynamic-script "shape preview").
	const STYLE: Record<
		ScriptNodeVariant,
		{ ring: string; bg: string; fg: string; Icon: typeof Bot; kind: string }
	> = {
		start: { ring: 'border-emerald-400/40', bg: 'bg-emerald-500/10', fg: 'text-emerald-300', Icon: Play, kind: 'Start' },
		phase: { ring: 'border-fuchsia-400/40', bg: 'bg-fuchsia-500/10', fg: 'text-fuchsia-300', Icon: Diamond, kind: 'Phase' },
		agent: { ring: 'border-teal-400/40', bg: 'bg-teal-500/10', fg: 'text-teal-300', Icon: Bot, kind: 'agent()' },
		parallel: { ring: 'border-amber-400/40', bg: 'bg-amber-500/10', fg: 'text-amber-300', Icon: GitFork, kind: 'parallel()' },
		pipeline: { ring: 'border-sky-400/40', bg: 'bg-sky-500/10', fg: 'text-sky-300', Icon: ArrowRight, kind: 'pipeline()' },
		workflow: { ring: 'border-indigo-400/40', bg: 'bg-indigo-500/10', fg: 'text-indigo-300', Icon: Layers, kind: 'workflow()' },
		end: { ring: 'border-slate-400/40', bg: 'bg-slate-500/10', fg: 'text-slate-300', Icon: Square, kind: 'End' }
	};
	const s = $derived(STYLE[variant]);
	const isPhase = $derived(variant === 'phase');
	const isEndpoint = $derived(variant === 'start' || variant === 'end');
</script>

<div
	class="relative rounded-lg border {s.ring} {s.bg} shadow-sm transition
		{selected ? 'ring-2 ring-primary/60' : ''}
		{isPhase ? 'px-3 py-1.5 min-w-[220px]' : isEndpoint ? 'px-3 py-1.5' : 'px-3 py-2 min-w-[240px]'}"
>
	{#if !isEndpoint || variant === 'end'}
		<Handle type="target" position={Position.Top} class="!size-2 !border-none !bg-muted-foreground/40" />
	{/if}

	{#if isPhase}
		<div class="flex items-center gap-2">
			<s.Icon class="size-3.5 {s.fg}" />
			<span class="text-[11px] font-semibold uppercase tracking-wide {s.fg}">{label}</span>
			{#if callCount != null}
				<span class="ml-auto rounded-full bg-background/60 px-1.5 text-[10px] text-muted-foreground">
					{callCount} call{callCount === 1 ? '' : 's'}
				</span>
			{/if}
		</div>
	{:else}
		<div class="flex items-start gap-2">
			<div class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md {s.bg} {s.ring} border">
				<s.Icon class="size-3.5 {s.fg}" />
			</div>
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-1.5">
					<span class="text-[10px] font-medium uppercase tracking-wide {s.fg}">{s.kind}</span>
					{#if inLoop}
						<span class="inline-flex items-center gap-0.5 rounded bg-background/60 px-1 text-[9px] text-muted-foreground" title="Runs inside a loop">
							<Repeat class="size-2.5" /> loop
						</span>
					{/if}
				</div>
				<div class="truncate text-xs font-medium text-foreground/90" title={label}>{label}</div>
			</div>
		</div>
	{/if}

	{#if !isEndpoint || variant === 'start'}
		<Handle type="source" position={Position.Bottom} class="!size-2 !border-none !bg-muted-foreground/40" />
	{/if}
</div>
