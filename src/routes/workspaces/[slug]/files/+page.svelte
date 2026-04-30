<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import ApiSnippet from '$lib/components/console/api-snippet.svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import RowMoreActions from '$lib/components/console/row-more-actions.svelte';
	import { ArrowRight, Download, ExternalLink, FileBox, Upload } from '@lucide/svelte';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

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
	let jumpId = $state('');
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

	function jumpToFile() {
		const id = jumpId.trim();
		if (!id) return;
		const match = files.find((f) => f.id === id);
		if (match) {
			download(match.id);
		}
	}

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}
	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
		return new Date(iso).toLocaleDateString();
	}

	// CMA-parity empty-state upload snippets. Uses the Anthropic SDK shape for
	// curated templates; the cURL variant shows the minimal HTTP call.
	const SNIPPET_CURL = `curl -X POST $WORKFLOW_BUILDER_URL/api/v1/files \\
  -H "Authorization: Bearer $WFB_API_KEY" \\
  -F "file=@/path/to/document.pdf" \\
  -F "purpose=agent"`;
	const SNIPPET_PYTHON = `from pathlib import Path
import requests

with Path("/path/to/document.pdf").open("rb") as fp:
    res = requests.post(
        f"{WORKFLOW_BUILDER_URL}/api/v1/files",
        headers={"Authorization": f"Bearer {WFB_API_KEY}"},
        files={"file": ("document.pdf", fp, "application/pdf")},
        data={"purpose": "agent"},
    )
    res.raise_for_status()
    file = res.json()
print(file["id"])`;
	const SNIPPET_TS = `const form = new FormData();
form.append('file', new Blob([await Deno.readFile('/path/to/document.pdf')]),
  'document.pdf');
form.append('purpose', 'agent');

const res = await fetch(\`\${WORKFLOW_BUILDER_URL}/api/v1/files\`, {
  method: 'POST',
  headers: { Authorization: \`Bearer \${WFB_API_KEY}\` },
  body: form,
});
if (!res.ok) throw new Error(\`Upload failed \${res.status}\`);
const file = await res.json();
console.log(file.id);`;

	onMount(load);
</script>

<input type="file" class="sr-only" bind:this={uploadInput} onchange={handleUpload} />

<div class="p-6 space-y-5 max-w-6xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">Files</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Only files in the current workspace are shown. Agent-written outputs land here
				automatically when a session completes.
			</p>
		</div>
		<Button onclick={() => uploadInput?.click()} disabled={uploading}>
			<Upload class="size-4" />
			{uploading ? 'Uploading…' : 'Upload'}
		</Button>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if files.length > 0}
		<div class="flex items-center gap-3 flex-wrap">
			<div class="relative flex-1 min-w-[240px] max-w-md">
				<ArrowRight class="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
				<Input
					class="pl-9 pr-3 h-9"
					placeholder="Go to file ID"
					bind:value={jumpId}
					onkeydown={(e) => {
						if (e.key === 'Enter') jumpToFile();
					}}
				/>
			</div>
		</div>
	{/if}

	<ResourceTable rows={files} {loading}>
		{#snippet header()}
			<th class="px-4 py-2.5 font-medium">ID</th>
			<th class="px-4 py-2.5 font-medium">Name</th>
			<th class="px-4 py-2.5 font-medium">Purpose</th>
			<th class="px-4 py-2.5 font-medium">Size</th>
			<th class="px-4 py-2.5 font-medium">Created</th>
			<th class="px-4 py-2.5 font-medium w-10"></th>
		{/snippet}
		{#snippet row(f: FileRow)}
			<td class="px-4 py-2.5">
				<CopyIdButton value={f.id} />
			</td>
			<td class="px-4 py-2.5">
				<div class="min-w-0 flex-1">
					<div class="truncate">{f.name}</div>
					{#if f.scopeId}
						<a
							href="/workspaces/{slug}/sessions/{f.scopeId}"
							class="text-[10px] text-primary hover:underline"
							onclick={(e) => e.stopPropagation()}
						>
							scope: {f.scopeId.slice(0, 12)}
						</a>
					{/if}
				</div>
			</td>
			<td class="px-4 py-2.5">
				<Badge
					variant="outline"
					class="text-[10px] {f.purpose === 'output'
						? 'bg-emerald-500/15 text-emerald-300 border-transparent'
						: 'bg-blue-500/15 text-blue-300 border-transparent'}"
				>
					{f.purpose}
				</Badge>
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground font-mono">
				{formatBytes(f.sizeBytes)}
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{formatRelative(f.createdAt)}
			</td>
			<td class="px-4 py-2.5" onclick={(e) => e.stopPropagation()}>
				<RowMoreActions
					actions={[
						{ label: 'Download', onClick: () => download(f.id) },
						{
							label: 'Archive',
							onClick: () => archiveFile(f.id)
						},
						{
							label: 'Delete',
							onClick: () => deleteFile(f.id),
							destructive: true,
							separator: true
						}
					]}
				/>
			</td>
		{/snippet}
		{#snippet empty()}
			<div class="flex flex-col items-center justify-center py-10 space-y-3">
				<div class="size-14 rounded-full bg-primary/10 flex items-center justify-center">
					<FileBox class="size-7 text-primary" />
				</div>
				<h2 class="text-base font-semibold">No files yet</h2>
				<p class="text-muted-foreground text-sm max-w-md text-center">
					Upload one from the button above, or copy the template below to wire the upload
					into your app.
				</p>
				<div class="w-full max-w-2xl pt-2">
					<ApiSnippet curl={SNIPPET_CURL} python={SNIPPET_PYTHON} typescript={SNIPPET_TS} />
				</div>
				<div class="flex items-center gap-3 pt-1">
					<Button onclick={() => uploadInput?.click()} disabled={uploading}>
						<Upload class="size-4" />
						{uploading ? 'Uploading…' : 'Upload your first file'}
					</Button>
					<a
						href="/docs/en/files"
						target="_blank"
						rel="noreferrer"
						class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
					>
						<ExternalLink class="size-3" /> View docs
					</a>
				</div>
			</div>
		{/snippet}
	</ResourceTable>
</div>
