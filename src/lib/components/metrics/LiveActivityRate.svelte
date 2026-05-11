<script lang="ts">
	/**
	 * Polls /api/observability/workflows/<executionId>/activity-rate every
	 * pollMs and renders a compact "Activities in last 60s" pill. Designed
	 * to live in the run header next to ExecutionHeader.
	 *
	 * Stops polling when the parent component is destroyed or when
	 * `active` is false (e.g., workflow reaches a terminal state).
	 */
	import { onMount, onDestroy } from 'svelte';
	import { Activity, CheckCircle2, XCircle, RotateCcw } from '@lucide/svelte';
	import {
		Tooltip,
		TooltipContent,
		TooltipProvider,
		TooltipTrigger
	} from '$lib/components/ui/tooltip';

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
	// Drives the "+N" flash when counts increment.
	let lastTotals = $state({ succeeded: 0, failed: 0, recoverable: 0 });
	let pulseKeys = $state({ succeeded: 0, failed: 0, recoverable: 0 });

	async function fetchOnce() {
		if (!executionId || inFlight) return;
		inFlight = true;
		try {
			const res = await fetch(
				`/api/observability/workflows/${encodeURIComponent(executionId)}/activity-rate`,
				{ credentials: 'include' }
			);
			if (res.ok) {
				const next = (await res.json()) as Payload;
				// Flash the chip when the count moves up.
				if (payload) {
					if (next.lastMinute.succeeded > lastTotals.succeeded) pulseKeys.succeeded++;
					if (next.lastMinute.failed > lastTotals.failed) pulseKeys.failed++;
					if (next.lastMinute.recoverable > lastTotals.recoverable) pulseKeys.recoverable++;
				}
				lastTotals = {
					succeeded: next.lastMinute.succeeded,
					failed: next.lastMinute.failed,
					recoverable: next.lastMinute.recoverable
				};
				payload = next;
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

	const total = $derived(payload?.lastMinute.total ?? 0);
	const idle = $derived(active && payload != null && total === 0);
	const live = $derived(active && total > 0);
</script>

{#if payload?.dapr_app_id}
	<TooltipProvider>
		<Tooltip>
			<TooltipTrigger>
				<div
					class="group inline-flex h-7 items-center gap-1.5 rounded-md border bg-background/60 px-2 text-xs shadow-sm backdrop-blur-sm transition-colors"
					class:border-emerald-500-40={live}
					class:bg-emerald-500-10={live}
					class:border-amber-500-30={idle}
					class:bg-amber-500-5={idle}
				>
					<span class="relative flex h-2 w-2 items-center justify-center">
						{#if live}
							<span
								class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75"
							></span>
							<span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
						{:else if idle}
							<span class="inline-flex h-2 w-2 rounded-full bg-amber-500/60"></span>
						{:else}
							<span class="inline-flex h-2 w-2 rounded-full bg-muted-foreground/40"></span>
						{/if}
					</span>

					<Activity class="size-3 text-muted-foreground" />

					<div class="flex items-center gap-1.5 font-mono tabular-nums">
						{#key pulseKeys.succeeded}
							<span
								class="inline-flex items-center gap-0.5 transition-colors"
								class:text-emerald-700={payload.lastMinute.succeeded > 0}
								class:dark:text-emerald-300={payload.lastMinute.succeeded > 0}
								class:text-muted-foreground={payload.lastMinute.succeeded === 0}
							>
								<CheckCircle2 class="size-3" />
								<span>{payload.lastMinute.succeeded}</span>
							</span>
						{/key}
						{#if payload.lastMinute.failed > 0}
							{#key pulseKeys.failed}
								<span class="inline-flex items-center gap-0.5 text-rose-700 dark:text-rose-300">
									<XCircle class="size-3" />
									<span>{payload.lastMinute.failed}</span>
								</span>
							{/key}
						{/if}
						{#if payload.lastMinute.recoverable > 0}
							{#key pulseKeys.recoverable}
								<span class="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-300">
									<RotateCcw class="size-3" />
									<span>{payload.lastMinute.recoverable}</span>
								</span>
							{/key}
						{/if}
					</div>

					{#if lastSeen}
						<span class="border-l border-border/60 pl-1.5 text-muted-foreground">
							{lastSeen}
						</span>
					{:else if idle}
						<span class="text-amber-700/80 italic dark:text-amber-300/80">idle</span>
					{/if}
				</div>
			</TooltipTrigger>
			<TooltipContent side="bottom" class="max-w-xs text-xs">
				<div class="space-y-1">
					<div class="font-medium">Dapr workflow activity · last {payload.windowSeconds}s</div>
					<div class="text-muted-foreground">
						Activities executed by the agent's Dapr sidecar in the last minute, partitioned by
						completion status. Powered by
						<code class="font-mono text-[10px]">dapr_runtime_workflow_activity_execution_count</code>.
					</div>
					<div class="border-t border-border pt-1 font-mono text-[10px] text-muted-foreground">
						app: {payload.dapr_app_id}
					</div>
				</div>
			</TooltipContent>
		</Tooltip>
	</TooltipProvider>
{/if}

<style>
	/* Tailwind doesn't know about arbitrary hex tints with alpha at runtime — encode
	 * the live/idle accent backgrounds in static classes so SSR + hydration agree.
	 */
	:global(.border-emerald-500-40) {
		border-color: rgb(16 185 129 / 0.4);
	}
	:global(.bg-emerald-500-10) {
		background-color: rgb(16 185 129 / 0.08);
	}
	:global(.border-amber-500-30) {
		border-color: rgb(245 158 11 / 0.3);
	}
	:global(.bg-amber-500-5) {
		background-color: rgb(245 158 11 / 0.05);
	}
</style>
