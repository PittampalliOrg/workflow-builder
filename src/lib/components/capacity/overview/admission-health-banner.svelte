<script lang="ts">
	/**
	 * Cluster-wide ClusterQueue admission-health banner for Zone A.
	 *
	 * Surfaces Kueue's per-CQ `status.conditions[type=Active]` as a
	 * single roll-up. When healthy ("N/N queues active") renders as a
	 * tiny green chip that doesn't compete with other Zone A pills.
	 * When ANY queue is inactive, switches to amber/rose with the
	 * inactive count, queue names, and hover tooltip showing reasons —
	 * the kind of failure mode where workloads pile up silently while
	 * the rest of the dashboard reads "healthy" (Phase H bug pattern).
	 *
	 * Empty / undefined admissionHealth (older observer payloads) →
	 * renders nothing. Pure projection — no state.
	 */
	import { CheckCircle2, AlertTriangle, XCircle } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import type { CapacityAdmissionHealth } from '$lib/types/capacity';

	type Props = {
		health: CapacityAdmissionHealth | undefined;
	};

	let { health }: Props = $props();

	// Tone: all-active = emerald; partial = amber; zero-active = rose.
	const tone = $derived.by(() => {
		if (!health) return 'neutral';
		if (health.activeQueues === health.totalQueues) return 'emerald';
		if (health.activeQueues === 0) return 'rose';
		return 'amber';
	});

	const Icon = $derived(
		tone === 'emerald' ? CheckCircle2 : tone === 'rose' ? XCircle : AlertTriangle
	);

	const chipClass = $derived(
		tone === 'emerald'
			? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
			: tone === 'amber'
				? 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300'
				: tone === 'rose'
					? 'border-rose-500/50 bg-rose-500/15 text-rose-700 dark:text-rose-300'
					: 'border-muted text-muted-foreground'
	);

	// Tooltip body: lists each inactive queue's reason+message. Plain
	// text via `title=` so it works without a popover library. Keep
	// lines short — browser tooltips truncate aggressively.
	const tooltip = $derived.by(() => {
		if (!health) return 'Admission health unknown (observer hasn\'t reported)';
		if (health.activeQueues === health.totalQueues) {
			return `All ${health.totalQueues} ClusterQueues active — Kueue is admitting workloads normally.`;
		}
		const lines = [
			`${health.activeQueues} / ${health.totalQueues} ClusterQueues active. Inactive:`,
		];
		for (const q of health.inactiveQueues) {
			const reason = q.reason || 'unknown';
			const msg = q.message ? ` — ${q.message}` : '';
			lines.push(`  • ${q.name}: ${reason}${msg}`);
		}
		return lines.join('\n');
	});
</script>

{#if health}
	<Badge
		variant="outline"
		class="font-mono text-[10px] inline-flex items-center gap-1.5 {chipClass}"
		title={tooltip}
	>
		<Icon class="size-3" />
		<span>
			{health.activeQueues}/{health.totalQueues} queues
			{tone === 'emerald' ? 'active' : 'admitting'}
		</span>
		{#if tone !== 'emerald'}
			<span class="font-semibold">
				— {health.inactiveQueues
					.slice(0, 2)
					.map((q) => q.name)
					.join(', ')}{health.inactiveQueues.length > 2 ? '…' : ''}
			</span>
		{/if}
	</Badge>
{/if}
