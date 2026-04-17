<script lang="ts">
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import { FileBox, Upload } from 'lucide-svelte';

	type FileRow = {
		id: string;
		name: string;
		purpose: 'agent' | 'output';
		sizeBytes: number | null;
		contentType: string | null;
		scopeId: string | null;
		createdAt: string;
	};

	let files = $state<FileRow[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/files');
			if (res.status === 404 || res.status === 501) {
				// Upload endpoint not yet wired — show the "coming soon" state.
				files = [];
				return;
			}
			if (!res.ok) {
				errorMessage = `Failed to load files (${res.status})`;
				return;
			}
			const body = (await res.json()) as { files: FileRow[] };
			files = body.files ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	onMount(load);

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return files;
		return files.filter((f) => f.name.toLowerCase().includes(q));
	});

	function formatBytes(n: number | null): string {
		if (n === null) return '—';
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}
</script>

<ResourceListShell
	title="Files"
	subtitle="Upload once, mount into many sessions. Agent output artifacts also land here."
	itemLabel="file"
	itemCount={filtered.length}
	onSearch={(v) => (search = v)}
	primaryLabel="Upload"
	onPrimary={() => alert('File uploads arrive in the next iteration. Use session resources for now.')}
	{loading}
	{errorMessage}
	isEmpty={files.length === 0 || filtered.length === 0}
	{content}
	{empty}
/>

{#snippet content()}
	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
		{#each filtered as f (f.id)}
			<Card>
				<CardHeader class="pb-2">
					<CardTitle class="text-sm truncate">{f.name}</CardTitle>
				</CardHeader>
				<CardContent class="text-xs space-y-1 text-muted-foreground">
					<div>
						<Badge variant="outline" class="text-[10px]">{f.purpose}</Badge>
						<span class="ml-1">{formatBytes(f.sizeBytes)}</span>
					</div>
					{#if f.contentType}
						<div class="text-[10px]">{f.contentType}</div>
					{/if}
					{#if f.scopeId}
						<div class="text-[10px]">
							scope: <a href="/sessions/{f.scopeId}" class="text-primary underline">
								{f.scopeId}
							</a>
						</div>
					{/if}
				</CardContent>
			</Card>
		{/each}
	</div>
{/snippet}

{#snippet empty()}
	<div class="flex flex-col items-center justify-center text-center py-16">
		<div class="size-20 rounded-full bg-primary/10 flex items-center justify-center mb-4">
			<FileBox class="size-10 text-primary" />
		</div>
		<h2 class="text-xl font-semibold mb-2">Files</h2>
		<p class="text-muted-foreground mb-6 max-w-md">
			The CMA Files API mounts uploaded bytes into sessions and captures
			agent-written output artifacts from <code>/mnt/session/outputs/</code>.
			Standalone upload UI ships in the next iteration; in the meantime, mount
			GitHub repos directly from a session's Resources panel.
		</p>
		<Alert class="max-w-md border-dashed">
			<AlertDescription class="text-xs">
				<Upload class="inline size-3 mr-1" />
				Upload endpoint <code>POST /api/v1/files</code> is planned — the table
				+ storage backend are the last pieces before it ships.
			</AlertDescription>
		</Alert>
	</div>
{/snippet}
