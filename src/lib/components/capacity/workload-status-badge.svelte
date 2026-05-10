<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type { WorkloadStatus } from '$lib/server/kueueviz';

	type Props = {
		status: WorkloadStatus;
	};

	let { status }: Props = $props();

	const tone = $derived(
		status === 'admitted'
			? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
			: status === 'reserving'
				? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400'
				: status === 'pending'
					? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
					: status === 'finished'
						? 'border-muted bg-muted text-muted-foreground'
						: status === 'failed' || status === 'evicted'
							? 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400'
							: 'border-muted bg-muted text-muted-foreground'
	);

	const label = $derived(
		status === 'admitted'
			? 'Admitted'
			: status === 'reserving'
				? 'Reserving'
				: status === 'pending'
					? 'Pending'
					: status === 'finished'
						? 'Finished'
						: status === 'failed'
							? 'Failed'
							: status === 'evicted'
								? 'Evicted'
								: 'Unknown'
	);
</script>

<Badge variant="outline" class="font-mono text-[10px] {tone}">{label}</Badge>
