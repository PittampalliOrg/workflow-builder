<script lang="ts">
	import { Check, Copy } from '@lucide/svelte';

	interface Props {
		/** Full id to copy; display is truncated. */
		value: string;
		/** Characters to show before the "..." (default: show first 4 + last 6). */
		displayLength?: number;
		/** Extra class for the wrapper. */
		class?: string;
	}

	let { value, displayLength, class: klass = '' }: Props = $props();

	let copied = $state(false);

	const display = $derived.by(() => {
		if (!value) return '';
		if (displayLength && value.length <= displayLength) return value;
		// Default: first 4 + "…" + last 6 — matches CMA's `agent_…V4j57F` shape.
		if (value.length <= 12) return value;
		return `${value.slice(0, 4)}…${value.slice(-6)}`;
	});

	async function copy(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(value);
			copied = true;
			setTimeout(() => (copied = false), 1400);
		} catch {
			/* clipboard blocked */
		}
	}
</script>

<button
	type="button"
	class="group inline-flex items-center gap-1 font-mono text-xs hover:text-primary {klass}"
	onclick={copy}
	title={value}
	aria-label="Copy {value}"
>
	<span>{display}</span>
	{#if copied}
		<Check class="size-3 text-green-600" />
	{:else}
		<Copy class="size-3 opacity-0 group-hover:opacity-60 transition-opacity" />
	{/if}
</button>
