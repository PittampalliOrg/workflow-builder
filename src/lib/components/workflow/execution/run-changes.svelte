<!--
  "Changes" view — the per-node impact of an agent run.

  Each `diff` artifact is one agent node's INCREMENTAL delta (the capture advances
  a per-workspace baseline after every node, so node N shows only what node N
  changed — not a cumulative diff). This view orders them by completion, shows a
  run-level impact summary, and a collapsible card per node so the user can see
  at a glance "which agent changed what."
-->
<script lang="ts">
	import { ChevronDown, ChevronRight, FileDiff } from "@lucide/svelte";
	import DiffArtifact from "./diff-artifact.svelte";

	type Stats = { files: number; additions: number; deletions: number };
	type Artifact = {
		id: string;
		nodeId: string | null;
		title: string;
		inlinePayload: unknown;
		fileId: string | null;
		createdAt: string | Date;
	};

	let { artifacts, executionId }: { artifacts: Artifact[]; executionId: string } = $props();

	function statsOf(a: Artifact): Stats {
		const p = (a.inlinePayload ?? {}) as { stats?: Stats };
		return p.stats ?? { files: 0, additions: 0, deletions: 0 };
	}

	// Order by completion time = node execution order (the baseline advances per node).
	const ordered = $derived(
		[...artifacts].sort(
			(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		),
	);

	const totals = $derived.by(() => {
		let files = 0,
			additions = 0,
			deletions = 0;
		for (const a of ordered) {
			const s = statsOf(a);
			files += s.files;
			additions += s.additions;
			deletions += s.deletions;
		}
		return { files, additions, deletions, nodes: ordered.length };
	});

	// Expand ALL node cards by default so every node's changes are visible without
	// hunting (the run-impact summary still leads). Seed once so the user can still
	// collapse cards without them snapping back open.
	let openIds = $state<Set<string>>(new Set());
	let seeded = $state(false);
	$effect(() => {
		if (!seeded && ordered.length) {
			openIds = new Set(ordered.map((a) => a.id));
			seeded = true;
		}
	});
	function toggle(id: string) {
		const next = new Set(openIds);
		next.has(id) ? next.delete(id) : next.add(id);
		openIds = next;
	}
</script>

{#if ordered.length === 0}
	<div class="text-sm text-muted-foreground italic">No file changes captured for this run.</div>
{:else}
	<!-- Run-impact summary -->
	<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-card px-4 py-3">
		<span class="inline-flex items-center gap-1.5 text-sm font-semibold">
			<FileDiff class="h-4 w-4 text-muted-foreground" />
			Run impact
		</span>
		<span class="text-sm tabular-nums">
			{totals.files} file{totals.files === 1 ? "" : "s"} across {totals.nodes} agent
			{totals.nodes === 1 ? "step" : "steps"}
		</span>
		<span class="text-sm tabular-nums text-emerald-600 dark:text-emerald-400">+{totals.additions}</span>
		<span class="text-sm tabular-nums text-red-600 dark:text-red-400">-{totals.deletions}</span>
	</div>

	<!-- Per-node delta cards -->
	<div class="grid gap-2">
		{#each ordered as a, i (a.id)}
			{@const s = statsOf(a)}
			{@const isOpen = openIds.has(a.id)}
			<section class="rounded-lg border bg-card">
				<button
					type="button"
					onclick={() => toggle(a.id)}
					class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50"
				>
					<div class="flex min-w-0 items-center gap-2">
						{#if isOpen}<ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />{:else}<ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground" />{/if}
						<span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{i + 1}</span>
						<span class="truncate text-sm font-medium">{a.nodeId ?? "step"}</span>
					</div>
					<div class="flex shrink-0 items-center gap-2.5 text-xs tabular-nums">
						<span class="text-muted-foreground">{s.files} file{s.files === 1 ? "" : "s"}</span>
						<span class="text-emerald-600 dark:text-emerald-400">+{s.additions}</span>
						<span class="text-red-600 dark:text-red-400">-{s.deletions}</span>
					</div>
				</button>
				{#if isOpen}
					<div class="border-t px-3 py-2">
						<DiffArtifact {executionId} artifactId={a.id} inlinePayload={a.inlinePayload} fileId={a.fileId} />
					</div>
				{/if}
			</section>
		{/each}
	</div>
{/if}
