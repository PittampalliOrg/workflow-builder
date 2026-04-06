<script lang="ts">
	/**
	 * Action catalog browser — grouped by provider with search.
	 * Shows when a node has no action configured yet.
	 * Modeled after the Vercel workflow-builder-template action-grid.
	 */
	import { onMount } from 'svelte';
	import { Search, ChevronDown, ChevronRight, Globe } from 'lucide-svelte';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';

	export interface CatalogAction {
		name: string;
		displayName: string;
		description: string;
		pieceName: string;
		actionName: string;
		providerId: string | null;
		providerLabel: string | null;
		providerIconUrl: string | null;
		category: string | null;
		insertable: boolean;
		auth: { required: boolean; authType?: string } | null;
		inputSchema: Record<string, unknown> | null;
	}

	interface Props {
		onSelect: (action: CatalogAction) => void;
	}

	let { onSelect }: Props = $props();

	let actions = $state<CatalogAction[]>([]);
	let searchQuery = $state('');
	let loading = $state(true);
	let expandedGroups = $state(new Set<string>());

	// Fetch catalog on mount
	onMount(async () => {
		try {
			const res = await fetch('/api/action-catalog');
			if (res.ok) {
				const data = await res.json();
				actions = (data.items || []).filter((a: CatalogAction) => a.insertable);
			}
		} catch (e) {
			console.error('Failed to load action catalog:', e);
		} finally {
			loading = false;
		}
	});

	// Filter by search
	const filtered = $derived.by(() => {
		if (!searchQuery.trim()) return actions;
		const q = searchQuery.toLowerCase();
		return actions.filter(
			(a) =>
				a.displayName.toLowerCase().includes(q) ||
				a.description?.toLowerCase().includes(q) ||
				a.providerLabel?.toLowerCase().includes(q) ||
				a.pieceName.toLowerCase().includes(q)
		);
	});

	// Group by provider
	const grouped = $derived.by(() => {
		const map = new Map<string, { label: string; icon: string | null; actions: CatalogAction[] }>();
		for (const action of filtered) {
			const key = action.providerLabel || action.providerId || 'Other';
			if (!map.has(key)) {
				map.set(key, { label: key, icon: action.providerIconUrl, actions: [] });
			}
			map.get(key)!.actions.push(action);
		}
		// Sort: providers with more actions first
		return Array.from(map.entries()).sort((a, b) => b[1].actions.length - a[1].actions.length);
	});

	// Expand all groups by default when there's a search
	$effect(() => {
		if (searchQuery.trim()) {
			expandedGroups = new Set(grouped.map(([key]) => key));
		}
	});

	function toggleGroup(key: string) {
		const next = new Set(expandedGroups);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedGroups = next;
	}
</script>

<div class="flex h-full flex-col">
	<!-- Search -->
	<div class="p-3 pb-2">
		<div class="relative">
			<Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
			<Input
				bind:value={searchQuery}
				placeholder="Search actions..."
				class="h-8 pl-8 text-xs"
			/>
		</div>
	</div>

	<!-- Action list -->
	<div class="flex-1 overflow-y-auto px-1">
		{#if loading}
			<div class="flex items-center justify-center py-8 text-xs text-muted-foreground">
				Loading actions...
			</div>
		{:else if grouped.length === 0}
			<div class="flex items-center justify-center py-8 text-xs text-muted-foreground">
				No actions found
			</div>
		{:else}
			{#each grouped as [key, group]}
				<!-- Provider group header -->
				<button
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 transition-colors"
					onclick={() => toggleGroup(key)}
				>
					{#if expandedGroups.has(key)}
						<ChevronDown size={12} />
					{:else}
						<ChevronRight size={12} />
					{/if}

					{#if group.icon}
						<img src={group.icon} alt="" class="h-4 w-4 rounded-sm" />
					{:else}
						<Globe size={14} class="text-muted-foreground" />
					{/if}

					<span class="flex-1 text-left">{group.label}</span>
					<span class="text-[10px] text-muted-foreground/60">{group.actions.length}</span>
				</button>

				<!-- Actions in group -->
				{#if expandedGroups.has(key)}
					<div class="ml-2 mb-1">
						{#each group.actions as action}
							<button
								class="flex w-full items-start gap-2 rounded-md px-3 py-2 text-left hover:bg-accent/50 transition-colors group"
								onclick={() => onSelect(action)}
							>
								<div class="min-w-0 flex-1">
									<div class="text-xs font-medium text-foreground group-hover:text-primary truncate">
										{action.displayName}
									</div>
									{#if action.description}
										<div class="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">
											{action.description}
										</div>
									{/if}
								</div>
								{#if action.auth?.required}
									<span class="mt-0.5 shrink-0 rounded bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-500">
										auth
									</span>
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			{/each}
		{/if}
	</div>
</div>
