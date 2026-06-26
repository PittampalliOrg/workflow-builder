<script lang="ts">
	/**
	 * Per-branch spec diff — what NODES this fork changed vs its parent run.
	 * Fetches `…/executions/[id]/spec-diff` and shows an added/removed/changed summary
	 * plus a unified diff (RenderedPatch) per changed node. Makes a fork self-explanatory.
	 */
	import { GitFork, Plus, Minus, Pencil } from '@lucide/svelte';
	import RenderedPatch from '$lib/components/benchmarks/rendered-patch.svelte';

	interface Props {
		executionId: string;
	}
	let { executionId }: Props = $props();

	interface DiffResp {
		hasParent: boolean;
		parentId: string | null;
		fromNode: string | null;
		snapshotUnavailable?: boolean;
		added?: string[];
		removed?: string[];
		changed?: Array<{ name: string; patch: string }>;
	}

	let data = $state<DiffResp | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	$effect(() => {
		void executionId;
		loading = true;
		loadError = null;
		data = null;
		fetch(`/api/workflows/executions/${executionId}/spec-diff`)
			.then(async (r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				data = (await r.json()) as DiffResp;
			})
			.catch((e) => (loadError = e instanceof Error ? e.message : 'Failed to load diff'))
			.finally(() => (loading = false));
	});

	const nothingChanged = $derived(
		!!data &&
			data.hasParent &&
			!data.snapshotUnavailable &&
			(data.added?.length ?? 0) === 0 &&
			(data.removed?.length ?? 0) === 0 &&
			(data.changed?.length ?? 0) === 0
	);
</script>

<div class="p-3 text-xs">
	{#if loading}
		<p class="text-muted-foreground">Loading diff…</p>
	{:else if loadError}
		<p class="text-red-500">{loadError}</p>
	{:else if !data?.hasParent}
		<p class="text-muted-foreground">This run isn't a fork — nothing to compare.</p>
	{:else if data.snapshotUnavailable}
		<p class="text-muted-foreground">
			Spec snapshot unavailable for this run or its parent (it predates per-run spec capture), so a
			diff can't be computed.
		</p>
	{:else if nothingChanged}
		<p class="inline-flex items-center gap-1.5 text-muted-foreground">
			<GitFork class="size-3.5" /> No node changes vs the parent — this fork re-ran the same spec from
			{data.fromNode ? `“${data.fromNode}”` : 'the resume point'}.
		</p>
	{:else}
		<div class="mb-3 flex flex-wrap items-center gap-1.5">
			{#each data.changed ?? [] as c (c.name)}
				<span class="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300">
					<Pencil class="size-2.5" />{c.name}
				</span>
			{/each}
			{#each data.added ?? [] as n (n)}
				<span class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
					<Plus class="size-2.5" />{n}
				</span>
			{/each}
			{#each data.removed ?? [] as n (n)}
				<span class="inline-flex items-center gap-0.5 rounded-full bg-red-500/15 px-1.5 py-0.5 font-medium text-red-600 line-through dark:text-red-400">
					<Minus class="size-2.5" />{n}
				</span>
			{/each}
		</div>
		{#each data.changed ?? [] as c (c.name)}
			<div class="mb-3">
				<div class="mb-1 font-medium text-muted-foreground">{c.name}</div>
				<RenderedPatch patch={c.patch} layout="line-by-line" />
			</div>
		{/each}
	{/if}
</div>
