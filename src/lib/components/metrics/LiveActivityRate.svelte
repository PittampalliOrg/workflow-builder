<script lang="ts">
	/**
	 * Polls /api/observability/workflows/<executionId>/activity-rate every
	 * pollMs and renders a compact "Activities in last 60s" widget. Designed
	 * to be embedded next to other live status pills on the run-detail page.
	 *
	 * Stops polling when the parent component is destroyed or when
	 * `active` is false (e.g., workflow reaches a terminal state).
	 */
	import { onMount, onDestroy } from 'svelte';

	type Payload = {
		dapr_app_id: string | null;
		windowSeconds: number;
		lastMinute: {
			succeeded: number;
			failed: number;
			recoverable: number;
			total: number;
		};
		lastActivityAt: string | null;
	};

	type Props = {
		executionId: string;
		active?: boolean;
		pollMs?: number;
	};

	let { executionId, active = true, pollMs = 3000 }: Props = $props();

	let payload = $state<Payload | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;
	let inFlight = $state(false);

	async function fetchOnce() {
		if (!executionId || inFlight) return;
		inFlight = true;
		try {
			const res = await fetch(
				`/api/observability/workflows/${encodeURIComponent(executionId)}/activity-rate`,
				{ credentials: 'include' }
			);
			if (res.ok) {
				payload = (await res.json()) as Payload;
			}
		} catch {
			// Best-effort; ignore network errors so we don't spam the console.
		} finally {
			inFlight = false;
		}
	}

	function startPolling() {
		stopPolling();
		void fetchOnce();
		timer = setInterval(() => void fetchOnce(), Math.max(1000, pollMs));
	}

	function stopPolling() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	onMount(() => {
		if (active) startPolling();
	});

	onDestroy(() => stopPolling());

	$effect(() => {
		if (active && !timer) startPolling();
		if (!active) stopPolling();
	});

	const lastSeen = $derived.by(() => {
		if (!payload?.lastActivityAt) return null;
		const ts = new Date(payload.lastActivityAt).getTime();
		if (!Number.isFinite(ts)) return null;
		const secAgo = Math.max(0, Math.floor((Date.now() - ts) / 1000));
		if (secAgo < 5) return 'just now';
		if (secAgo < 60) return `${secAgo}s ago`;
		const minAgo = Math.floor(secAgo / 60);
		return `${minAgo}m ago`;
	});

	const idle = $derived.by(() => {
		if (!payload) return false;
		return active && payload.lastMinute.total === 0;
	});
</script>

{#if payload?.dapr_app_id}
	<span
		class="inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
		class:text-amber-700={idle}
		class:dark:text-amber-300={idle}
		title={`Dapr workflow activities for app ${payload.dapr_app_id} in the last ${payload.windowSeconds}s`}
	>
		<span class="text-muted-foreground">activity 60s:</span>
		<span class="font-mono">
			<span class="text-emerald-700 dark:text-emerald-300">✓ {payload.lastMinute.succeeded}</span>
			<span class="ml-1.5 text-rose-700 dark:text-rose-300">✗ {payload.lastMinute.failed}</span>
			<span class="ml-1.5 text-amber-700 dark:text-amber-300">⟳ {payload.lastMinute.recoverable}</span>
		</span>
		{#if lastSeen}
			<span class="text-muted-foreground">· last {lastSeen}</span>
		{/if}
		{#if idle}
			<span class="italic">idle</span>
		{/if}
	</span>
{/if}
