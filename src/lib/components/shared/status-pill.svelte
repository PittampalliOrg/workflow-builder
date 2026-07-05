<script lang="ts">
	import { Loader2 } from '@lucide/svelte';
	import {
		resolveStatusTone,
		statusToneLabel,
		statusTonePillClass,
		statusToneTextClass,
	} from '$lib/utils/status-tone';

	interface Props {
		status: string;
		/** 'pill' = bordered badge (default); 'text' = tone-colored mono text (Fleet rows). */
		variant?: 'pill' | 'text';
		/** Override the derived label. */
		label?: string;
		/** Spinner; defaults to auto (shown while tone === 'active'). */
		spinner?: boolean;
		class?: string;
	}

	let { status, variant = 'pill', label, spinner, class: className = '' }: Props = $props();

	const tone = $derived(resolveStatusTone(status));
	const text = $derived(label ?? statusToneLabel(status));
	const showSpinner = $derived(spinner ?? tone === 'active');
</script>

{#if variant === 'text'}
	<span class="truncate font-mono text-[11px] {statusToneTextClass(tone)} {className}" title={status}>
		{text}
	</span>
{:else}
	<span
		class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium {statusTonePillClass(tone)} {className}"
		title={status}
	>
		{#if showSpinner}
			<Loader2 size={10} class="animate-spin" />
		{/if}
		{text}
	</span>
{/if}
