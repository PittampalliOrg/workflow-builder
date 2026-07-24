<script lang="ts">
	/**
	 * Fork lineage tree — runs are branches; this shows the whole family.
	 *
	 * Fetches `…/executions/[id]/lineage` (the rerun ancestors + all descendants),
	 * builds a tree rooted at the lineage ROOT, and renders it git-log style: each
	 * row is a run with its status + the node it forked FROM (`@<node>`) + relative
	 * time, with "(current)" on the run being viewed. Clicking a row navigates to
	 * that run (default) or calls `onSelect` (canvas run-picker). A trailing
	 * "Fork from a step" action calls `onFork` to open the shared fork dialog.
	 */
	import { GitFork, ChevronRight, ChevronDown, GitBranch, Camera } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';

	interface LineageNode {
		id: string;
		status: string | null;
		fromNodeId: string | null;
		parentId: string | null;
		startedAt: string | null;
		completedAt: string | null;
		durationMs: number | null;
		isCurrent: boolean;
		/** Seeded from a node-boundary snapshot (durability phase 3) — badged. */
		seededFromSnapshot?: boolean;
		/** The `.snapshots/<key>/<node>` path, shown as the badge tooltip. */
		snapshotPath?: string | null;
	}
	interface TreeNode extends LineageNode {
		children: TreeNode[];
	}

	interface Props {
		executionId: string;
		slug: string;
		workflowId: string;
		/** Canvas run-picker: select (overlay) instead of navigating. */
		onSelect?: (id: string) => void;
		/** Open the shared fork dialog (the "Fork from a step" action). */
		onFork?: () => void;
		/** The run currently overlaid/selected (canvas) — highlighted distinctly. */
		selectedId?: string | null;
	}

	let { executionId, slug, workflowId, onSelect, onFork, selectedId = null }: Props = $props();

	let nodes = $state<LineageNode[]>([]);
	let rootId = $state<string | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let collapsed = new SvelteSet<string>();

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/lineage`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { rootId: string; nodes: LineageNode[] };
			nodes = data.nodes ?? [];
			rootId = data.rootId ?? null;
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Failed to load lineage';
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		void executionId;
		void load();
	});

	const tree = $derived.by<TreeNode | null>(() => {
		if (!rootId) return null;
		const byId = new Map<string, TreeNode>();
		for (const n of nodes) byId.set(n.id, { ...n, children: [] });
		for (const n of byId.values()) {
			if (n.parentId && byId.has(n.parentId) && n.parentId !== n.id) {
				byId.get(n.parentId)!.children.push(n);
			}
		}
		for (const n of byId.values()) {
			n.children.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
		}
		return byId.get(rootId) ?? null;
	});
	const forkCount = $derived(Math.max(0, nodes.length - 1));

	function statusDot(status: string | null): { cls: string; sym: string; label: string } {
		switch (status) {
			case 'running':
			case 'pending':
				return { cls: 'text-teal-500', sym: '▶', label: status };
			case 'success':
				return { cls: 'text-emerald-500', sym: '✓', label: 'success' };
			case 'error':
				return { cls: 'text-red-500', sym: '✕', label: 'error' };
			case 'cancelled':
				return { cls: 'text-amber-500', sym: '◼', label: 'cancelled' };
			default:
				return { cls: 'text-muted-foreground', sym: '○', label: status ?? 'pending' };
		}
	}
	function relTime(s: string | null): string {
		if (!s) return '';
		const ms = Date.now() - new Date(s).getTime();
		if (!Number.isFinite(ms)) return '';
		const sec = Math.floor(ms / 1000);
		if (sec < 60) return `${sec}s ago`;
		const m = Math.floor(sec / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}
	function rowClick(n: TreeNode) {
		if (onSelect) onSelect(n.id);
		else
			window.location.href = `/workspaces/${slug}/workflows/${workflowId}/runs/${n.id}`;
	}
</script>

<div class="flex min-h-0 flex-col">
	<div class="flex items-center justify-between gap-2 border-b px-3 py-1.5">
		<span class="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
			<GitBranch class="size-3.5" />
			{#if forkCount > 0}{forkCount + 1} runs · {forkCount} fork{forkCount === 1 ? '' : 's'}{:else}No forks yet{/if}
		</span>
		{#if onFork}
			<button
				class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10"
				onclick={onFork}
				title="Fork this run from a step"
			>
				<GitFork class="size-3" /> Fork from a step
			</button>
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto p-1.5">
		{#if loading}
			<p class="px-2 py-3 text-xs text-muted-foreground">Loading lineage…</p>
		{:else if loadError}
			<p class="px-2 py-3 text-xs text-red-500">{loadError}</p>
		{:else if tree}
			{@render row(tree, 0)}
		{:else}
			<p class="px-2 py-3 text-xs text-muted-foreground">No lineage.</p>
		{/if}
	</div>
</div>

{#snippet row(n: TreeNode, depth: number)}
	{@const dot = statusDot(n.status)}
	{@const hasKids = n.children.length > 0}
	{@const isOpen = !collapsed.has(n.id)}
	{@const active = n.isCurrent || n.id === selectedId}
	<div class="flex items-center gap-1" style:padding-left="{depth * 14}px">
		{#if hasKids}
			<button
				class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"
				onclick={() => (collapsed.has(n.id) ? collapsed.delete(n.id) : collapsed.add(n.id))}
				title={isOpen ? 'Collapse' : 'Expand'}
			>
				{#if isOpen}<ChevronDown class="size-3" />{:else}<ChevronRight class="size-3" />{/if}
			</button>
		{:else}
			<span class="inline-block w-4 shrink-0"></span>
		{/if}
		<button
			class="my-0.5 flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors {active
				? 'bg-primary/10 ring-1 ring-primary/40'
				: 'hover:bg-muted/60'}"
			onclick={() => rowClick(n)}
		>
			<span class="{dot.cls} shrink-0" title={dot.label}>{dot.sym}</span>
			{#if n.fromNodeId}
				<span class="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
					<GitFork class="size-2.5" />@{n.fromNodeId}
				</span>
			{:else}
				<span class="shrink-0 text-[10px] font-medium text-muted-foreground/80">root</span>
			{/if}
			{#if n.seededFromSnapshot}
				<span
					class="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-violet-500/12 px-1.5 py-0.5 text-[9px] font-medium text-violet-600 dark:text-violet-300"
					title={n.snapshotPath
						? `Seeded from node snapshot ${n.snapshotPath}`
						: 'Seeded from a node-boundary snapshot'}
				>
					<Camera class="size-2.5" />snapshot
				</span>
			{/if}
			<span class="truncate font-mono text-[11px]">{n.id.slice(0, 10)}</span>
			{#if active}
				<span class="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-medium text-primary">
					{n.isCurrent ? 'current' : 'viewing'}
				</span>
			{/if}
			<span class="ml-auto shrink-0 text-[10px] text-muted-foreground/70">{relTime(n.startedAt)}</span>
		</button>
	</div>
	{#if hasKids && isOpen}
		{#each n.children as child (child.id)}
			{@render row(child, depth + 1)}
		{/each}
	{/if}
{/snippet}
