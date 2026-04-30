<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import {
		Terminal,
		Cpu,
		CheckCircle2,
		XCircle,
		Play,
		ChevronRight,
		Wrench,
		Bot
	} from '@lucide/svelte';
	import type { SandboxLogEntry } from '$lib/types/sandbox';

	interface Props {
		logs: SandboxLogEntry[];
	}

	let { logs }: Props = $props();

	// Group consecutive logs into activity blocks
	const activities = $derived.by(() => {
		const blocks: Array<{
			type: 'tool' | 'llm' | 'agent' | 'output';
			title: string;
			icon: typeof Terminal;
			status: 'running' | 'success' | 'error';
			entries: SandboxLogEntry[];
			timestamp: string;
		}> = [];

		let currentBlock: (typeof blocks)[0] | null = null;

		for (const log of logs) {
			const eventType = (log as unknown as Record<string, unknown>).eventType as string ?? log.source;

			if (eventType === 'tool_call_start') {
				// Close previous block
				if (currentBlock) blocks.push(currentBlock);
				currentBlock = {
					type: 'tool',
					title: log.message.replace('Tool: ', '').replace(' started', ''),
					icon: Wrench,
					status: 'running',
					entries: [log],
					timestamp: log.timestamp
				};
			} else if (eventType === 'tool_call_end' && currentBlock?.type === 'tool') {
				currentBlock.status = 'success';
				currentBlock.entries.push(log);
				blocks.push(currentBlock);
				currentBlock = null;
			} else if (eventType === 'tool_call_error' && currentBlock?.type === 'tool') {
				currentBlock.status = 'error';
				currentBlock.entries.push(log);
				blocks.push(currentBlock);
				currentBlock = null;
			} else if (eventType === 'llm_start') {
				if (currentBlock) blocks.push(currentBlock);
				currentBlock = {
					type: 'llm',
					title: 'LLM Inference',
					icon: Cpu,
					status: 'running',
					entries: [log],
					timestamp: log.timestamp
				};
			} else if (eventType === 'llm_complete' && currentBlock?.type === 'llm') {
				currentBlock.status = 'success';
				currentBlock.entries.push(log);
				blocks.push(currentBlock);
				currentBlock = null;
			} else if (eventType === 'run_started' || eventType === 'run_complete' || eventType === 'run_error') {
				if (currentBlock) blocks.push(currentBlock);
				blocks.push({
					type: 'agent',
					title: log.message,
					icon: Bot,
					status: eventType === 'run_error' ? 'error' : eventType === 'run_complete' ? 'success' : 'running',
					entries: [log],
					timestamp: log.timestamp
				});
				currentBlock = null;
			} else if (currentBlock) {
				currentBlock.entries.push(log);
			} else {
				blocks.push({
					type: 'output',
					title: log.message.slice(0, 60),
					icon: Terminal,
					status: log.level === 'ERROR' ? 'error' : 'success',
					entries: [log],
					timestamp: log.timestamp
				});
			}
		}
		if (currentBlock) blocks.push(currentBlock);
		return blocks;
	});

	function formatTime(ts: string): string {
		try {
			return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
		} catch {
			return ts.slice(0, 8);
		}
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'success': return 'text-green-500';
			case 'error': return 'text-red-500';
			default: return 'text-yellow-500';
		}
	}
</script>

<div class="h-full overflow-auto space-y-1 p-2">
	{#if activities.length === 0}
		<div class="flex items-center justify-center py-12 text-sm text-muted-foreground">
			Waiting for activity...
		</div>
	{:else}
		{#each activities as activity}
			<Collapsible.Root>
				<Collapsible.Trigger class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors">
					{#if activity.status === 'success'}
						<CheckCircle2 class="h-3.5 w-3.5 shrink-0 {statusColor(activity.status)}" />
					{:else if activity.status === 'error'}
						<XCircle class="h-3.5 w-3.5 shrink-0 {statusColor(activity.status)}" />
					{:else}
						<Play class="h-3.5 w-3.5 shrink-0 {statusColor(activity.status)}" />
					{/if}
					<svelte:component this={activity.icon} class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
					<span class="flex-1 truncate font-medium">{activity.title}</span>
					<span class="shrink-0 text-xs text-muted-foreground">{formatTime(activity.timestamp)}</span>
					{#if activity.type === 'tool'}
						<Badge variant="outline" class="text-[10px] shrink-0">tool</Badge>
					{:else if activity.type === 'llm'}
						<Badge variant="outline" class="text-[10px] shrink-0">llm</Badge>
					{/if}
					<ChevronRight class="h-3 w-3 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
				</Collapsible.Trigger>
				<Collapsible.Content>
					<div class="ml-10 space-y-0.5 rounded-md bg-muted/20 px-3 py-2">
						{#each activity.entries as entry}
							<div class="flex gap-2 font-mono text-xs">
								<span class="shrink-0 text-muted-foreground/50">{formatTime(entry.timestamp)}</span>
								<span class="{entry.level === 'ERROR' ? 'text-red-400' : 'text-muted-foreground'}">{entry.message}</span>
							</div>
						{/each}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		{/each}
	{/if}
</div>
