<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		Folder,
		File,
		FileCode,
		FileText,
		FileJson,
		ChevronRight,
		ChevronDown,
		RefreshCw,
		Loader2,
		ArrowLeft,
		Pencil,
		Lock
	} from 'lucide-svelte';
	import SandboxCodeViewer from './sandbox-code-viewer.svelte';
	import SandboxFileEditor from './sandbox-file-editor.svelte';

	interface Props {
		sandboxName: string;
	}

	let { sandboxName }: Props = $props();

	type FileScope = 'workspace' | 'container';

	interface FileEntry {
		path: string;
		name: string;
		isDirectory: boolean;
		scope?: FileScope;
		size?: number | null;
		mode?: string | null;
		children?: FileEntry[];
		loaded?: boolean;
		loading?: boolean;
		error?: string | null;
	}

	let scope = $state<FileScope>('workspace');
	let tree = $state.raw<FileEntry[]>([]);
	let loading = $state(true);
	let expandedDirs = $state<Set<string>>(new Set());
	let selectedFile = $state<string | null>(null);
	let editMode = $state(false);
	let fileContent = $state<string | null>(null);
	let fileLoading = $state(false);
	let loadError = $state<string | null>(null);

	const rootPath = $derived(scope === 'workspace' ? '/sandbox' : '/');
	const isReadOnly = $derived(scope === 'container');

	async function requestFiles(action: 'list' | 'read', path: string) {
		const res = await fetch(`/api/sandboxes/${encodeURIComponent(sandboxName)}/files`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action,
				scope,
				path,
				maxDepth: scope === 'workspace' ? 3 : 1,
				maxBytes: 262144
			})
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || data.ok === false) {
			throw new Error(data.error ?? `File ${action} failed`);
		}
		return data;
	}

	async function loadRoot() {
		loading = true;
		loadError = null;
		selectedFile = null;
		fileContent = null;
		editMode = false;
		expandedDirs = new Set([rootPath]);
		try {
			const data = await requestFiles('list', rootPath);
			tree = buildTree(data.entries ?? [], rootPath, scope === 'workspace' ? 3 : 1);
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Failed to load files';
			tree = [];
		} finally {
			loading = false;
		}
	}

	function buildTree(entries: FileEntry[], root: string, depth: number): FileEntry[] {
		const map = new Map<string, FileEntry>();
		const rootEntries: FileEntry[] = [];
		const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

		for (const entry of sorted) {
			if (entry.path === root) continue;
			const relative = root === '/' ? entry.path.replace(/^\//, '') : entry.path.replace(root + '/', '');
			if (!relative) continue;
			const parts = relative.split('/');
			const isDirectory =
				Boolean(entry.isDirectory) ||
				sorted.some((other) => other.path !== entry.path && other.path.startsWith(entry.path + '/'));

			const node: FileEntry = {
				path: entry.path,
				name: entry.name || parts[parts.length - 1],
				isDirectory,
				scope,
				size: entry.size ?? null,
				mode: entry.mode ?? null,
				children: isDirectory ? [] : undefined,
				loaded: isDirectory ? depth > parts.length : undefined
			};
			map.set(entry.path, node);

			if (parts.length === 1) {
				rootEntries.push(node);
			} else {
				const parentPath = root === '/' ? '/' + parts.slice(0, -1).join('/') : root + '/' + parts.slice(0, -1).join('/');
				const parent = map.get(parentPath);
				if (parent?.children) parent.children.push(node);
			}
		}

		sortNodes(rootEntries);
		return rootEntries;
	}

	function sortNodes(nodes: FileEntry[]) {
		nodes.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const node of nodes) {
			if (node.children) sortNodes(node.children);
		}
	}

	function updateNode(nodes: FileEntry[], path: string, update: (node: FileEntry) => FileEntry): FileEntry[] {
		return nodes.map((node) => {
			if (node.path === path) return update(node);
			if (node.children) {
				return { ...node, children: updateNode(node.children, path, update) };
			}
			return node;
		});
	}

	async function loadChildren(path: string) {
		tree = updateNode(tree, path, (node) => ({ ...node, loading: true, error: null }));
		try {
			const data = await requestFiles('list', path);
			const children = buildTree(data.entries ?? [], path, 1);
			tree = updateNode(tree, path, (node) => ({
				...node,
				children,
				loaded: true,
				loading: false,
				error: null
			}));
		} catch (err) {
			tree = updateNode(tree, path, (node) => ({
				...node,
				loading: false,
				error: err instanceof Error ? err.message : 'Failed to load directory'
			}));
		}
	}

	async function toggleDir(entry: FileEntry) {
		const next = new Set(expandedDirs);
		if (next.has(entry.path)) {
			next.delete(entry.path);
			expandedDirs = next;
			return;
		}
		next.add(entry.path);
		expandedDirs = next;
		if (!entry.loaded && !entry.loading) {
			await loadChildren(entry.path);
		}
	}

	async function openFile(path: string) {
		selectedFile = path;
		fileContent = null;
		editMode = false;
		fileLoading = true;
		try {
			const data = await requestFiles('read', path);
			fileContent = data.content ?? '';
		} catch (err) {
			fileContent = err instanceof Error ? `(${err.message})` : '(failed to read file)';
		} finally {
			fileLoading = false;
		}
	}

	function fileIcon(name: string) {
		if (name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.svelte') || name.endsWith('.py'))
			return FileCode;
		if (name.endsWith('.json') || name.endsWith('.yaml') || name.endsWith('.yml')) return FileJson;
		if (name.endsWith('.md') || name.endsWith('.txt') || name.endsWith('.log')) return FileText;
		return File;
	}

	function selectScope(nextScope: FileScope) {
		if (scope === nextScope) return;
		scope = nextScope;
	}

	$effect(() => {
		scope;
		loadRoot();
	});
</script>

<div class="flex h-full gap-0 overflow-hidden">
	<div class="w-72 shrink-0 overflow-auto border-r border-border">
		<div class="border-b border-border px-3 py-2">
			<div class="mb-2 flex items-center justify-between">
				<span class="text-xs font-medium text-muted-foreground">Files</span>
				<Button variant="ghost" size="icon" class="h-6 w-6" onclick={loadRoot}>
					<RefreshCw class="h-3 w-3" />
				</Button>
			</div>
			<div class="grid grid-cols-2 rounded border border-border p-0.5 text-xs">
				<button
					class="rounded px-2 py-1 {scope === 'workspace' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}"
					onclick={() => selectScope('workspace')}
				>
					Workspace
				</button>
				<button
					class="rounded px-2 py-1 {scope === 'container' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}"
					onclick={() => selectScope('container')}
				>
					Container
				</button>
			</div>
			<div class="mt-2 flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
				{#if isReadOnly}
					<Lock class="h-3 w-3" />
				{/if}
				<span class="truncate">{rootPath}</span>
				{#if isReadOnly}
					<span class="ml-auto shrink-0">read-only</span>
				{/if}
			</div>
		</div>

		{#if loading}
			<div class="flex items-center justify-center py-8">
				<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
			</div>
		{:else if loadError}
			<div class="px-3 py-4 text-xs text-destructive">{loadError}</div>
		{:else}
			<div class="py-1">
				{#each tree as entry}
					{@render treeNode(entry, 0)}
				{/each}
				{#if tree.length === 0}
					<div class="px-3 py-4 text-xs text-muted-foreground">No files found.</div>
				{/if}
			</div>
		{/if}
	</div>

	<div class="flex-1 overflow-auto">
		{#if selectedFile}
			{#if editMode && fileContent !== null && selectedFile && !isReadOnly}
				<SandboxFileEditor
					{sandboxName}
					filePath={selectedFile}
					initialContent={fileContent}
					onClose={() => (editMode = false)}
					onSaved={() => {
						editMode = false;
						openFile(selectedFile!);
					}}
				/>
			{:else}
				<div class="flex items-center gap-2 border-b border-border px-4 py-2">
					<button onclick={() => { selectedFile = null; editMode = false; }} class="text-muted-foreground hover:text-foreground">
						<ArrowLeft class="h-3.5 w-3.5" />
					</button>
					<span class="flex-1 truncate font-mono text-xs text-muted-foreground">{selectedFile}</span>
					{#if isReadOnly}
						<span class="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">read-only</span>
					{:else if fileContent !== null}
						<button onclick={() => (editMode = true)} class="text-muted-foreground hover:text-foreground" title="Edit file">
							<Pencil class="h-3.5 w-3.5" />
						</button>
					{/if}
				</div>
				{#if fileLoading}
					<div class="flex items-center justify-center py-12">
						<Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
					</div>
				{:else if fileContent !== null}
					<SandboxCodeViewer code={fileContent} filename={selectedFile ?? undefined} />
				{/if}
			{/if}
		{:else}
			<div class="flex items-center justify-center py-12 text-sm text-muted-foreground">
				Select a file to view its contents
			</div>
		{/if}
	</div>
</div>

{#snippet treeNode(entry: FileEntry, depth: number)}
	{#if entry.isDirectory}
		<button
			onclick={() => toggleDir(entry)}
			class="flex w-full items-center gap-1.5 px-2 py-1 text-xs hover:bg-muted/50"
			style="padding-left: {depth * 16 + 8}px"
			title={entry.path}
		>
			{#if entry.loading}
				<Loader2 class="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
			{:else if expandedDirs.has(entry.path)}
				<ChevronDown class="h-3 w-3 shrink-0 text-muted-foreground" />
			{:else}
				<ChevronRight class="h-3 w-3 shrink-0 text-muted-foreground" />
			{/if}
			<Folder class="h-3.5 w-3.5 shrink-0 text-blue-400" />
			<span class="truncate">{entry.name}</span>
		</button>
		{#if entry.error}
			<div class="truncate px-2 py-1 text-[11px] text-destructive" style="padding-left: {depth * 16 + 24}px">
				{entry.error}
			</div>
		{/if}
		{#if expandedDirs.has(entry.path) && entry.children}
			{#each entry.children as child}
				{@render treeNode(child, depth + 1)}
			{/each}
		{/if}
	{:else}
		{@const Icon = fileIcon(entry.name)}
		<button
			onclick={() => openFile(entry.path)}
			class="flex w-full items-center gap-1.5 px-2 py-1 text-xs hover:bg-muted/50 {selectedFile === entry.path ? 'bg-accent text-accent-foreground' : ''}"
			style="padding-left: {depth * 16 + 24}px"
			title={entry.path}
		>
			<Icon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<span class="truncate">{entry.name}</span>
		</button>
	{/if}
{/snippet}
