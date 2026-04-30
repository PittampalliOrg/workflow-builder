<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { statusColor, formatStatus } from './run-status-helpers';

	type Props = {
		status: string | null | undefined;
		/** Optional override label (e.g. "running"). Defaults to formatted status. */
		label?: string;
		class?: string;
	};

	const { status, label, class: className = '' }: Props = $props();
</script>

<Badge class="{statusColor(status)} {className}">
	{label ?? formatStatus(status)}
</Badge>
