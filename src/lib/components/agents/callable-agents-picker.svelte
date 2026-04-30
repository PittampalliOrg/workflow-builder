<script lang="ts">
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import RegistryStatusBadge from './registry-status-badge.svelte';
	import { CircleCheck, Search } from '@lucide/svelte';
	import type { AgentSummary } from '$lib/types/agents';

	interface Props {
		/** Current list of peer slugs the parent agent can invoke. */
		value: string[];
		/** Slug of the agent being edited (excluded from the peer list to prevent self-call). */
		selfSlug: string;
		/** Workspace project id — the same scope the registry uses for team_name. */
		projectId: string | null | undefined;
		onChange: (next: string[]) => void;
	}

	const { value, selfSlug, projectId, onChange }: Props = $props();

	let peers = $state<AgentSummary[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let query = $state('');

	// Derived: peers registered in the Dapr registry, excluding self.
	const registeredPeers = $derived(
		peers
			.filter((a) => !a.isArchived)
			.filter((a) => a.slug !== selfSlug)
			.filter((a) => a.registryStatus === 'registered')
	);

	const filtered = $derived(
		query.trim()
			? registeredPeers.filter((a) => {
					const q = query.trim().toLowerCase();
					return (
						a.name.toLowerCase().includes(q) ||
						a.slug.toLowerCase().includes(q) ||
						(a.description?.toLowerCase().includes(q) ?? false)
					);
				})
			: registeredPeers
	);

	const unregisteredCount = $derived(
		peers.filter((a) => !a.isArchived && a.slug !== selfSlug && a.registryStatus !== 'registered')
			.length
	);

	// Slugs referenced in `value` that no longer exist or are not registered —
	// surface them so the user knows their config references stale peers.
	const staleRefs = $derived(
		value.filter((slug) => !registeredPeers.some((p) => p.slug === slug))
	);

	onMount(async () => {
		try {
			const url = projectId
				? `/api/agents?projectId=${encodeURIComponent(projectId)}`
				: '/api/agents';
			const res = await fetch(url);
			if (!res.ok) {
				error = `Failed to load agents (${res.status})`;
				return;
			}
			const data = (await res.json()) as { agents: AgentSummary[] };
			peers = data.agents ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	});

	function toggle(slug: string) {
		const next = value.includes(slug)
			? value.filter((s) => s !== slug)
			: [...value, slug];
		onChange(next);
	}

	function isSelected(slug: string) {
		return value.includes(slug);
	}
</script>

<div class="space-y-3">
	<p class="text-xs text-muted-foreground">
		Peer agents this agent may invoke via <code>call_agent()</code>. Only agents currently
		registered in the Dapr agent registry are selectable; unregistered peers are hidden because the
		runtime drops them anyway.
	</p>

	{#if loading}
		<p class="text-xs text-muted-foreground">Loading peer agents…</p>
	{:else if error}
		<p class="text-xs text-destructive">{error}</p>
	{:else if registeredPeers.length === 0}
		<p class="text-xs text-muted-foreground">
			No eligible peer agents in this workspace. Register at least one agent
			(publish with the dual-write flag on) to enable callable-agents.
		</p>
	{:else}
		<div class="relative max-w-sm">
			<Search class="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
			<Input bind:value={query} class="pl-7 h-8" placeholder="Filter…" />
		</div>

		<ul class="space-y-1">
			{#each filtered as peer (peer.id)}
				<li>
					<button
						type="button"
						class="w-full flex items-center gap-2 p-2 rounded border text-left text-sm transition-colors {isSelected(
							peer.slug
						)
							? 'border-primary bg-primary/5'
							: 'border-border hover:bg-muted/40'}"
						onclick={() => toggle(peer.slug)}
					>
						<span class="text-base">{peer.avatar ?? '🤖'}</span>
						<span class="flex-1 min-w-0">
							<span class="flex items-center gap-2">
								<span class="truncate">{peer.name}</span>
								<RegistryStatusBadge
									mini
									status={peer.registryStatus}
									error={peer.registryError}
									syncedAt={peer.registrySyncedAt}
								/>
							</span>
							<span class="block text-[11px] text-muted-foreground truncate">
								{peer.slug}{peer.modelSpec ? ` · ${peer.modelSpec}` : ''}
							</span>
						</span>
						{#if isSelected(peer.slug)}
							<CircleCheck class="size-4 text-primary shrink-0" />
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if staleRefs.length > 0}
		<div class="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-300">
			<strong>Stale references:</strong>
			<span class="font-mono">{staleRefs.join(', ')}</span>
			— no longer registered. The resolver drops them at runtime; click one to remove it from this agent's config.
			<div class="flex flex-wrap gap-1 mt-1">
				{#each staleRefs as slug}
					<button
						type="button"
						class="px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-xs"
						onclick={() => onChange(value.filter((s) => s !== slug))}
					>
						remove {slug}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	{#if unregisteredCount > 0}
		<p class="text-[11px] text-muted-foreground">
			{unregisteredCount} peer agent{unregisteredCount === 1 ? '' : 's'} in this workspace
			not currently registered. Resync from the agent detail page to enable.
		</p>
	{/if}
</div>
