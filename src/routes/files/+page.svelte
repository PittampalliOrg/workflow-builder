<script lang="ts">
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import {
		Download,
		FileBox,
		FileText,
		Trash2,
		Upload
	} from 'lucide-svelte';

	type FileRow = {
		id: string;
		name: string;
		purpose: 'agent' | 'output';
		scopeId: string | null;
		contentType: string | null;
		sizeBytes: number;
		createdAt: string;
		archivedAt: string | null;
	};

	let files = $state<FileRow[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');
	let uploadInput: HTMLInputElement | null = $state(null);
	let uploading = $state(false);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/files');
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

	async function handleUpload(ev: Event) {
		const input = ev.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploading = true;
		errorMessage = null;
		try {
			const fd = new FormData();
			fd.append('file', file);
			fd.append('purpose', 'agent');
			const res = await fetch('/api/v1/files', { method: 'POST', body: fd });
			if (!res.ok) {
				errorMessage = `Upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
				return;
			}
			input.value = '';
			await load();
		} finally {
			uploading = false;
		}
	}

	async function archiveFile(id: string) {
		if (!confirm('Archive this file? The payload stays for audit but it no longer appears in lists.'))
			return;
		const res = await fetch(`/api/v1/files/${id}`, { method: 'PATCH' });
		if (res.ok) await load();
	}

	async function deleteFile(id: string) {
		if (!confirm('Permanently delete this file and its bytes?')) return;
		const res = await fetch(`/api/v1/files/${id}`, { method: 'DELETE' });
		if (res.ok) await load();
	}

	function download(id: string) {
		window.open(`/api/v1/files/${id}/content`, '_blank');
	}

	onMount(load);

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return files;
		return files.filter(
			(f) => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q)
		);
	});

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}
</script>

<input
	type="file"
	class="sr-only"
	bind:this={uploadInput}
	onchange={handleUpload}
/>

<ResourceListShell
	title="Files"
	subtitle="Upload once, mount into many sessions. Agent output artifacts also land here."
	itemLabel="file"
	itemCount={filtered.length}
	onSearch={(v) => (search = v)}
	primaryLabel={uploading ? 'Uploading…' : 'Upload'}
	onPrimary={() => uploadInput?.click()}
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
					<CardTitle class="text-sm truncate flex items-center gap-2">
						<FileText class="size-4 text-muted-foreground shrink-0" />
						<span class="truncate">{f.name}</span>
					</CardTitle>
				</CardHeader>
				<CardContent class="text-xs space-y-1.5 text-muted-foreground">
					<div class="flex flex-wrap items-center gap-1">
						<Badge variant="outline" class="text-[10px]">{f.purpose}</Badge>
						<span>{formatBytes(f.sizeBytes)}</span>
						{#if f.contentType}
							<span class="truncate">· {f.contentType}</span>
						{/if}
					</div>
					<div class="text-[10px]">
						Uploaded {new Date(f.createdAt).toLocaleString()}
					</div>
					{#if f.scopeId}
						<div class="text-[10px]">
							scope: <a href="/sessions/{f.scopeId}" class="text-primary underline">
								{f.scopeId}
							</a>
						</div>
					{/if}
					<div class="flex gap-1 pt-1">
						<Button
							variant="outline"
							size="sm"
							class="h-7 text-[11px]"
							onclick={() => download(f.id)}
						>
							<Download class="size-3" /> Download
						</Button>
						<Button
							variant="ghost"
							size="sm"
							class="h-7 text-[11px]"
							onclick={() => archiveFile(f.id)}
						>
							Archive
						</Button>
						<Button
							variant="ghost"
							size="sm"
							class="h-7 text-[11px] text-destructive"
							onclick={() => deleteFile(f.id)}
						>
							<Trash2 class="size-3" /> Delete
						</Button>
					</div>
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
		<h2 class="text-xl font-semibold mb-2">No files yet</h2>
		<p class="text-muted-foreground mb-6 max-w-md">
			Uploaded files are available to mount into session resources. Agent-written
			outputs from <code>/mnt/session/outputs/</code> land here automatically when
			a session completes.
		</p>
		<Button onclick={() => uploadInput?.click()} size="lg" disabled={uploading}>
			<Upload class="size-4 mr-1" />
			{uploading ? 'Uploading…' : 'Upload your first file'}
		</Button>
		<Alert class="mt-6 max-w-md border-dashed">
			<AlertDescription class="text-xs">
				Max upload size: 10 MB. Stored as Postgres bytea alongside session
				resources. Files are user-scoped — other members of your workspace
				don't see them unless they create their own upload.
			</AlertDescription>
		</Alert>
	</div>
{/snippet}
