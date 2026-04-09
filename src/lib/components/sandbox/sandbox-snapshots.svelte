<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Camera, Trash2, GitCompare } from 'lucide-svelte';

	interface Props {
		sandboxName: string;
		currentFiles: string[];
	}

	let { sandboxName, currentFiles }: Props = $props();

	interface Snapshot {
		id: string;
		timestamp: string;
		files: string[];
	}

	let snapshots = $state<Snapshot[]>([]);
	let compareMode = $state(false);
	let compareSnapshot = $state<Snapshot | null>(null);

	const STORAGE_KEY = $derived(`sandbox-snapshots-${sandboxName}`);
	const MAX_SNAPSHOTS = 5;

	$effect(() => {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) snapshots = JSON.parse(stored);
		} catch {
			snapshots = [];
		}
	});

	function saveSnapshots() {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots));
	}

	function takeSnapshot() {
		const snapshot: Snapshot = {
			id: String(Date.now()),
			timestamp: new Date().toISOString(),
			files: [...currentFiles]
		};
		snapshots = [snapshot, ...snapshots].slice(0, MAX_SNAPSHOTS);
		saveSnapshots();
	}

	function deleteSnapshot(id: string) {
		snapshots = snapshots.filter((s) => s.id !== id);
		saveSnapshots();
		if (compareSnapshot?.id === id) {
			compareSnapshot = null;
			compareMode = false;
		}
	}

	function startCompare(snapshot: Snapshot) {
		compareSnapshot = snapshot;
		compareMode = true;
	}

	const diff = $derived.by(() => {
		if (!compareSnapshot) return { added: [], removed: [], unchanged: 0 };
		const oldSet = new Set(compareSnapshot.files);
		const newSet = new Set(currentFiles);
		const added = currentFiles.filter((f) => !oldSet.has(f));
		const removed = compareSnapshot.files.filter((f) => !newSet.has(f));
		const unchanged = currentFiles.filter((f) => oldSet.has(f)).length;
		return { added, removed, unchanged };
	});

	function formatTime(ts: string): string {
		return new Date(ts).toLocaleString('en-US', {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
		});
	}
</script>

<div class="rounded-lg border border-border p-4">
	<div class="flex items-center justify-between mb-3">
		<h3 class="text-sm font-semibold">Snapshots</h3>
		<Button variant="outline" size="sm" class="h-7 text-xs" onclick={takeSnapshot}>
			<Camera class="mr-1 h-3 w-3" />
			Take Snapshot
		</Button>
	</div>

	{#if compareMode && compareSnapshot}
		<div class="space-y-2 mb-3">
			<div class="text-xs text-muted-foreground">
				Comparing with snapshot from {formatTime(compareSnapshot.timestamp)}
			</div>
			<div class="flex gap-4 text-xs">
				<span class="text-green-500">+{diff.added.length} added</span>
				<span class="text-red-500">-{diff.removed.length} removed</span>
				<span class="text-muted-foreground">{diff.unchanged} unchanged</span>
			</div>
			{#if diff.added.length > 0}
				<div class="rounded bg-green-500/10 p-2">
					{#each diff.added as file}
						<div class="font-mono text-[10px] text-green-400">+ {file}</div>
					{/each}
				</div>
			{/if}
			{#if diff.removed.length > 0}
				<div class="rounded bg-red-500/10 p-2">
					{#each diff.removed as file}
						<div class="font-mono text-[10px] text-red-400">- {file}</div>
					{/each}
				</div>
			{/if}
			<Button variant="ghost" size="sm" class="h-6 text-xs" onclick={() => (compareMode = false)}>
				Close comparison
			</Button>
		</div>
	{/if}

	{#if snapshots.length === 0}
		<p class="text-xs text-muted-foreground">No snapshots yet. Take a snapshot to bookmark the current file tree state.</p>
	{:else}
		<div class="space-y-1">
			{#each snapshots as snapshot}
				<div class="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-muted/30">
					<span class="text-muted-foreground">{formatTime(snapshot.timestamp)} ({snapshot.files.length} files)</span>
					<div class="flex items-center gap-1">
						<button onclick={() => startCompare(snapshot)} class="text-muted-foreground hover:text-foreground" title="Compare">
							<GitCompare class="h-3 w-3" />
						</button>
						<button onclick={() => deleteSnapshot(snapshot.id)} class="text-muted-foreground hover:text-destructive" title="Delete">
							<Trash2 class="h-3 w-3" />
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
