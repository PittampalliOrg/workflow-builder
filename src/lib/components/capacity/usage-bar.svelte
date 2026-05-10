<script lang="ts">
	/**
	 * Stacked horizontal bar for ClusterQueue usage. Three coloured segments:
	 *   used (solid) | reserved (translucent overlay) | free (background).
	 *
	 * Threshold colouring matches upstream KueueViz semantics:
	 *   <70%  emerald
	 *   70-89% amber
	 *   ≥90%  rose
	 *
	 * `overPct` is the fraction by which used+reserved exceeds nominal —
	 * rendered as a thin red sliver hugging the right edge so borrowing
	 * states are visible at a glance.
	 */
	type Props = {
		used: number;
		reserved: number;
		over?: number;
		label?: string;
		usedAbsLabel?: string;
		reservedAbsLabel?: string;
		nominalLabel?: string;
		hideHeader?: boolean;
	};

	let {
		used,
		reserved,
		over = 0,
		label,
		usedAbsLabel,
		reservedAbsLabel,
		nominalLabel,
		hideHeader = false
	}: Props = $props();

	const tone = $derived.by(() => {
		const total = used + reserved;
		if (total >= 90) return 'rose';
		if (total >= 70) return 'amber';
		return 'emerald';
	});

	const usedClass = $derived(
		tone === 'rose'
			? 'bg-rose-500'
			: tone === 'amber'
				? 'bg-amber-500'
				: 'bg-emerald-500'
	);
	const reservedClass = $derived(
		tone === 'rose'
			? 'bg-rose-300'
			: tone === 'amber'
				? 'bg-amber-300'
				: 'bg-emerald-300'
	);

	const usedDisplay = $derived(`${Math.round(used)}%`);
</script>

<div class="space-y-1">
	{#if !hideHeader && (label || usedAbsLabel)}
		<div class="flex items-baseline justify-between gap-2 text-[11px]">
			<span class="font-medium text-muted-foreground capitalize">{label ?? ''}</span>
			<span class="tabular-nums text-muted-foreground">
				{#if usedAbsLabel && nominalLabel}
					<span class="font-mono">{usedAbsLabel}</span>
					<span class="text-muted-foreground/60"> / {nominalLabel}</span>
				{/if}
				<span class="ml-2 font-mono">{usedDisplay}</span>
			</span>
		</div>
	{/if}
	<div
		class="relative h-2 overflow-hidden rounded-full bg-muted"
		role="progressbar"
		aria-valuemin="0"
		aria-valuemax="100"
		aria-valuenow={Math.round(used + reserved)}
		aria-label={label}
	>
		<div
			class="absolute inset-y-0 left-0 transition-[width] duration-300 {usedClass}"
			style="width: {Math.max(0, Math.min(100, used))}%"
		></div>
		<div
			class="absolute inset-y-0 transition-[left,width] duration-300 {reservedClass}"
			style="left: {Math.max(0, Math.min(100, used))}%; width: {Math.max(0, Math.min(100 - used, reserved))}%"
		></div>
		{#if over > 0}
			<div
				class="absolute inset-y-0 right-0 bg-rose-700"
				style="width: {Math.max(2, Math.min(20, over / 5))}%"
				title={`borrowing ${Math.round(over)}% over nominal`}
			></div>
		{/if}
	</div>
	{#if reservedAbsLabel && Number(reservedAbsLabel) !== 0}
		<div class="text-[10px] text-muted-foreground">
			Reserved <span class="font-mono">{reservedAbsLabel}</span>
		</div>
	{/if}
</div>
