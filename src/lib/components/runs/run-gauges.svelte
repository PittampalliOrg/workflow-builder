<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { fmtTokens } from '$lib/utils/format-tokens';
	import { Coins, Activity, Repeat, Wrench, Cpu } from '@lucide/svelte';
	import type { ExecutionStreamState } from '$lib/stores/execution-stream.svelte';

	interface Props {
		state: ExecutionStreamState;
	}

	let { state }: Props = $props();

	const totalTokens = $derived(
		state.tokenUsage.input +
			state.tokenUsage.output +
			state.tokenUsage.cacheRead +
			state.tokenUsage.cacheCreation
	);

	// Tokens per second over the last 30 s. Re-derives whenever the rate window
	// or the live timestamp changes; the parent re-renders on every event push,
	// which is also when the window mutates.
	const tokensPerSecond = $derived.by(() => {
		const samples = state.tokenRateWindow;
		if (!samples.length) return 0;
		const sumDelta = samples.reduce((acc, s) => acc + s.totalDelta, 0);
		const span = Math.max(1, (Date.now() - samples[0].ts) / 1000);
		return Math.round(sumDelta / span);
	});

	const hasIteration = $derived(state.iterationIndex > 0);
	const hasTokens = $derived(totalTokens > 0);
	const hasToolCalls = $derived(state.toolCallTotal > 0);
	const hasAny = $derived(hasIteration || hasTokens || hasToolCalls || state.currentModel);
</script>

{#if hasAny}
	<div class="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-border bg-muted/30 text-xs">
		{#if hasIteration}
			<div class="flex items-center gap-1.5" title="Agent loop iteration / configured max">
				<Repeat size={12} class="text-muted-foreground" />
				<span class="font-mono">
					{state.iterationIndex}{state.iterationMax > 0 ? ` / ${state.iterationMax}` : ''}
				</span>
				<span class="text-muted-foreground">iter</span>
			</div>
		{/if}

		{#if hasToolCalls}
			<div class="flex items-center gap-1.5" title="Tool calls observed in this run">
				<Wrench size={12} class="text-muted-foreground" />
				<span class="font-mono">{state.toolCallTotal}</span>
				<span class="text-muted-foreground">tool calls</span>
			</div>
		{/if}

		{#if hasTokens}
			<div class="flex items-center gap-1.5" title="Cumulative LLM tokens this run (input + output + cache)">
				<Coins size={12} class="text-muted-foreground" />
				<span class="font-mono font-semibold">{fmtTokens(totalTokens)}</span>
				<span class="text-muted-foreground">tokens</span>
				<span class="text-muted-foreground">
					({fmtTokens(state.tokenUsage.input)} in / {fmtTokens(state.tokenUsage.output)} out{#if state.tokenUsage.cacheRead}
						, {fmtTokens(state.tokenUsage.cacheRead)} cache-read
					{/if}{#if state.tokenUsage.cacheCreation}
						, {fmtTokens(state.tokenUsage.cacheCreation)} cache-write
					{/if})
				</span>
			</div>

			{#if tokensPerSecond > 0}
				<div class="flex items-center gap-1.5" title="Token rate over the last 30 s">
					<Activity size={12} class="text-muted-foreground" />
					<span class="font-mono">{fmtTokens(tokensPerSecond)}/s</span>
				</div>
			{/if}
		{/if}

		{#if state.currentModel}
			<div class="flex items-center gap-1.5" title="Most recent model used">
				<Cpu size={12} class="text-muted-foreground" />
				<span class="font-mono text-muted-foreground">{state.currentModel}</span>
			</div>
		{/if}

		{#if state.currentPhase}
			<Badge variant="outline" class="ml-auto font-mono text-[10px]">
				{state.currentPhase}
			</Badge>
		{/if}
	</div>
{/if}
