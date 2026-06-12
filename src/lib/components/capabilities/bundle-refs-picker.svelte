<script lang="ts">
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Loader2, Package, Plus, RefreshCw, X } from '@lucide/svelte';
	import type { BundleRef } from '$lib/types/agents';

	// Client-safe mirror of CapabilityBundleSummary (the server type lives under
	// $lib/server and can't be imported into a component).
	type BundleSummary = {
		id: string;
		slug: string;
		name: string;
		description: string | null;
		tags: string[];
		currentVersion: number | null;
		isArchived: boolean;
	};

	interface Props {
		value: BundleRef[];
		onChange: (next: BundleRef[]) => void;
		projectId?: string | null;
	}

	let { value, onChange, projectId = null }: Props = $props();

	let bundles = $state<BundleSummary[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);

	onMount(() => void load());

	async function load() {
		loading = true;
		loadError = null;
		try {
			const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
			const res = await fetch(`/api/capability-bundles${qs}`);
			if (!res.ok) {
				loadError = `Failed to load bundles (${res.status})`;
				return;
			}
			const data = (await res.json()) as { bundles: BundleSummary[] };
			bundles = data.bundles ?? [];
		} catch (err) {
			loadError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function summaryFor(id: string): BundleSummary | undefined {
		return bundles.find((b) => b.id === id);
	}

	let available = $derived(
		bundles.filter((b) => !b.isArchived && !value.some((r) => r.id === b.id))
	);

	function attach(b: BundleSummary) {
		if (value.some((r) => r.id === b.id)) return;
		onChange([...value, { id: b.id }]);
	}

	function detach(id: string) {
		onChange(value.filter((r) => r.id !== id));
	}

	function togglePin(ref: BundleRef, b: BundleSummary | undefined) {
		const pinned = ref.version != null;
		onChange(
			value.map((r) =>
				r.id === ref.id
					? pinned
						? { id: r.id }
						: { id: r.id, version: b?.currentVersion ?? undefined }
					: r
			)
		);
	}
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between gap-2">
		<p class="text-xs text-muted-foreground">
			Reusable capability bundles merge their MCP servers, skills, tools, hooks and
			prompt presets into this agent at runtime. The agent's own config wins on conflict.
		</p>
		<Button variant="outline" size="sm" onclick={() => void load()}>
			{#if loading}
				<Loader2 class="size-3 animate-spin" />
			{:else}
				<RefreshCw class="size-3" />
			{/if}
			Refresh
		</Button>
	</div>

	{#if loadError}
		<div class="text-xs text-destructive">{loadError}</div>
	{/if}

	{#if available.length > 0}
		<div class="space-y-1.5">
			<p class="text-[11px] font-medium text-muted-foreground">Available bundles</p>
			<div class="flex flex-wrap gap-2">
				{#each available as b (b.id)}
					<Button variant="outline" size="sm" onclick={() => attach(b)}>
						<Plus class="size-3" />
						{b.name}
						{#if b.currentVersion}<span class="text-muted-foreground">v{b.currentVersion}</span>{/if}
					</Button>
				{/each}
			</div>
		</div>
	{/if}

	<div class="space-y-2">
		<p class="text-[11px] font-medium text-muted-foreground">Attached ({value.length})</p>
		{#if value.length === 0}
			<div class="rounded border border-dashed p-3 text-xs text-muted-foreground">
				No bundles attached. Create reusable bundles under
				<a href="capability-bundles" class="underline">Capability bundles</a>, then attach them here.
			</div>
		{:else}
			<div class="space-y-2">
				{#each value as ref (ref.id)}
					{@const b = summaryFor(ref.id)}
					<div class="rounded border p-3">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<Package class="size-3.5 text-muted-foreground" />
									<span class="font-medium text-sm truncate">{b?.name ?? ref.id}</span>
									{#if ref.version != null}
										<Badge variant="outline">v{ref.version} (pinned)</Badge>
									{:else}
										<Badge variant="secondary">latest{b?.currentVersion ? ` (v${b.currentVersion})` : ''}</Badge>
									{/if}
									{#if b?.isArchived}<Badge variant="destructive">archived</Badge>{/if}
								</div>
								{#if b?.description}
									<p class="text-[11px] text-muted-foreground mt-1 line-clamp-2">{b.description}</p>
								{:else if !b}
									<p class="text-[11px] text-destructive mt-1">
										Bundle not found in this workspace — it may have been deleted.
									</p>
								{/if}
							</div>
							<div class="flex items-center gap-1">
								<Button
									variant="ghost"
									size="sm"
									class="h-7 text-[11px]"
									onclick={() => togglePin(ref, b)}
								>
									{ref.version != null ? 'Use latest' : 'Pin version'}
								</Button>
								<Button variant="ghost" size="icon" class="size-7" onclick={() => detach(ref.id)}>
									<X class="size-3" />
								</Button>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
