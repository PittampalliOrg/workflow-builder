<script lang="ts">
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

	// A unified leaf/dir model so the same tree renders three sources:
	//  - cli:       JuiceFS shared workspace via webdav (durable, live + after reap)
	//  - openshell: live workspace pod via SandboxFileBrowser
	//  - persisted: saved output files (files table)
	interface Item {
		path: string; // full path relative to the tree root
		isDir: boolean;
		sizeBytes: number;
		contentUrl?: string; // for files
	}
	interface TreeNode {
		name: string;
		path: string;
		isDir: boolean;
		item?: Item;
		children: TreeNode[];
	}

	type Mode = 'cli' | 'openshell' | 'persisted';

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let mode = $state<Mode>('persisted');
	let liveSandbox = $state<{ name: string } | null>(null);
	let items = $state.raw<Item[]>([]);
	let truncated = $state(false);

	let expanded = $state<Set<string>>(new Set());
	let selected = $state<Item | null>(null);
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
			liveSandbox = data.liveSandbox ?? null;

			if (data.cliWorkspace) {
				mode = 'cli';
				const wf = await fetch(`/api/workflows/executions/${executionId}/workspace-files`);
				const wd = wf.ok ? await wf.json() : { entries: [] };
				truncated = !!wd.truncated;
				items = (wd.entries ?? []).map(
					(e: { path: string; isDir: boolean; sizeBytes: number }) => ({
						path: e.path,
						isDir: e.isDir,
						sizeBytes: e.sizeBytes ?? 0,
						contentUrl: e.isDir
							? undefined
							: `/api/workflows/executions/${executionId}/workspace-content?path=${encodeURIComponent(e.path)}`
					})
				);
			} else if (liveSandbox) {
				mode = 'openshell';
			} else {
				mode = 'persisted';
				items = (data.files ?? []).map(
					(f: { id: string; name: string; sizeBytes: number }) => ({
						path: f.name,
						isDir: false,
						sizeBytes: f.sizeBytes ?? 0,
						contentUrl: `/api/v1/files/${encodeURIComponent(f.id)}/content`
					})
				);
			}
			// Auto-expand top-level directories.
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

	const tree = $derived(buildTree(items));

	function buildTree(list: Item[]): TreeNode[] {
		const root: TreeNode = { name: '', path: '', isDir: true, children: [] };
		const ensureDir = (segments: string[]): TreeNode => {
			let cur = root;
			let acc = '';
			for (const seg of segments) {
				acc = acc ? `${acc}/${seg}` : seg;
				let next = cur.children.find((c) => c.name === seg && c.isDir);
				if (!next) {
					next = { name: seg, path: acc, isDir: true, children: [] };
					cur.children.push(next);
				}
				cur = next;
			}
			return cur;
		};
		for (const it of list) {
			const segments = it.path.split('/').filter(Boolean);
			if (segments.length === 0) continue;
			if (it.isDir) {
				ensureDir(segments);
			} else {
				const parent = ensureDir(segments.slice(0, -1));
				const name = segments[segments.length - 1];
				if (!parent.children.find((c) => c.name === name && !c.isDir)) {
					parent.children.push({ name, path: it.path, isDir: false, item: it, children: [] });
				}
			}
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

	function iconFor(name: string) {
		const n = name.toLowerCase();
		if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(n)) return ImageIcon;
		if (/\.(webm|mp4|mov|mkv)$/.test(n)) return Video;
		if (/\.json$/.test(n)) return FileJson;
		if (/\.(ts|tsx|js|jsx|py|svelte|go|rs|java|c|cpp|sh|css|html?)$/.test(n)) return FileCode;
		if (/\.(md|txt|log|ya?ml|csv|toml|ini|env)$/.test(n)) return FileText;
		return File;
	}
	function isImage(name: string) {
		return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(name.toLowerCase());
	}
	function isVideo(name: string) {
		return /\.(webm|mp4|mov|mkv)$/.test(name.toLowerCase());
	}
	function isTextual(name: string) {
		return /\.(md|txt|log|ya?ml|csv|toml|ini|env|json|xml|svelte|ts|tsx|js|jsx|py|go|rs|sh|css|html?|sql|sh|dockerfile|gitignore)$/.test(
			name.toLowerCase()
		);
	}
	function baseName(p: string) {
		return p.split('/').pop() ?? p;
	}

	async function select(item: Item) {
		selected = item;
		previewText = null;
		previewError = null;
		if (!item.contentUrl || !isTextual(item.path)) return;
		previewLoading = true;
		try {
			const res = await fetch(item.contentUrl);
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
	{:else if node.item}
		{@const Icon = iconFor(node.name)}
		<button
			type="button"
			class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm hover:bg-muted {selected?.path ===
			node.item.path
				? 'bg-muted'
				: ''}"
			style="padding-left: {depth * 14 + 18}px"
			onclick={() => node.item && select(node.item)}
		>
			<Icon size={14} class="shrink-0 text-muted-foreground" />
			<span class="truncate">{node.name}</span>
			<span class="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">{fmtSize(node.item.sizeBytes)}</span>
		</button>
	{/if}
{/snippet}

{#if mode === 'openshell' && liveSandbox}
	<SandboxFileBrowser sandboxName={liveSandbox.name} />
{:else if loading}
	<div class="flex items-center gap-2 p-4 text-sm text-muted-foreground">
		<Loader2 size={14} class="animate-spin" /> Loading files…
	</div>
{:else if loadError}
	<div class="p-4 text-sm text-destructive">Failed to load files: {loadError}</div>
{:else if items.length === 0}
	<div class="p-4 text-sm text-muted-foreground">
		{mode === 'cli'
			? 'No files in the run workspace yet.'
			: 'No saved output files for this run.'}
	</div>
{:else}
	{#if truncated}
		<div class="mb-2 text-xs text-amber-600 dark:text-amber-400">
			Showing a partial listing (workspace is large).
		</div>
	{/if}
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
					<span class="truncate text-sm font-medium">{baseName(selected.path)}</span>
					{#if selected.contentUrl}
						<a
							class="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
							href={selected.contentUrl}
							target="_blank"
							rel="noreferrer"
						>
							<Download size={12} /> Download
						</a>
					{/if}
				</div>
				{#if selected.contentUrl && isImage(selected.path)}
					<img src={selected.contentUrl} alt={baseName(selected.path)} class="max-w-full rounded border border-border" />
				{:else if selected.contentUrl && isVideo(selected.path)}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video src={selected.contentUrl} controls preload="metadata" class="w-full rounded border border-border bg-black"></video>
				{:else if previewLoading}
					<div class="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 size={14} class="animate-spin" /> Loading…
					</div>
				{:else if previewError}
					<div class="text-sm text-destructive">Preview failed: {previewError}</div>
				{:else if previewText != null}
					<pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs">{previewText}</pre>
				{:else}
					<div class="text-sm text-muted-foreground">No inline preview for this file type. Use Download.</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}
