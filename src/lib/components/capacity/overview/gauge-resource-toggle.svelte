<script lang="ts">
	/**
	 * Segmented control over the four resources the Capacity gauge can show.
	 * The selection drives both the mega gauge AND the per-queue headroom
	 * rows, so they stay in sync.
	 *
	 * Selection is persisted to localStorage under `capacity.gauge.resource`.
	 * Default is `cpu` — the primary saturation signal on ryzen.
	 */
	export type GaugeResource = 'cpu' | 'memory' | 'pods' | 'ephemeral-storage';

	type Props = {
		value: GaugeResource;
		onChange: (next: GaugeResource) => void;
	};

	let { value, onChange }: Props = $props();

	const options: Array<{ id: GaugeResource; label: string }> = [
		{ id: 'cpu', label: 'CPU' },
		{ id: 'memory', label: 'Memory' },
		{ id: 'pods', label: 'Pods' },
		{ id: 'ephemeral-storage', label: 'Storage' }
	];

	function select(next: GaugeResource) {
		if (next === value) return;
		onChange(next);
		if (typeof window !== 'undefined') {
			try {
				window.localStorage.setItem('capacity.gauge.resource', next);
			} catch {
				// Private mode / disabled storage — ignore. State still lives in memory.
			}
		}
	}
</script>

<div
	class="inline-flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5 text-[11px]"
	role="tablist"
	aria-label="Gauge resource"
>
	{#each options as opt (opt.id)}
		<button
			type="button"
			role="tab"
			aria-selected={opt.id === value}
			class="rounded px-2 py-0.5 transition-colors {opt.id === value
				? 'bg-background text-foreground shadow-sm font-medium'
				: 'text-muted-foreground hover:text-foreground'}"
			onclick={() => select(opt.id)}
		>
			{opt.label}
		</button>
	{/each}
</div>
