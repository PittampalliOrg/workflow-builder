<!--
  Renderer for a `diff` workflow artifact (durable per-run workspace changes).

  The patch is inline for small diffs (`inlinePayload.patch`); for large diffs it
  is gzip-offloaded to a file and resolved lazily via the diff read endpoint.
  Shows a +/-/files stat header, then the unified diff via the shared diff2html
  renderer (rendered-patch.svelte).
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { Loader2, FileDiff } from "@lucide/svelte";
	import RenderedPatch from "$lib/components/benchmarks/rendered-patch.svelte";

	interface Props {
		executionId?: string | null;
		artifactId?: string | null;
		inlinePayload?: unknown;
		fileId?: string | null;
	}
	let { executionId = null, artifactId = null, inlinePayload, fileId = null }: Props = $props();

	type Stats = { files: number; additions: number; deletions: number };

	const payload = $derived(
		inlinePayload && typeof inlinePayload === "object"
			? (inlinePayload as Record<string, unknown>)
			: {},
	);
	const inlinePatch = $derived(typeof payload.patch === "string" ? (payload.patch as string) : "");
	const stats = $derived(
		(payload.stats as Stats | undefined) ?? { files: 0, additions: 0, deletions: 0 },
	);
	const truncated = $derived(!!payload.truncated);
	const baseRef = $derived(typeof payload.baseRef === "string" ? (payload.baseRef as string) : null);
	const headRef = $derived(typeof payload.headRef === "string" ? (payload.headRef as string) : null);

	let fetchedPatch = $state<string>("");
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);

	const patch = $derived(inlinePatch || fetchedPatch);

	// Lazily resolve gzip-offloaded patches (no inline patch but a fileId).
	onMount(async () => {
		if (inlinePatch || !fileId || !executionId || !artifactId) return;
		loading = true;
		try {
			const res = await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/artifacts/${encodeURIComponent(artifactId)}/diff`,
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { patch?: string };
			fetchedPatch = typeof body.patch === "string" ? body.patch : "";
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	});
</script>

<div class="space-y-2">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
		<span class="inline-flex items-center gap-1 font-medium text-foreground">
			<FileDiff class="h-3.5 w-3.5" />
			{stats.files} file{stats.files === 1 ? "" : "s"}
		</span>
		<span class="text-emerald-600 dark:text-emerald-400">+{stats.additions}</span>
		<span class="text-red-600 dark:text-red-400">-{stats.deletions}</span>
		{#if baseRef || headRef}
			<span class="font-mono text-[10px]">{baseRef ?? "?"} → {headRef ?? "working"}</span>
		{/if}
		{#if truncated}
			<span class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">truncated</span>
		{/if}
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-6">
			<Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
		</div>
	{:else if errorMessage}
		<div class="px-3 py-4 text-xs text-destructive">Failed to load diff: {errorMessage}</div>
	{:else if patch.trim()}
		<RenderedPatch {patch} layout="line-by-line" />
	{:else}
		<div class="px-3 py-6 text-center text-xs text-muted-foreground">No file changes recorded for this run.</div>
	{/if}
</div>
