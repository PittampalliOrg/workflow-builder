<script lang="ts">
	import { Dialog, DialogContent, DialogHeader, DialogTitle } from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Select from '$lib/components/ui/select';
	import * as Avatar from '$lib/components/ui/avatar';
	import { Loader2, Search, Blocks, Code2, Workflow, Activity } from '@lucide/svelte';
	import { createActionCatalogStore, type ActionCatalogItem } from '$lib/stores/action-catalog.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
		onSelect: (action: ActionCatalogItem, definition: Record<string, unknown>) => void;
	}

	let { open, onClose, onSelect }: Props = $props();

	const catalog = createActionCatalogStore();
	let query = $state('');
	let selectedProviderFilter = $state('all');
	let selectedCategoryFilter = $state('all');
	let selecting = $state<string | null>(null);

	$effect(() => {
		catalog.query = query;
	});

	$effect(() => {
		catalog.selectedProvider = selectedProviderFilter;
	});

	$effect(() => {
		catalog.selectedCategory = selectedCategoryFilter;
	});

	let actions = $derived.by(() => catalog.filteredItems);
	let groups = $derived.by(() => {
		const map = new Map<string, ActionCatalogItem[]>();
		for (const action of actions) {
			const key = action.providerLabel || action.pieceName || action.service;
			const list = map.get(key) || [];
			list.push(action);
			map.set(key, list);
		}
		return Array.from(map.entries())
			.map(([group, items]) => ({
				group,
				items: items.sort((left, right) => left.displayName.localeCompare(right.displayName)),
			}))
			.sort((left, right) => left.group.localeCompare(right.group));
	});
	let totalResults = $derived(actions.length);

	$effect(() => {
		if (open) {
			catalog.load();
			query = '';
		}
	});

	async function handleSelect(action: ActionCatalogItem) {
		if (!action.insertable) return;
		selecting = action.id;
		try {
			const response = await fetch(`/api/action-catalog/${encodeURIComponent(action.id)}`);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			onSelect(action, await response.json());
			onClose();
		} catch (err) {
			console.error('Failed to load action definition:', err);
		} finally {
			selecting = null;
		}
	}

	function groupDisplayName(group: string): string {
		return group
			.split('-')
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(' ');
	}

	function iconFor(action: ActionCatalogItem) {
		if (action.kind === 'dapr-workflow') return Workflow;
		if (action.kind === 'dapr-activity') return Activity;
		return Code2;
	}

	function providerInitial(action: ActionCatalogItem): string {
		return (action.providerLabel || action.displayName || '?').trim().charAt(0).toUpperCase();
	}

	function formatLabel(value: string | null): string {
		return (value || '')
			.split(/[-_\s]+/)
			.filter(Boolean)
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
			.join(' ');
	}
</script>

<Dialog {open} onOpenChange={(v) => { if (!v) onClose(); }}>
	<DialogContent class="sm:max-w-xl max-h-[80vh] flex flex-col">
		<DialogHeader>
			<DialogTitle class="flex items-center gap-2 text-sm">
				<Blocks size={16} />
				Add Function
			</DialogTitle>
		</DialogHeader>

		<div class="relative">
			<Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
			<Input
				placeholder="Search actions, activities, workflows, and code functions..."
				bind:value={query}
				class="pl-8 text-xs"
				autofocus
			/>
		</div>

		<div class="flex flex-wrap gap-2">
			<Select.Root type="single" value={selectedProviderFilter} onValueChange={(value) => (selectedProviderFilter = value)}>
				<Select.Trigger class="h-8 min-w-[180px] text-xs">
					{selectedProviderFilter === 'all'
						? 'All providers'
						: catalog.availableProviders.find((provider) => provider.id === selectedProviderFilter)?.label || 'Provider'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="all">All providers</Select.Item>
					{#each catalog.availableProviders as provider (provider.id)}
						<Select.Item value={provider.id}>{provider.label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<Select.Root type="single" value={selectedCategoryFilter} onValueChange={(value) => (selectedCategoryFilter = value)}>
				<Select.Trigger class="h-8 min-w-[160px] text-xs">
					{selectedCategoryFilter === 'all' ? 'All categories' : formatLabel(selectedCategoryFilter)}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="all">All categories</Select.Item>
					{#each catalog.availableCategories as category (category)}
						<Select.Item value={category}>{formatLabel(category)}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<div class="flex-1 overflow-y-auto min-h-0 -mx-6 px-6">
			{#if catalog.loading}
				<div class="flex items-center justify-center py-8">
					<Loader2 size={20} class="animate-spin text-muted-foreground" />
				</div>
			{:else if catalog.error}
				<p class="py-8 text-center text-xs text-muted-foreground">{catalog.error}</p>
			{:else if groups.length === 0}
				<p class="py-8 text-center text-xs text-muted-foreground">
					{query ? `No functions matching "${query}"` : 'No functions available'}
				</p>
			{:else}
				<p class="mb-2 text-[10px] text-muted-foreground">
					{totalResults} action{totalResults !== 1 ? 's' : ''}{query ? ` matching "${query}"` : ''}
				</p>
				{#each groups as group (group.group)}
					<div class="mb-3">
						<div class="sticky top-0 z-10 bg-background py-1">
							<h3 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
								{groupDisplayName(group.group)}
								<span class="ml-1 text-[9px] font-normal">({group.items.length})</span>
							</h3>
						</div>
						<div class="space-y-0.5">
							{#each group.items as action (action.id)}
								{@const Icon = iconFor(action)}
								<button
									class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
									onclick={() => handleSelect(action)}
									disabled={selecting === action.id || !action.insertable}
								>
									{#if action.providerIconUrl}
										<Avatar.Root class="mt-0.5 h-7 w-7 rounded-md border border-border bg-background">
											<Avatar.Image src={action.providerIconUrl} alt={action.providerLabel || action.displayName} class="object-contain p-1" />
											<Avatar.Fallback class="rounded-md text-[9px] font-medium">
												{providerInitial(action)}
											</Avatar.Fallback>
										</Avatar.Root>
									{:else}
										<div class="mt-0.5 rounded-md bg-muted p-1.5">
											<Icon size={12} class="text-muted-foreground" />
										</div>
									{/if}
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-1.5">
											<span class="text-xs font-medium">{action.displayName}</span>
											{#if action.sourceKind === 'catalog' && action.language}
												<Badge variant="secondary" class="gap-1 text-[9px]">
													<Code2 size={10} />
													{action.language}
												</Badge>
											{/if}
											<Badge variant={action.insertable ? 'outline' : 'secondary'} class="text-[9px]">
												{action.insertable ? 'callable' : action.visibility}
											</Badge>
											{#if selecting === action.id}
												<Loader2 size={10} class="animate-spin" />
											{/if}
										</div>
										{#if action.description}
											<p class="mt-0.5 text-[10px] text-muted-foreground line-clamp-1">{action.description}</p>
										{/if}
										<div class="mt-1 flex flex-wrap gap-1">
											{#if action.providerLabel}
												<Badge variant="outline" class="text-[9px]">{action.providerLabel}</Badge>
											{/if}
											{#if action.category}
												<Badge variant="outline" class="text-[9px]">{formatLabel(action.category)}</Badge>
											{/if}
										</div>
										<p class="mt-1 text-[10px] text-muted-foreground">
											<span class="font-mono">{action.service}</span>
											{#if action.kind}
												<span> · {action.kind}</span>
											{/if}
											{#if action.version}
												<span> · {action.version}</span>
											{/if}
										</p>
										{#if !action.insertable}
											<p class="mt-1 text-[10px] text-muted-foreground">
												Inspectable in Activity Explorer only.
											</p>
										{/if}
									</div>
								</button>
							{/each}
						</div>
					</div>
				{/each}
			{/if}
		</div>
	</DialogContent>
</Dialog>
