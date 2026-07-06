<script lang="ts">
	/**
	 * Amber "Needs input" badge for the session LIST + Fleet surfaces — the
	 * cold-load / at-a-glance counterpart to the session-detail toast + terminal
	 * badge. Rendered whenever a session's `pending_input` cache is set (see
	 * PendingInput / sessions.pending_input, migration 0096). Styling mirrors the
	 * `requires_action` stop-reason chip (HandIcon + amber outline).
	 */
	import { Badge } from '$lib/components/ui/badge';
	import { HandIcon } from '@lucide/svelte';
	import type { PendingInput } from '$lib/types/sessions';

	type Props = {
		pendingInput: PendingInput | null | undefined;
		class?: string;
	};

	let { pendingInput, class: className = '' }: Props = $props();

	const label = $derived(pendingInput?.kind === 'permission' ? 'Needs approval' : 'Needs input');
	const title = $derived(
		pendingInput
			? `Waiting on you${pendingInput.prompt ? ` — ${pendingInput.prompt}` : ''}`
			: undefined
	);
</script>

{#if pendingInput}
	<Badge
		variant="outline"
		class={`gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300 ${className}`}
		{title}
	>
		<HandIcon class="size-3" />
		{label}
	</Badge>
{/if}
