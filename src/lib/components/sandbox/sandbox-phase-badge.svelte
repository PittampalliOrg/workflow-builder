<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import type { SandboxPhase } from '$lib/types/sandbox';

	interface Props {
		phase: SandboxPhase;
	}

	let { phase }: Props = $props();

	const config = $derived.by(() => {
		switch (phase) {
			case 'READY':
				return { variant: 'secondary' as const, class: 'bg-green-500/15 text-green-600 dark:text-green-400' };
			case 'PROVISIONING':
				return { variant: 'outline' as const, class: 'animate-pulse border-yellow-500/50 text-yellow-600 dark:text-yellow-400' };
			case 'ERROR':
				return { variant: 'destructive' as const, class: '' };
			case 'DELETING':
				return { variant: 'outline' as const, class: 'border-orange-500/50 text-orange-600 dark:text-orange-400' };
			default:
				return { variant: 'outline' as const, class: '' };
		}
	});
</script>

<Badge variant={config.variant} class={config.class}>
	{phase}
</Badge>
