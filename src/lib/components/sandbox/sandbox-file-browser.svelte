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
		ArrowLeft
	} from 'lucide-svelte';
	import SandboxCodeViewer from './sandbox-code-viewer.svelte';

	interface Props {
		sandboxName: string;
	}

	let { sandboxName }: Props = $props();

	interface FileEntry {
		path: string;
		name: string;
		isDirectory: boolean;
		children?: FileEntry[];
	}

	let tree = $state.raw<FileEntry[]>([]);
	let loading = $state(true);
	let expandedDirs = $state<Set<string>>(new Set());
	let selectedFile = $state<string | null>(null);
	let fileContent = $state<string | null>(null);
	let fileLoading = $state(false);

	async function loadTree(path: string = '/sandbox') {
		loading = true;
		try {
			const res = await fetch(`/api/sandboxes/${encodeURIComponent(sandboxName)}/files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'list', path, maxDepth: 3 })
			});
			if (res.ok) {
				const data = await res.json();
				tree = buildTree(data.entries ?? [], path);
			}
		} catch {
			// silent
		} finally {
			loading = false;
		}
	}

	function buildTree(entries: { path: string; name: string }[], root: string): FileEntry[] {
		const map = new Map<string, FileEntry>();
		const rootEntries: FileEntry[] = [];

		// Sort entries so directories come first
		const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

		for (const entry of sorted) {
			if (entry.path === root) continue;
			const parts = entry.path.replace(root + '/', '').split('/');
			const isDir = sorted.some(
				(other) => other.path !== entry.path && other.path.startsWith(entry.path + '/')
			);

			const node: FileEntry = {
				path: entry.path,
				name: parts[parts.length - 1],
				isDirectory: isDir,
				children: isDir ? [] : undefined
			};
			map.set(entry.path, node);

			if (parts.length === 1) {
				rootEntries.push(node);
			} else {
				const parentPath = root + '/' + parts.slice(0, -1).join('/');
				const parent = map.get(parentPath);
				if (parent?.children) {
					parent.children.push(node);
				}
			}
		}

		// Sort: dirs first, then files, alpha within each
		const sortNodes = (nodes: FileEntry[]) => {
			nodes.sort((a, b) => {
				if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
			for (const n of nodes) {
				if (n.children) sortNodes(n.children);
			}
		};
		sortNodes(rootEntries);
		return rootEntries;
	}

	function toggleDir(path: string) {
		const next = new Set(expandedDirs);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		expandedDirs = next;
	}

	async function openFile(path: string) {
		selectedFile = path;
		fileContent = null;
		fileLoading = true;
		try {
			const res = await fetch(`/api/sandboxes/${encodeURIComponent(sandboxName)}/files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'read', path })
			});
			if (res.ok) {
				const data = await res.json();
				fileContent = data.content ?? '';
			}
		} catch {
			fileContent = '(failed to read file)';
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

	$effect(() => {
		loadTree();
	});
</script>

<div class="flex h-full gap-0 overflow-hidden">
	<!-- File tree panel -->
	<div class="w-64 shrink-0 overflow-auto border-r border-border">
		<div class="flex items-center justify-between border-b border-border px-3 py-2">
			<span class="text-xs font-medium text-muted-foreground">Files</span>
			<Button variant="ghost" size="icon" class="h-6 w-6" onclick={() => loadTree()}>
				<RefreshCw class="h-3 w-3" />
			</Button>
		</div>

		{#if loading}
			<div class="flex items-center justify-center py-8">
				<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
			</div>
		{:else}
			<div class="py-1">
				{#each tree as entry}
					{@render treeNode(entry, 0)}
				{/each}
			</div>
		{/if}
	</div>

	<!-- File viewer panel -->
	<div class="flex-1 overflow-auto">
		{#if selectedFile}
			<div class="flex items-center gap-2 border-b border-border px-4 py-2">
				<button onclick={() => (selectedFile = null)} class="text-muted-foreground hover:text-foreground">
					<ArrowLeft class="h-3.5 w-3.5" />
				</button>
				<span class="truncate font-mono text-xs text-muted-foreground">{selectedFile}</span>
			</div>
			{#if fileLoading}
				<div class="flex items-center justify-center py-12">
					<Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
				</div>
			{:else if fileContent !== null}
				<SandboxCodeViewer code={fileContent} filename={selectedFile ?? undefined} />
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
			onclick={() => toggleDir(entry.path)}
			class="flex w-full items-center gap-1.5 px-2 py-1 text-xs hover:bg-muted/50"
			style="padding-left: {depth * 16 + 8}px"
		>
			{#if expandedDirs.has(entry.path)}
				<ChevronDown class="h-3 w-3 shrink-0 text-muted-foreground" />
			{:else}
				<ChevronRight class="h-3 w-3 shrink-0 text-muted-foreground" />
			{/if}
			<Folder class="h-3.5 w-3.5 shrink-0 text-blue-400" />
			<span class="truncate">{entry.name}</span>
		</button>
		{#if expandedDirs.has(entry.path) && entry.children}
			{#each entry.children as child}
				{@render treeNode(child, depth + 1)}
			{/each}
		{/if}
	{:else}
		<button
			onclick={() => openFile(entry.path)}
			class="flex w-full items-center gap-1.5 px-2 py-1 text-xs hover:bg-muted/50 {selectedFile === entry.path ? 'bg-accent text-accent-foreground' : ''}"
			style="padding-left: {depth * 16 + 24}px"
		>
			<svelte:component this={fileIcon(entry.name)} class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<span class="truncate">{entry.name}</span>
		</button>
	{/if}
{/snippet}
