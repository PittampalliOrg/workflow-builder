<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Loader2, Play } from 'lucide-svelte';

	interface Props {
		sandboxName: string;
	}

	let { sandboxName }: Props = $props();

	let command = $state('');
	let output = $state('');
	let exitCode = $state<number | null>(null);
	let running = $state(false);
	let outputEl: HTMLPreElement | undefined = $state();

	async function execute() {
		if (!command.trim() || running) return;
		output = '';
		exitCode = null;
		running = true;

		try {
			const es = new EventSource(
				`/api/sandboxes/${encodeURIComponent(sandboxName)}/exec?stream=true`
			);

			// We need to POST the command, but EventSource only does GET.
			// Use fetch with SSE parsing instead.
			es.close();

			const response = await fetch(
				`/api/sandboxes/${encodeURIComponent(sandboxName)}/exec?stream=true`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ command: command.trim(), timeout: 30 })
				}
			);

			if (!response.ok || !response.body) {
				output = `Error: ${response.statusText}`;
				running = false;
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				let eventType = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) {
						eventType = line.slice(7).trim();
					} else if (line.startsWith('data: ')) {
						const raw = line.slice(6);
						try {
							const data = JSON.parse(raw);
							if (eventType === 'stdout' || eventType === 'stderr') {
								output += data.text ?? '';
							} else if (eventType === 'exit') {
								exitCode = data.exitCode ?? null;
							} else if (eventType === 'error') {
								output += `\nError: ${data.message ?? 'unknown'}\n`;
							}
						} catch {
							// ignore
						}
						eventType = '';
					}
				}

				if (outputEl) {
					outputEl.scrollTop = outputEl.scrollHeight;
				}
			}
		} catch (err) {
			output += `\nConnection error: ${err instanceof Error ? err.message : 'unknown'}`;
		} finally {
			running = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			execute();
		}
	}
</script>

<div class="flex h-full flex-col gap-3">
	<div class="flex gap-2">
		<input
			type="text"
			bind:value={command}
			onkeydown={onKeydown}
			placeholder="Enter command..."
			disabled={running}
			class="flex-1 rounded border border-border bg-background px-3 py-1.5 font-mono text-sm outline-none focus:ring-1 focus:ring-ring"
		/>
		<Button size="sm" onclick={execute} disabled={running || !command.trim()}>
			{#if running}
				<Loader2 class="h-4 w-4 animate-spin" />
			{:else}
				<Play class="h-4 w-4" />
			{/if}
			Run
		</Button>
	</div>

	<div class="relative flex-1">
		<pre
			bind:this={outputEl}
			class="h-full overflow-auto rounded bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100"
		>{#if output}{output}{:else}<span class="text-zinc-500">Output will appear here...</span>{/if}</pre>
		{#if exitCode !== null}
			<div class="absolute right-2 top-2">
				<Badge variant={exitCode === 0 ? 'secondary' : 'destructive'}>
					exit {exitCode}
				</Badge>
			</div>
		{/if}
	</div>
</div>
