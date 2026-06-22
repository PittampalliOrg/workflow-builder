<!--
  "Changes" view — a master-detail diff viewer for an agent run.

  LEFT rail: every changed file across the run, grouped by the node (agent step)
  that changed it, with a status glyph + per-file +/- stats. RIGHT pane: the
  SELECTED file's diff only — so we render ONE (small) diff at a time instead of
  every node's full patch at once. That keeps it fast even for big runs and lets
  the user jump straight to any file (click or ↑/↓).

  Each per-node `diff` artifact is an INCREMENTAL delta (the capture advances a
  per-workspace baseline after each node, so node N shows only node N's changes).
  Patches are split per-file client-side; any `git diff --stat` preamble is
  skipped. Large (gzip-offloaded) diffs with no inline patch fall back to the
  whole-node renderer (which fetches lazily).
-->
<script lang="ts">
	import { FileDiff, FilePlus, FileMinus, FilePen, ChevronRight } from "@lucide/svelte";
	import RenderedPatch from "$lib/components/benchmarks/rendered-patch.svelte";
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

	type Status = "added" | "deleted" | "modified" | "renamed";
	type FileEntry = {
		key: string;
		nodeId: string;
		nodeIndex: number;
		path: string;
		additions: number;
		deletions: number;
		status: Status;
		patch?: string;
		whole?: { artifactId: string; inlinePayload: unknown; fileId: string | null };
	};
	type NodeGroup = { id: string; nodeId: string; index: number; stats: Stats; files: FileEntry[] };

	function statsOf(a: Artifact): Stats {
		const p = (a.inlinePayload ?? {}) as { stats?: Stats };
		return p.stats ?? { files: 0, additions: 0, deletions: 0 };
	}
	function inlinePatch(a: Artifact): string {
		const p = (a.inlinePayload ?? {}) as { patch?: string };
		return typeof p.patch === "string" ? p.patch : "";
	}

	/** Split a unified diff into one mini-patch per file (skipping any --stat preamble). */
	function splitFiles(patch: string): Omit<FileEntry, "key" | "nodeId" | "nodeIndex">[] {
		if (!patch.trim()) return [];
		const out: Omit<FileEntry, "key" | "nodeId" | "nodeIndex">[] = [];
		for (const part of patch.split(/(?=^diff --git )/m)) {
			if (!part.startsWith("diff --git")) continue;
			const m = part.match(/^diff --git a\/.+? b\/(\S+)/m);
			const path = m ? m[1] : "(file)";
			let additions = 0;
			let deletions = 0;
			for (const line of part.split("\n")) {
				if (line[0] === "+" && !line.startsWith("+++")) additions++;
				else if (line[0] === "-" && !line.startsWith("---")) deletions++;
			}
			const status: Status = /\nnew file mode/.test(part)
				? "added"
				: /\ndeleted file mode/.test(part)
					? "deleted"
					: /\nrename from /.test(part)
						? "renamed"
						: "modified";
			out.push({ path, additions, deletions, status, patch: part });
		}
		return out;
	}

	// Order by completion = node execution order (the baseline advances per node).
	const ordered = $derived(
		[...artifacts].sort(
			(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		),
	);

	const groups = $derived.by<NodeGroup[]>(() =>
		ordered.map((a, i) => {
			const stats = statsOf(a);
			const patch = inlinePatch(a);
			const nodeId = a.nodeId ?? "step";
			let files: FileEntry[];
			if (patch) {
				files = splitFiles(patch).map((f, fi) => ({
					...f,
					key: `${a.id}::${fi}`,
					nodeId,
					nodeIndex: i,
				}));
			} else {
				// gzip-offloaded large diff — render the whole node lazily (fetches).
				files = [
					{
						key: `${a.id}::whole`,
						nodeId,
						nodeIndex: i,
						path: `${stats.files} file${stats.files === 1 ? "" : "s"} (large diff)`,
						additions: stats.additions,
						deletions: stats.deletions,
						status: "modified",
						whole: { artifactId: a.id, inlinePayload: a.inlinePayload, fileId: a.fileId },
					},
				];
			}
			return { id: a.id, nodeId, index: i, stats, files };
		}),
	);

	const flat = $derived(groups.flatMap((g) => g.files));
	const totals = $derived.by(() => {
		let files = 0;
		let additions = 0;
		let deletions = 0;
		for (const g of groups) {
			files += g.stats.files;
			additions += g.stats.additions;
			deletions += g.stats.deletions;
		}
		return { files, additions, deletions, nodes: groups.length };
	});

	let selectedKey = $state<string | null>(null);
	$effect(() => {
		if ((selectedKey === null || !flat.some((f) => f.key === selectedKey)) && flat.length) {
			selectedKey = flat[0].key;
		}
	});
	const selected = $derived(flat.find((f) => f.key === selectedKey) ?? null);

	function move(delta: number) {
		if (!flat.length) return;
		const idx = flat.findIndex((f) => f.key === selectedKey);
		const next = Math.min(flat.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + delta));
		selectedKey = flat[next].key;
	}
	function onRailKey(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			move(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			move(-1);
		}
	}
</script>

{#if groups.length === 0}
	<div class="text-sm text-muted-foreground italic">No file changes captured for this run.</div>
{:else}
	<div class="flex h-[calc(100vh-15rem)] min-h-[24rem] gap-3">
		<!-- File rail -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<aside
			class="flex w-72 shrink-0 flex-col overflow-y-auto rounded-lg border bg-card outline-none"
			tabindex="0"
			role="listbox"
			aria-label="Changed files"
			onkeydown={onRailKey}
		>
			<div class="sticky top-0 z-10 border-b bg-card px-3 py-2">
				<div class="flex items-center gap-1.5 text-sm font-semibold">
					<FileDiff class="h-4 w-4 text-muted-foreground" />
					Run impact
				</div>
				<div class="mt-0.5 text-xs tabular-nums text-muted-foreground">
					{totals.files} file{totals.files === 1 ? "" : "s"} · {totals.nodes} step{totals.nodes === 1
						? ""
						: "s"} ·
					<span class="text-emerald-600 dark:text-emerald-400">+{totals.additions}</span>
					<span class="text-red-600 dark:text-red-400">-{totals.deletions}</span>
				</div>
			</div>
			{#each groups as g (g.id)}
				<div
					class="flex items-center gap-1 px-3 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
				>
					<span class="rounded bg-muted px-1 tabular-nums">{g.index + 1}</span>
					<span class="truncate">{g.nodeId}</span>
				</div>
				{#each g.files as f (f.key)}
					<button
						type="button"
						onclick={() => (selectedKey = f.key)}
						class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/60 {selectedKey ===
						f.key
							? 'bg-muted font-medium'
							: ''}"
					>
						{#if f.status === "added"}
							<FilePlus class="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
						{:else if f.status === "deleted"}
							<FileMinus class="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
						{:else}
							<FilePen class="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
						{/if}
						<span class="min-w-0 flex-1 truncate font-mono" title={f.path}>{f.path}</span>
						{#if f.additions}<span
								class="shrink-0 tabular-nums text-emerald-600 dark:text-emerald-400">+{f.additions}</span
							>{/if}
						{#if f.deletions}<span class="shrink-0 tabular-nums text-red-600 dark:text-red-400"
								>-{f.deletions}</span
							>{/if}
					</button>
				{/each}
			{/each}
		</aside>

		<!-- Selected-file detail -->
		<main class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-card">
			{#if selected}
				<div class="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-3 py-2">
					<span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
						>{selected.nodeId}</span
					>
					<ChevronRight class="h-3 w-3 shrink-0 text-muted-foreground" />
					<span class="min-w-0 flex-1 truncate font-mono text-sm" title={selected.path}
						>{selected.path}</span
					>
					<span class="shrink-0 text-xs tabular-nums text-emerald-600 dark:text-emerald-400"
						>+{selected.additions}</span
					>
					<span class="shrink-0 text-xs tabular-nums text-red-600 dark:text-red-400"
						>-{selected.deletions}</span
					>
				</div>
				<div class="min-h-0 flex-1 overflow-auto p-2">
					{#key selected.key}
						{#if selected.whole}
							<DiffArtifact
								{executionId}
								artifactId={selected.whole.artifactId}
								inlinePayload={selected.whole.inlinePayload}
								fileId={selected.whole.fileId}
							/>
						{:else}
							<RenderedPatch patch={selected.patch ?? ""} layout="line-by-line" />
						{/if}
					{/key}
				</div>
			{/if}
		</main>
	</div>
{/if}
