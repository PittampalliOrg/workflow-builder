<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import SandboxPhaseBadge from './sandbox-phase-badge.svelte';
	import SandboxConditions from './sandbox-conditions.svelte';
	import { Loader2 } from 'lucide-svelte';
	import type { Sandbox } from '$lib/types/sandbox';

	interface Props {
		sandboxName: string;
	}

	let { sandboxName }: Props = $props();

	let detail = $state.raw<Record<string, unknown> | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() => {
		loading = true;
		fetch(`/api/sandboxes/${encodeURIComponent(sandboxName)}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
			.then((data) => {
				detail = data;
				loading = false;
			})
			.catch((err) => {
				error = String(err);
				loading = false;
			});
	});

	function formatTimestamp(ts: string | number | undefined): string {
		if (!ts) return '-';
		try {
			const d = new Date(typeof ts === 'number' ? ts : ts);
			return d.toLocaleString('en-US', {
				month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
			});
		} catch {
			return String(ts);
		}
	}
</script>

{#if loading}
	<div class="flex items-center justify-center py-12">
		<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
	</div>
{:else if error}
	<div class="py-12 text-center text-sm text-muted-foreground">
		Failed to load sandbox details.
	</div>
{:else if detail}
	<div class="space-y-6">
		<!-- Metadata Card -->
		<div class="rounded-lg border border-border p-4">
			<h3 class="mb-3 text-sm font-semibold">Sandbox Details</h3>
			<div class="grid grid-cols-2 gap-3 text-sm">
				<div>
					<span class="text-muted-foreground">Name</span>
					<p class="font-mono">{detail.name ?? sandboxName}</p>
				</div>
				<div>
					<span class="text-muted-foreground">Phase</span>
					<p><SandboxPhaseBadge phase={(detail.phase as Sandbox['phase']) ?? 'UNKNOWN'} /></p>
				</div>
				<div>
					<span class="text-muted-foreground">Type</span>
					<p><Badge variant="outline" class="text-xs">{detail.type ?? 'openshell'}</Badge></p>
				</div>
				<div>
					<span class="text-muted-foreground">Namespace</span>
					<p class="font-mono">{detail.namespace ?? '-'}</p>
				</div>
				{#if detail.id}
					<div>
						<span class="text-muted-foreground">ID</span>
						<p class="truncate font-mono text-xs" title={String(detail.id)}>{detail.id}</p>
					</div>
				{/if}
				{#if detail.image}
					<div>
						<span class="text-muted-foreground">Image</span>
						<p class="truncate font-mono text-xs" title={String(detail.image)}>{detail.image}</p>
					</div>
				{/if}
				{#if detail.createdAt || detail.created}
					<div>
						<span class="text-muted-foreground">Created</span>
						<p>{formatTimestamp(String(detail.createdAt ?? detail.created))}</p>
					</div>
				{/if}
				{#if detail.current_policy_version}
					<div>
						<span class="text-muted-foreground">Policy Version</span>
						<p>{detail.current_policy_version}</p>
					</div>
				{/if}
			</div>
		</div>

		<!-- Providers -->
		{#if Array.isArray(detail.providers) && detail.providers.length > 0}
			<div class="rounded-lg border border-border p-4">
				<h3 class="mb-3 text-sm font-semibold">Providers</h3>
				<div class="flex flex-wrap gap-2">
					{#each detail.providers as provider}
						<Badge variant="secondary">{provider}</Badge>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Conditions -->
		{#if Array.isArray(detail.conditions) && detail.conditions.length > 0}
			<SandboxConditions conditions={detail.conditions} />
		{/if}
	</div>
{/if}
