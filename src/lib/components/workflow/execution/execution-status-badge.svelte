<script lang="ts">
	import { Loader2 } from 'lucide-svelte';

	interface Props {
		status: string;
		class?: string;
	}

	let { status, class: className = '' }: Props = $props();

	const normalized = $derived(status.toLowerCase());

	const colorClass = $derived.by(() => {
		switch (normalized) {
			case 'success':
			case 'completed':
				return 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300';
			case 'running':
				return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
			case 'error':
			case 'failed':
				return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300';
			case 'pending':
				return 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300';
			case 'cancelled':
			case 'terminated':
				return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
			default:
				return 'border-border bg-muted text-muted-foreground';
		}
	});

	const label = $derived.by(() => {
		switch (normalized) {
			case 'completed': return 'Success';
			default: return normalized.charAt(0).toUpperCase() + normalized.slice(1);
		}
	});

	const isRunning = $derived(normalized === 'running');
</script>

<span class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium {colorClass} {className}">
	{#if isRunning}
		<Loader2 size={10} class="animate-spin" />
	{/if}
	{label}
</span>
