<script lang="ts">
	import type { SandboxLogEntry } from '$lib/types/sandbox';

	interface Props {
		logs: SandboxLogEntry[];
	}

	let { logs }: Props = $props();

	let container: HTMLDivElement | undefined = $state();
	let autoScroll = $state(true);

	function levelColor(level: string): string {
		switch (level.toUpperCase()) {
			case 'ERROR':
				return 'text-red-400';
			case 'WARN':
			case 'WARNING':
				return 'text-yellow-400';
			case 'DEBUG':
			case 'TRACE':
				return 'text-muted-foreground/60';
			default:
				return 'text-muted-foreground';
		}
	}

	function formatTimestamp(ts: string): string {
		try {
			const d = new Date(Number(ts) || ts);
			return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
		} catch {
			return ts.slice(0, 8);
		}
	}

	$effect(() => {
		if (autoScroll && container && logs.length > 0) {
			container.scrollTop = container.scrollHeight;
		}
	});

	function onScroll() {
		if (!container) return;
		const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
		autoScroll = atBottom;
	}
</script>

<div
	bind:this={container}
	onscroll={onScroll}
	class="h-full overflow-auto rounded bg-zinc-950 p-3 font-mono text-xs leading-5"
>
	{#if logs.length === 0}
		<p class="text-zinc-500">Waiting for logs...</p>
	{:else}
		{#each logs as log}
			<div class="flex gap-2">
				<span class="shrink-0 text-muted-foreground/40">{formatTimestamp(log.timestamp)}</span>
				<span class="shrink-0 w-12 {levelColor(log.level)}">{log.level.slice(0, 5).padEnd(5)}</span>
				{#if log.source}
					<span class="shrink-0 text-blue-400/60">[{log.source}]</span>
				{/if}
				<span class="text-zinc-100 break-all">{log.message}</span>
			</div>
		{/each}
	{/if}
</div>
