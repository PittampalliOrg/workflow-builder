<script lang="ts">
	/**
	 * Shared provenance chip set for a run — `fork @<step>` / `snapshot-seeded`
	 * (Camera) / `reproduce`. One derivation, one visual language, used by the run
	 * header, the fork-lineage tree, and the runs-list rows so provenance reads the
	 * same everywhere.
	 */
	import { GitFork, Camera, RefreshCw } from '@lucide/svelte';
	import { deriveRunProvenance, type RunProvenanceInput } from '$lib/utils/run-provenance';

	interface Props extends RunProvenanceInput {
		/** Chip scale — `xs` for dense list rows, `sm` for headers. */
		size?: 'xs' | 'sm';
		class?: string;
	}

	let {
		rerunOfExecutionId = null,
		resumeFromNode = null,
		seedWorkspaceFrom = null,
		triggerSource = null,
		size = 'sm',
		class: className = ''
	}: Props = $props();

	const p = $derived(
		deriveRunProvenance({ rerunOfExecutionId, resumeFromNode, seedWorkspaceFrom, triggerSource })
	);

	const pad = $derived(size === 'xs' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]');
	const iconSize = $derived(size === 'xs' ? 'size-2.5' : 'size-3');
</script>

{#if p.isFork || p.seededFromSnapshot || p.isReproduce}
	<span class="inline-flex flex-wrap items-center gap-1 {className}">
		{#if p.isFork}
			<span
				class="inline-flex items-center gap-1 rounded-full bg-primary/10 font-medium text-primary {pad}"
				title="Forked from an earlier run{p.forkFromNode ? ` at ${p.forkFromNode}` : ''}"
			>
				<GitFork class={iconSize} />
				fork{#if p.forkFromNode}&nbsp;@{p.forkFromNode}{/if}
			</span>
		{/if}
		{#if p.seededFromSnapshot}
			<span
				class="inline-flex items-center gap-1 rounded-full bg-violet-500/12 font-medium text-violet-600 dark:text-violet-300 {pad}"
				title={p.snapshotPath ? `Seeded from node snapshot ${p.snapshotPath}` : 'Seeded from a node-boundary snapshot'}
			>
				<Camera class={iconSize} />
				snapshot-seeded{#if p.snapshotNode}&nbsp;@{p.snapshotNode}{/if}
			</span>
		{/if}
		{#if p.isReproduce}
			<span
				class="inline-flex items-center gap-1 rounded-full bg-sky-500/12 font-medium text-sky-600 dark:text-sky-300 {pad}"
				title="Deterministic replay of a prior run"
			>
				<RefreshCw class={iconSize} />
				reproduce
			</span>
		{/if}
	</span>
{/if}
