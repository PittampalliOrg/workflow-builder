<script lang="ts">
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import StatusPill from '$lib/components/shared/status-pill.svelte';
	import { ArrowLeft, Download, ExternalLink, FileArchive } from '@lucide/svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');
	const detail = $derived(data.detail);
	// Executions map to at most one archived source bundle (by executionId).
	const bundleByExecution = $derived(
		detail.ok
			? new Map(detail.bundles.map((b) => [b.executionId, b] as const))
			: new Map<string, never>()
	);

	function fmtBytes(n: number): string {
		if (!n) return '—';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}
	function fmtDuration(ms: number | null): string {
		if (ms == null) return '—';
		if (ms < 1000) return `${ms}ms`;
		const s = ms / 1000;
		if (s < 60) return `${s.toFixed(1)}s`;
		return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
	}
	function fmtTime(iso: string | null): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}
	function reasonLabel(reason: 'not-found' | 'no-summary' | 'malformed'): string {
		if (reason === 'not-found') return 'This preview has no archived files.';
		if (reason === 'no-summary')
			return 'No run summary was archived for this preview — only raw files are available below.';
		return 'The run summary could not be parsed (wrong schema or corrupt). Raw files are still listed below.';
	}
	const downloadHref = (fileId: string) => `/api/v1/files/${fileId}/content`;
</script>

<div class="p-6 space-y-4 max-w-4xl">
	<div>
		<a
			href="/workspaces/{slug}/previews/archived"
			class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
		>
			<ArrowLeft class="size-3.5" /> Archived previews
		</a>
	</div>

	<header class="flex items-start justify-between gap-4">
		<div class="min-w-0">
			<h1 class="text-xl font-semibold flex items-center gap-2">
				<FileArchive class="size-5" />
				<span class="truncate" title={detail.name}>{detail.name}</span>
			</h1>
			{#if detail.ok}
				<p class="text-sm text-muted-foreground mt-1">
					Archived {fmtTime(detail.archivedAt)}
					{#if detail.pool} · pool {detail.pool}{/if}
					{#if detail.executionsTotal != null} · {detail.executionsTotal} total run{detail.executionsTotal === 1 ? '' : 's'}{/if}
				</p>
			{/if}
		</div>
		{#if detail.ok && detail.url}
			<Button variant="outline" size="sm" href={detail.url} target="_blank">
				Preview URL <ExternalLink class="size-4" />
			</Button>
		{/if}
	</header>

	{#if !detail.ok}
		<Alert variant={detail.reason === 'not-found' ? 'default' : 'destructive'}>
			<AlertDescription>
				{reasonLabel(detail.reason)}
				{#if detail.message}<span class="opacity-70"> ({detail.message})</span>{/if}
			</AlertDescription>
		</Alert>
	{:else}
		{#if detail.artifactListingDegraded}
			<Alert variant="default">
				<AlertDescription>
					Source-bundle listing was unavailable at archive time — the run summary was preserved,
					but bundles may be incomplete.
				</AlertDescription>
			</Alert>
		{/if}

		<section class="space-y-2">
			<h2 class="text-sm font-medium">Executions</h2>
			<ResourceTable rows={detail.executions}>
				{#snippet header()}
					<th class="px-4 py-2.5 font-medium">Run</th>
					<th class="px-4 py-2.5 font-medium">Workflow</th>
					<th class="px-4 py-2.5 font-medium">Status</th>
					<th class="px-4 py-2.5 font-medium text-right">Duration</th>
					<th class="px-4 py-2.5 font-medium">Started</th>
					<th class="px-4 py-2.5 font-medium">Bundle</th>
				{/snippet}
				{#snippet row(e: (typeof detail.executions)[number])}
					{@const bundle = bundleByExecution.get(e.id)}
					<td class="px-4 py-2.5 font-mono text-xs">{e.id.slice(0, 12)}</td>
					<td class="px-4 py-2.5">
						<span class="truncate max-w-[180px] inline-block align-bottom" title={e.workflowId ?? ''}>
							{e.workflowName ?? e.workflowId ?? '—'}
						</span>
					</td>
					<td class="px-4 py-2.5">
						<StatusPill status={e.status ?? 'unknown'} />
					</td>
					<td class="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">
						{fmtDuration(e.durationMs)}
					</td>
					<td class="px-4 py-2.5 text-xs text-muted-foreground">{fmtTime(e.startedAt)}</td>
					<td class="px-4 py-2.5">
						{#if bundle}
							<a
								href={downloadHref(bundle.fileId)}
								class="inline-flex items-center gap-1 text-primary hover:underline text-xs"
							>
								<Download class="size-3" /> {fmtBytes(bundle.sizeBytes)}
							</a>
						{:else}
							<span class="text-muted-foreground text-xs">—</span>
						{/if}
					</td>
				{/snippet}
				{#snippet empty()}
					<p class="text-muted-foreground">No executions were captured in this archive.</p>
				{/snippet}
			</ResourceTable>
		</section>

		<section class="space-y-2">
			<h2 class="text-sm font-medium">Files</h2>
			<ul class="divide-y rounded-md border text-sm">
				{#each detail.files as f (f.id)}
					<li class="flex items-center gap-2 px-4 py-2.5">
						<Badge variant="outline" class="text-[10px] shrink-0">{f.kind}</Badge>
						<span class="truncate flex-1" title={f.name}>{f.name}</span>
						<span class="text-xs text-muted-foreground font-mono">{fmtBytes(f.sizeBytes)}</span>
						<a
							href={downloadHref(f.id)}
							class="inline-flex items-center gap-1 text-primary hover:underline text-xs"
						>
							<Download class="size-3" /> Download
						</a>
					</li>
				{:else}
					<li class="px-4 py-6 text-center text-muted-foreground text-sm">No files.</li>
				{/each}
			</ul>
		</section>

		{#if detail.notes.length > 0}
			<section class="space-y-1">
				<h2 class="text-sm font-medium">Notes</h2>
				<ul class="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
					{#each detail.notes as note (note)}
						<li>{note}</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</div>
