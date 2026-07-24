<!--
	Decoupled run-diff view for the dev checkpoints panel: a collapsible that
	lazy-fetches the execution's per-node `diff` artifacts and renders the
	aggregated unified diff with the same `RenderedPatch` primitive the run-page
	Changes tab uses, plus a cross-link into the full master-detail Changes tab.

	Code checkpoints (source bundles) are opaque tar overlays with no per-version
	patch, so the meaningful "what changed" view for a run is this cumulative
	diff. Kept standalone (wraps RenderedPatch) so it can later be unified with
	the run page's shared code-checkpoints panel.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import {
		ChevronDown,
		ChevronRight,
		ExternalLink,
		FileDiff,
		Loader2
	} from '@lucide/svelte';
	import RenderedPatch from '$lib/components/benchmarks/rendered-patch.svelte';
	import { aggregateRunDiff } from '$lib/components/workflow/execution/run-diff-export';

	let {
		executionId,
		runChangesHref
	}: {
		executionId: string;
		/** Override the run-detail deep link; defaults to the slug-scoped shim. */
		runChangesHref?: string;
	} = $props();

	type ArtifactRecord = {
		kind: string;
		nodeId: string | null;
		title: string;
		inlinePayload: unknown;
		createdAt: string;
	};

	// The executionId shim (/workflows/runs/[executionId]) redirects to the
	// canonical run-detail URL, so we don't need the workflowId here.
	const runHref = $derived(
		runChangesHref ??
			`/workspaces/${page.params.slug ?? 'default'}/workflows/runs/${executionId}`
	);

	let open = $state(false);
	let phase = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let patch = $state('');
	let omittedLargeNodes = $state(0);
	let includedNodes = $state(0);
	let errorMessage = $state<string | null>(null);
	let loaded = false;

	async function load() {
		if (loaded) return;
		phase = 'loading';
		errorMessage = null;
		try {
			const res = await fetch(`/api/workflows/executions/${executionId}/artifacts`);
			if (!res.ok) throw new Error(`Run changes request failed (${res.status})`);
			const body = (await res.json()) as { artifacts?: ArtifactRecord[] };
			const diffs = (body.artifacts ?? []).filter((a) => a.kind === 'diff');
			const aggregate = aggregateRunDiff(diffs);
			patch = aggregate.patch;
			omittedLargeNodes = aggregate.omittedLargeNodes;
			includedNodes = aggregate.includedNodes;
			phase = 'ready';
			loaded = true;
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
			phase = 'error';
		}
	}

	function toggle() {
		open = !open;
		if (open) void load();
	}
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between gap-2">
		<button
			type="button"
			class="inline-flex items-center gap-1.5 text-sm font-medium hover:text-foreground/80"
			onclick={toggle}
			aria-expanded={open}
		>
			{#if open}<ChevronDown class="size-3.5" />{:else}<ChevronRight class="size-3.5" />{/if}
			<FileDiff class="size-4 text-muted-foreground" /> Run changes
		</button>
		<a
			href={runHref}
			class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			title="Open the full master-detail Changes tab for this run"
		>
			Open full run Changes <ExternalLink class="size-3" />
		</a>
	</div>

	{#if open}
		{#if phase === 'loading'}
			<p class="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
				<Loader2 class="size-3.5 animate-spin" /> Loading run changes…
			</p>
		{:else if phase === 'error'}
			<div class="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive" role="alert">
				{errorMessage}
				<Button variant="ghost" size="sm" class="ml-2 h-6" onclick={() => { loaded = false; void load(); }}>Retry</Button>
			</div>
		{:else if phase === 'ready'}
			{#if patch}
				{#if omittedLargeNodes > 0}
					<p class="text-[11px] text-muted-foreground">
						Showing {includedNodes} step{includedNodes === 1 ? '' : 's'} · {omittedLargeNodes} large
						{omittedLargeNodes === 1 ? 'diff was' : 'diffs were'} offloaded — open the full Changes tab to view {omittedLargeNodes === 1 ? 'it' : 'them'}.
					</p>
				{/if}
				<div class="max-h-[28rem] overflow-auto rounded-md border bg-card p-2">
					<RenderedPatch {patch} layout="line-by-line" />
				</div>
			{:else}
				<p class="text-xs text-muted-foreground">No inline file changes were captured for this run.</p>
			{/if}
		{/if}
	{/if}
</div>
