<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { AlertTriangle, CheckCircle2, CircleDashed, Loader2 } from '@lucide/svelte';
	import type { AgentRegistryStatus } from '$lib/types/agents';

	interface Props {
		status: AgentRegistryStatus | null | undefined;
		error?: string | null;
		syncedAt?: string | null;
		/** Compact variant (no label) for session chips / inline spots. */
		mini?: boolean;
		class?: string;
	}
	const { status, error = null, syncedAt = null, mini = false, class: className = '' }: Props = $props();

	const resolved: AgentRegistryStatus = $derived(status ?? 'unregistered');

	const labels: Record<AgentRegistryStatus, string> = {
		registered: 'Registered',
		unregistered: 'Not registered',
		failed: 'Sync failed',
		archiving: 'Deregistering',
		archived: 'Archived'
	};

	const tooltips: Record<AgentRegistryStatus, string> = {
		registered:
			'This agent is mirrored in the Dapr agent registry. Native Dapr Agents features (call_agent, broadcast) can address it by name.',
		unregistered:
			'This agent is not in the Dapr registry. Republish (or enable AGENT_REGISTRY_DUAL_WRITE) to register it.',
		failed: 'The last registry sync failed. Click Resync on the agent detail page to retry.',
		archiving: 'A deregister is in progress.',
		archived: 'The agent is archived; its registry entry has been removed.'
	};

	const tooltip = $derived(
		error ? `${tooltips[resolved]}\n\n${error}` : tooltips[resolved]
	);
</script>

{#if resolved === 'registered'}
	<Badge
		variant="outline"
		class={`gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ${className}`}
		title={tooltip}
	>
		<CheckCircle2 class="size-3" />
		{#if !mini}<span>{labels[resolved]}</span>{/if}
	</Badge>
{:else if resolved === 'failed'}
	<Badge
		variant="outline"
		class={`gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 ${className}`}
		title={tooltip}
	>
		<AlertTriangle class="size-3" />
		{#if !mini}<span>{labels[resolved]}</span>{/if}
	</Badge>
{:else if resolved === 'archiving'}
	<Badge variant="outline" class={`gap-1 ${className}`} title={tooltip}>
		<Loader2 class="size-3 animate-spin" />
		{#if !mini}<span>{labels[resolved]}</span>{/if}
	</Badge>
{:else}
	<Badge variant="outline" class={`gap-1 text-muted-foreground ${className}`} title={tooltip}>
		<CircleDashed class="size-3" />
		{#if !mini}<span>{labels[resolved]}</span>{/if}
	</Badge>
{/if}

{#if !mini && syncedAt && resolved === 'registered'}
	<span class="text-[10px] text-muted-foreground" title={`Last synced: ${syncedAt}`}>
		synced {relativeTime(syncedAt)}
	</span>
{/if}

<script lang="ts" module>
	function relativeTime(iso: string): string {
		const ms = Date.now() - new Date(iso).getTime();
		if (!Number.isFinite(ms) || ms < 0) return 'just now';
		const sec = Math.floor(ms / 1000);
		if (sec < 60) return `${sec}s ago`;
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const day = Math.floor(hr / 24);
		return `${day}d ago`;
	}
</script>
