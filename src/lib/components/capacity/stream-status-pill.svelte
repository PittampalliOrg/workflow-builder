<script lang="ts">
	import { Activity, Loader2, AlertTriangle, CircleOff } from '@lucide/svelte';
	import type { StreamStatus } from '$lib/server/kueueviz';

	type Props = {
		status: StreamStatus;
		lastUpdate?: string | null;
		error?: string | null;
	};

	let { status, lastUpdate = null, error = null }: Props = $props();

	const tone = $derived(
		status === 'open'
			? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
			: status === 'connecting'
				? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400'
				: status === 'degraded'
					? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
					: 'border-muted bg-muted text-muted-foreground'
	);

	const label = $derived(
		status === 'open'
			? 'Live'
			: status === 'connecting'
				? 'Connecting'
				: status === 'degraded'
					? 'Reconnecting'
					: 'Disconnected'
	);

	const ageSeconds = $derived.by(() => {
		if (!lastUpdate) return null;
		const ms = Date.now() - new Date(lastUpdate).getTime();
		return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : null;
	});

	const ageDisplay = $derived(
		ageSeconds === null
			? null
			: ageSeconds < 5
				? 'just now'
				: ageSeconds < 60
					? `${ageSeconds}s ago`
					: ageSeconds < 3600
						? `${Math.floor(ageSeconds / 60)}m ago`
						: 'stale'
	);
</script>

<span
	class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium {tone}"
	title={error ?? undefined}
>
	{#if status === 'connecting'}
		<Loader2 class="size-3 animate-spin" />
	{:else if status === 'degraded'}
		<AlertTriangle class="size-3" />
	{:else if status === 'open'}
		<Activity class="size-3" />
	{:else}
		<CircleOff class="size-3" />
	{/if}
	<span>{label}</span>
	{#if ageDisplay && status === 'open'}
		<span class="text-muted-foreground/80">· {ageDisplay}</span>
	{/if}
</span>
