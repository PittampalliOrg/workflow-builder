<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { CheckCircle2, XCircle, Clock, AlertTriangle } from '@lucide/svelte';

	interface Condition {
		type?: string;
		status?: string;
		reason?: string;
		message?: string;
		last_transition_time?: string;
	}

	interface Props {
		conditions: Condition[];
	}

	let { conditions }: Props = $props();

	function statusIcon(status: string | undefined) {
		switch (status?.toLowerCase()) {
			case 'true':
				return CheckCircle2;
			case 'false':
				return XCircle;
			default:
				return Clock;
		}
	}

	function statusColor(status: string | undefined): string {
		switch (status?.toLowerCase()) {
			case 'true':
				return 'text-green-500';
			case 'false':
				return 'text-red-500';
			default:
				return 'text-yellow-500';
		}
	}
</script>

<div class="rounded-lg border border-border p-4">
	<h3 class="mb-3 text-sm font-semibold">Conditions</h3>
	<div class="space-y-2">
		{#each conditions as condition}
			<div class="flex items-start gap-3 rounded-md bg-muted/30 px-3 py-2">
				<svelte:component this={statusIcon(condition.status)} class="mt-0.5 h-4 w-4 shrink-0 {statusColor(condition.status)}" />
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium">{condition.type ?? 'Unknown'}</span>
						{#if condition.reason}
							<Badge variant="outline" class="text-[10px]">{condition.reason}</Badge>
						{/if}
					</div>
					{#if condition.message}
						<p class="mt-0.5 text-xs text-muted-foreground">{condition.message}</p>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</div>
