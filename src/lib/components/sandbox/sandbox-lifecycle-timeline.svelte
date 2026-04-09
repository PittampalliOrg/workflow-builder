<script lang="ts">
	import { CheckCircle2, Circle, Clock, AlertTriangle } from 'lucide-svelte';

	interface Props {
		createdAt?: string;
		phase?: string;
		linkedExecutionId?: string;
	}

	let { createdAt, phase, linkedExecutionId }: Props = $props();

	const GC_HOURS = 4;

	const gcDeadline = $derived.by(() => {
		if (!createdAt) return null;
		const created = new Date(createdAt);
		return new Date(created.getTime() + GC_HOURS * 60 * 60 * 1000);
	});

	const timeUntilGc = $derived.by(() => {
		if (!gcDeadline) return null;
		const remaining = gcDeadline.getTime() - Date.now();
		if (remaining <= 0) return 'expired';
		const hrs = Math.floor(remaining / 3600000);
		const mins = Math.floor((remaining % 3600000) / 60000);
		return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
	});

	function formatTime(date: string | Date): string {
		const d = typeof date === 'string' ? new Date(date) : date;
		return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
	}

	const events = $derived.by(() => {
		const items: Array<{ label: string; time: string; status: 'done' | 'current' | 'future' | 'warning'; link?: string }> = [];

		if (createdAt) {
			items.push({ label: 'Created', time: formatTime(createdAt), status: 'done' });
		}

		if (phase === 'READY' || phase === 'DELETING') {
			items.push({ label: 'Ready', time: '', status: 'done' });
		} else if (phase === 'PROVISIONING') {
			items.push({ label: 'Ready', time: '', status: 'current' });
		}

		if (linkedExecutionId) {
			items.push({ label: 'Execution', time: '', status: 'done', link: linkedExecutionId });
		}

		if (gcDeadline && phase !== 'DELETING') {
			items.push({
				label: `GC ${timeUntilGc}`,
				time: formatTime(gcDeadline),
				status: timeUntilGc === 'expired' ? 'warning' : 'future'
			});
		}

		if (phase === 'DELETING') {
			items.push({ label: 'Deleting', time: '', status: 'current' });
		}

		return items;
	});
</script>

<div class="flex items-center gap-0 text-xs">
	{#each events as event, i}
		{#if i > 0}
			<div class="h-px w-4 {event.status === 'future' ? 'bg-border' : 'bg-muted-foreground/30'}"></div>
		{/if}
		<div class="flex items-center gap-1" title={event.time}>
			{#if event.status === 'done'}
				<CheckCircle2 class="h-3 w-3 text-green-500" />
			{:else if event.status === 'current'}
				<Circle class="h-3 w-3 animate-pulse text-blue-500" />
			{:else if event.status === 'warning'}
				<AlertTriangle class="h-3 w-3 text-yellow-500" />
			{:else}
				<Clock class="h-3 w-3 text-muted-foreground/40" />
			{/if}
			{#if event.link}
				<a href="/workflows/runs/{event.link}" class="text-blue-400 hover:underline">{event.label}</a>
			{:else}
				<span class="{event.status === 'future' ? 'text-muted-foreground/50' : 'text-muted-foreground'}">{event.label}</span>
			{/if}
		</div>
	{/each}
</div>
