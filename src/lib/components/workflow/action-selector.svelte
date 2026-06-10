<script lang="ts">
	/**
	 * Action catalog browser — grouped by provider with search.
	 * Shows when a node has no action configured yet.
	 * AP Cloud builder organization: search + category tabs
	 * (Core | Apps | AI & Agents) + Popular/Highlights, with search results
	 * grouped piece → actions.
	 */
	import { onMount, tick } from 'svelte';
	import { Search, ChevronDown, ChevronRight, Globe, Sparkles } from '@lucide/svelte';
	import { Input } from '$lib/components/ui/input';
	import {
		PICKER_CATEGORIES,
		matchesPickerCategory,
		groupPickerItemsByPiece,
		popularPieceGroups,
		pickerHighlights,
		type PickerCategoryId,
	} from '$lib/stores/action-catalog.svelte';

	export interface CatalogAction {
		id: string;
		slug: string;
		name: string;
		displayName: string;
		description: string;
		pieceName: string;
		actionName: string;
		service: string;
		kind: string;
		visibility: string;
		sourceKind: string;
		version: string | null;
		language: 'typescript' | 'python' | null;
		entrypoint: string | null;
		providerId: string | null;
		providerLabel: string | null;
		providerIconUrl: string | null;
		category: string | null;
		insertable: boolean;
		auth: { required: boolean; authType?: string } | null;
		inputSchema: Record<string, unknown> | null;
		taskConfig?: Record<string, unknown> | null;
	}

	interface Props {
		onSelect: (action: CatalogAction) => void;
	}

	let { onSelect }: Props = $props();

	let actions = $state<CatalogAction[]>([]);
	let searchQuery = $state('');
	let activeCategory = $state<PickerCategoryId>('all');
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

	// Filter by category tab, then by search
	const filtered = $derived.by(() => {
		const inCategory = actions.filter((a) => matchesPickerCategory(a, activeCategory));
		if (!searchQuery.trim()) return inCategory;
		const q = searchQuery.toLowerCase();
		return inCategory.filter(
			(a) =>
				a.displayName.toLowerCase().includes(q) ||
				a.description?.toLowerCase().includes(q) ||
				a.providerLabel?.toLowerCase().includes(q) ||
				a.pieceName.toLowerCase().includes(q)
		);
	});

	// Group piece → actions (AP Cloud search-result pattern)
	const grouped = $derived.by(() =>
		groupPickerItemsByPiece(filtered).sort((a, b) => b.items.length - a.items.length),
	);

	// Popular pieces + highlight actions (shown when not searching)
	const popularGroups = $derived(popularPieceGroups(groupPickerItemsByPiece(filtered)));
	const highlights = $derived(pickerHighlights(filtered));
	const showPopular = $derived(
		!searchQuery.trim() && (popularGroups.length > 0 || highlights.length > 0),
	);

	// Expand all groups by default when there's a search
	$effect(() => {
		if (searchQuery.trim()) {
			expandedGroups = new Set(grouped.map((group) => group.key));
		}
	});

	function toggleGroup(key: string) {
		const next = new Set(expandedGroups);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedGroups = next;
	}

	async function jumpToGroup(key: string) {
		if (!expandedGroups.has(key)) {
			expandedGroups = new Set([...expandedGroups, key]);
		}
		await tick();
		document
			.getElementById(`action-selector-group-${key}`)
			?.scrollIntoView({ block: 'start', behavior: 'smooth' });
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

	<!-- Category tabs (AP Cloud picker pattern) -->
	<div class="flex flex-wrap gap-1 px-3 pb-2">
		{#each PICKER_CATEGORIES as category (category.id)}
			<button
				class="rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-colors {activeCategory ===
				category.id
					? 'border-primary/50 bg-primary/10 text-primary'
					: 'border-border text-muted-foreground hover:bg-accent/50'}"
				onclick={() => (activeCategory = category.id)}
			>
				{category.label}
			</button>
		{/each}
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
			{#if showPopular}
				<!-- Popular pieces + highlight actions (AP Cloud columns) -->
				<div class="mb-2 px-2">
					{#if popularGroups.length > 0}
						<p class="px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
							Popular
						</p>
						<div class="flex flex-wrap gap-1">
							{#each popularGroups as group (group.key)}
								<button
									class="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[10px] hover:bg-accent/50 transition-colors"
									onclick={() => jumpToGroup(group.key)}
								>
									{#if group.iconUrl}
										<img src={group.iconUrl} alt="" class="h-3.5 w-3.5 rounded-sm" />
									{:else}
										<Globe size={12} class="text-muted-foreground" />
									{/if}
									<span>{group.label}</span>
								</button>
							{/each}
						</div>
					{/if}
					{#if highlights.length > 0}
						<p class="px-1 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
							Highlights
						</p>
						{#each highlights as action (action.id)}
							<button
								class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50 transition-colors group"
								onclick={() => onSelect(action)}
							>
								{#if action.providerIconUrl}
									<img src={action.providerIconUrl} alt="" class="h-4 w-4 rounded-sm shrink-0" />
								{:else}
									<Sparkles size={13} class="shrink-0 text-muted-foreground" />
								{/if}
								<span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground group-hover:text-primary">
									{action.displayName}
								</span>
								{#if action.providerLabel}
									<span class="shrink-0 text-[9px] text-muted-foreground/60">{action.providerLabel}</span>
								{/if}
							</button>
						{/each}
					{/if}
					<div class="mt-1 mb-1 h-px bg-border"></div>
				</div>
			{/if}
			{#each grouped as group (group.key)}
				<!-- Piece group header (logo + name, actions beneath) -->
				<button
					id={`action-selector-group-${group.key}`}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50 transition-colors"
					onclick={() => toggleGroup(group.key)}
				>
					{#if expandedGroups.has(group.key)}
						<ChevronDown size={12} />
					{:else}
						<ChevronRight size={12} />
					{/if}

					{#if group.iconUrl}
						<img src={group.iconUrl} alt="" class="h-4 w-4 rounded-sm" />
					{:else}
						<Globe size={14} class="text-muted-foreground" />
					{/if}

					<span class="flex-1 text-left">{group.label}</span>
					<span class="text-[10px] text-muted-foreground/60">{group.items.length}</span>
				</button>

				<!-- Actions in group -->
				{#if expandedGroups.has(group.key)}
					<div class="ml-2 mb-1">
						{#each group.items as action (action.id)}
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
