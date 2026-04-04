<script lang="ts">
	import { Dialog, DialogContent, DialogHeader, DialogTitle } from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import { Loader2, Search, Blocks } from 'lucide-svelte';
	import { createCatalogStore, type CatalogFunction } from '$lib/stores/catalog.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
		onSelect: (fn: CatalogFunction, definition: Record<string, unknown>) => void;
	}

	let { open, onClose, onSelect }: Props = $props();

	const catalog = createCatalogStore();
	let query = $state('');
	let selecting = $state<string | null>(null);

	let groups = $derived(catalog.search(query));
	let totalResults = $derived(groups.reduce((sum, g) => sum + g.functions.length, 0));

	$effect(() => {
		if (open) {
			catalog.load();
			query = '';
		}
	});

	async function handleSelect(fn: CatalogFunction) {
		selecting = fn.name;
		try {
			const definition = await catalog.getDefinition(fn.name, fn.version);
			onSelect(fn, definition);
			onClose();
		} catch (err) {
			console.error('Failed to load function definition:', err);
		} finally {
			selecting = null;
		}
	}

	function pieceDisplayName(pieceName: string): string {
		return pieceName
			.split('-')
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(' ');
	}
</script>

<Dialog {open} onOpenChange={(v) => { if (!v) onClose(); }}>
	<DialogContent class="max-w-xl max-h-[80vh] flex flex-col">
		<DialogHeader>
			<DialogTitle class="flex items-center gap-2 text-sm">
				<Blocks size={16} />
				Add Integration
			</DialogTitle>
		</DialogHeader>

		<div class="relative">
			<Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
			<Input
				placeholder="Search integrations..."
				bind:value={query}
				class="pl-8 text-xs"
				autofocus
			/>
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
					{query ? `No integrations matching "${query}"` : 'No integrations available'}
				</p>
			{:else}
				<p class="mb-2 text-[10px] text-muted-foreground">
					{totalResults} function{totalResults !== 1 ? 's' : ''}{query ? ` matching "${query}"` : ''}
				</p>
				{#each groups as group (group.pieceName)}
					<div class="mb-3">
						<div class="sticky top-0 z-10 bg-background py-1">
							<h3 class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
								{pieceDisplayName(group.pieceName)}
								<span class="ml-1 text-[9px] font-normal">({group.functions.length})</span>
							</h3>
						</div>
						<div class="space-y-0.5">
							{#each group.functions as fn (fn.name)}
								<button
									class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:opacity-50"
									onclick={() => handleSelect(fn)}
									disabled={selecting === fn.name}
								>
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-1.5">
											<span class="text-xs font-medium">{fn.displayName}</span>
											{#if selecting === fn.name}
												<Loader2 size={10} class="animate-spin" />
											{/if}
										</div>
										{#if fn.description}
											<p class="mt-0.5 text-[10px] text-muted-foreground line-clamp-1">{fn.description}</p>
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
