<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		Folder,
		File,
		FileCode,
		FileJson,
		FileText,
		Image as ImageIcon,
		Video,
		ChevronRight,
		ChevronDown,
		Loader2,
		Download
	} from '@lucide/svelte';
	import SandboxFileBrowser from '$lib/components/sandbox/sandbox-file-browser.svelte';

	interface Props {
		executionId: string;
	}

	let { executionId }: Props = $props();

	interface FileRow {
		id: string;
		name: string;
		contentType: string | null;
		sizeBytes: number;
		createdAt: string;
	}
	interface TreeNode {
		name: string;
		path: string;
		isDir: boolean;
		file?: FileRow;
		children: TreeNode[];
	}

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let fileRows = $state.raw<FileRow[]>([]);
	let liveSandbox = $state<{ name: string } | null>(null);
	// 'live' | 'persisted'. Defaults to live when a live sandbox is available.
	let mode = $state<'live' | 'persisted'>('persisted');

	let expanded = $state<Set<string>>(new Set());
	let selected = $state<FileRow | null>(null);
	let previewText = $state<string | null>(null);
	let previewLoading = $state(false);
	let previewError = $state<string | null>(null);

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/files`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			fileRows = Array.isArray(data.files) ? data.files : [];
			liveSandbox = data.liveSandbox ?? null;
			mode = liveSandbox ? 'live' : 'persisted';
			// Auto-expand top-level directories for quick scanning.
			expanded = new Set(tree.filter((n) => n.isDir).map((n) => n.path));
		} catch (err) {
			loadError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (executionId) load();
	});

	const tree = $derived(buildTree(fileRows));

	function buildTree(rows: FileRow[]): TreeNode[] {
		const root: TreeNode = { name: '', path: '', isDir: true, children: [] };
		for (const f of rows) {
			const parts = f.name.split('/').filter(Boolean);
			if (parts.length === 0) continue;
			let cur = root;
			parts.forEach((seg, i) => {
				const isLeaf = i === parts.length - 1;
				const path = cur.path ? `${cur.path}/${seg}` : seg;
				let found = cur.children.find((c) => c.name === seg && c.isDir === !isLeaf);
				if (!found) {
					found = { name: seg, path, isDir: !isLeaf, children: [] };
					if (isLeaf) found.file = f;
					cur.children.push(found);
				}
				cur = found;
			});
		}
		const sortRec = (n: TreeNode) => {
			n.children.sort((a, b) =>
				a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
			);
			n.children.forEach(sortRec);
		};
		sortRec(root);
		return root.children;
	}

	function toggle(path: string) {
		const next = new Set(expanded);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		expanded = next;
	}

	function iconFor(file: FileRow) {
		const ct = (file.contentType ?? '').toLowerCase();
		const name = file.name.toLowerCase();
		if (ct.startsWith('image/')) return ImageIcon;
		if (ct.startsWith('video/')) return Video;
		if (ct.includes('json') || name.endsWith('.json')) return FileJson;
		if (/\.(ts|tsx|js|jsx|py|svelte|go|rs|java|c|cpp|sh|css|html)$/.test(name)) return FileCode;
		if (ct.startsWith('text/') || /\.(md|txt|log|yaml|yml)$/.test(name)) return FileText;
		return File;
	}

	function contentUrl(file: FileRow): string {
		return `/api/v1/files/${encodeURIComponent(file.id)}/content`;
	}

	function isImage(file: FileRow | null) {
		return !!file && (file.contentType ?? '').toLowerCase().startsWith('image/');
	}
	function isVideo(file: FileRow | null) {
		return !!file && (file.contentType ?? '').toLowerCase().startsWith('video/');
	}
	function isTextual(file: FileRow | null) {
		if (!file) return false;
		const ct = (file.contentType ?? '').toLowerCase();
		return (
			ct.startsWith('text/') ||
			ct.includes('json') ||
			ct.includes('xml') ||
			ct.includes('javascript') ||
			/\.(md|txt|log|ya?ml|csv|svelte|ts|tsx|js|jsx|py|go|rs|sh|css|html?)$/.test(
				file.name.toLowerCase()
			)
		);
	}

	async function select(file: FileRow) {
		selected = file;
		previewText = null;
		previewError = null;
		if (!isTextual(file)) return;
		previewLoading = true;
		try {
			const res = await fetch(contentUrl(file));
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			previewText = await res.text();
		} catch (err) {
			previewError = err instanceof Error ? err.message : String(err);
		} finally {
			previewLoading = false;
		}
	}

	function fmtSize(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

{#snippet treeNode(node: TreeNode, depth: number)}
	{#if node.isDir}
		<button
			type="button"
			class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm hover:bg-muted"
			style="padding-left: {depth * 14 + 4}px"
			onclick={() => toggle(node.path)}
		>
			{#if expanded.has(node.path)}
				<ChevronDown size={14} class="shrink-0 text-muted-foreground" />
			{:else}
				<ChevronRight size={14} class="shrink-0 text-muted-foreground" />
			{/if}
			<Folder size={14} class="shrink-0 text-muted-foreground" />
			<span class="truncate">{node.name}</span>
		</button>
		{#if expanded.has(node.path)}
			{#each node.children as child (child.path)}
				{@render treeNode(child, depth + 1)}
			{/each}
		{/if}
	{:else if node.file}
		{@const Icon = iconFor(node.file)}
		<button
			type="button"
			class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm hover:bg-muted {selected?.id ===
			node.file.id
				? 'bg-muted'
				: ''}"
			style="padding-left: {depth * 14 + 18}px"
			onclick={() => node.file && select(node.file)}
		>
			<Icon size={14} class="shrink-0 text-muted-foreground" />
			<span class="truncate">{node.name}</span>
			<span class="ml-auto shrink-0 pl-2 text-xs text-muted-foreground"
				>{fmtSize(node.file.sizeBytes)}</span
			>
		</button>
	{/if}
{/snippet}

{#if liveSandbox}
	<div class="mb-3 inline-flex items-center gap-1 rounded-md border border-border p-0.5 text-xs">
		<button
			type="button"
			class="rounded px-2 py-1 {mode === 'live' ? 'bg-muted font-medium' : 'text-muted-foreground'}"
			onclick={() => (mode = 'live')}>Live workspace</button
		>
		<button
			type="button"
			class="rounded px-2 py-1 {mode === 'persisted'
				? 'bg-muted font-medium'
				: 'text-muted-foreground'}"
			onclick={() => (mode = 'persisted')}>Saved outputs</button
		>
	</div>
{/if}

{#if mode === 'live' && liveSandbox}
	<SandboxFileBrowser sandboxName={liveSandbox.name} />
{:else if loading}
	<div class="flex items-center gap-2 p-4 text-sm text-muted-foreground">
		<Loader2 size={14} class="animate-spin" /> Loading files…
	</div>
{:else if loadError}
	<div class="p-4 text-sm text-destructive">Failed to load files: {loadError}</div>
{:else if fileRows.length === 0}
	<div class="p-4 text-sm text-muted-foreground">
		No saved output files for this run.
		{#if !liveSandbox}
			Files are captured from the agent's output directories when a run finishes.
		{/if}
	</div>
{:else}
	<div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,18rem)_1fr]">
		<div class="max-h-[60vh] overflow-y-auto rounded-md border border-border p-1">
			{#each tree as node (node.path)}
				{@render treeNode(node, 0)}
			{/each}
		</div>
		<div class="max-h-[60vh] overflow-y-auto rounded-md border border-border p-3">
			{#if !selected}
				<div class="text-sm text-muted-foreground">Select a file to preview.</div>
			{:else}
				<div class="mb-2 flex items-center gap-2">
					<span class="truncate text-sm font-medium">{selected.name}</span>
					<a
						class="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
						href={contentUrl(selected)}
						target="_blank"
						rel="noreferrer"
					>
						<Download size={12} /> Download
					</a>
				</div>
				{#if isImage(selected)}
					<img src={contentUrl(selected)} alt={selected.name} class="max-w-full rounded border border-border" />
				{:else if isVideo(selected)}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video src={contentUrl(selected)} controls preload="metadata" class="w-full rounded border border-border bg-black"></video>
				{:else if previewLoading}
					<div class="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 size={14} class="animate-spin" /> Loading…
					</div>
				{:else if previewError}
					<div class="text-sm text-destructive">Preview failed: {previewError}</div>
				{:else if previewText != null}
					<pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs">{previewText}</pre>
				{:else}
					<div class="text-sm text-muted-foreground">
						No inline preview for this file type. Use Download.
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}
