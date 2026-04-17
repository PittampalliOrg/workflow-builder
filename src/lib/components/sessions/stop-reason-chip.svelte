<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Check, HandIcon, AlertTriangle } from 'lucide-svelte';
	import type { SessionStopReason } from '$lib/types/sessions';

	interface Props {
		stopReason: SessionStopReason | null | undefined;
		// When provided, requires_action links to this tool_use_id
		pendingToolUseId?: string | null;
	}

	let { stopReason, pendingToolUseId = null }: Props = $props();

	const info = $derived.by(() => {
		const type = stopReason?.type;
		switch (type) {
			case 'end_turn':
				return {
					icon: Check,
					text: 'Finished the turn',
					// neutral accent
					variant: 'secondary' as const
				};
			case 'requires_action':
				return {
					icon: HandIcon,
					text: pendingToolUseId
						? 'Waiting on your input'
						: 'Needs your input',
					variant: 'outline' as const
				};
			case 'retries_exhausted':
				return {
					icon: AlertTriangle,
					text: 'Retries exhausted',
					variant: 'destructive' as const
				};
			default:
				return null;
		}
	});
</script>

{#if info}
	<Badge variant={info.variant} class="gap-1 text-[10px]">
		<info.icon class="size-3" />
		{info.text}
	</Badge>
{/if}
