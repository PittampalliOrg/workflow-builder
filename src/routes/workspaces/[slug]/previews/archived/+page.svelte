<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import { Archive, Boxes, FileArchive, RefreshCw } from '@lucide/svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');
	// ResourceTable needs an `id`; the scopeId is the stable per-archive key.
	const rows = $derived(data.previews.map((p) => ({ ...p, id: p.scopeId })));

	let refreshing = $state(false);
	async function refresh() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	function fmtBytes(n: number): string {
		if (!n) return '—';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}
	function formatRelative(iso: string): string {
		if (!iso) return '—';
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
		return new Date(iso).toLocaleDateString();
	}
</script>

<div class="p-6 space-y-4">
	<header class="flex items-start justify-between gap-4">
		<div>
			<h1 class="text-xl font-semibold flex items-center gap-2">
				<Archive class="size-5" /> Archived previews
			</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Run history and un-promoted source bundles preserved when a Tier-2 preview was torn down.
			</p>
		</div>
		<Button variant="outline" size="sm" onclick={refresh} disabled={refreshing}>
			<RefreshCw class="size-4 {refreshing ? 'animate-spin' : ''}" />
			Refresh
		</Button>
	</header>

	<ResourceTable {rows}>
		{#snippet header()}
			<th class="px-4 py-2.5 font-medium">Preview</th>
			<th class="px-4 py-2.5 font-medium text-right">Runs</th>
			<th class="px-4 py-2.5 font-medium text-right">Bundles</th>
			<th class="px-4 py-2.5 font-medium text-right">Size</th>
			<th class="px-4 py-2.5 font-medium">Archived</th>
		{/snippet}
		{#snippet row(p: (typeof rows)[number])}
			<td class="px-4 py-2.5">
				<a
					href="/workspaces/{slug}/previews/archived/{encodeURIComponent(p.name)}"
					class="inline-flex items-center gap-2 text-primary hover:underline"
				>
					<Boxes class="size-3.5" />
					<span class="truncate max-w-[280px]" title={p.name}>{p.name}</span>
				</a>
			</td>
			<td class="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
				{p.summaryCount}
			</td>
			<td class="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
				{p.bundleCount}
			</td>
			<td class="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
				{fmtBytes(p.totalBytes)}
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{formatRelative(p.lastArchivedAt)}
			</td>
		{/snippet}
		{#snippet empty()}
			<div class="flex flex-col items-center gap-2 text-muted-foreground">
				<FileArchive class="size-6" />
				<p>No archived previews yet.</p>
				<p class="text-xs">Tearing down a preview with run history archives it here.</p>
			</div>
		{/snippet}
	</ResourceTable>
</div>
