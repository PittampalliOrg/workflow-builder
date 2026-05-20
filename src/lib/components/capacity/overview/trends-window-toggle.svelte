<script lang="ts">
	/**
	 * Segmented control for the trends-panel time window. Mirrors
	 * gauge-resource-toggle.svelte but persists to a different key.
	 */
	export type TrendsWindow = '5m' | '15m' | '60m';

	type Props = {
		value: TrendsWindow;
		onChange: (next: TrendsWindow) => void;
	};

	let { value, onChange }: Props = $props();

	const options: Array<{ id: TrendsWindow; label: string }> = [
		{ id: '5m', label: '5m' },
		{ id: '15m', label: '15m' },
		{ id: '60m', label: '60m' }
	];

	function select(next: TrendsWindow) {
		if (next === value) return;
		onChange(next);
		if (typeof window !== 'undefined') {
			try {
				window.localStorage.setItem('capacity.trends.window', next);
			} catch {
				// Storage disabled — state still lives in memory.
			}
		}
	}
</script>

<div
	class="inline-flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5 text-[11px]"
	role="tablist"
	aria-label="Trends window"
>
	{#each options as opt (opt.id)}
		<button
			type="button"
			role="tab"
			aria-selected={opt.id === value}
			class="rounded px-2 py-0.5 transition-colors {opt.id === value
				? 'bg-background font-medium text-foreground shadow-sm'
				: 'text-muted-foreground hover:text-foreground'}"
			onclick={() => select(opt.id)}
		>
			{opt.label}
		</button>
	{/each}
</div>
