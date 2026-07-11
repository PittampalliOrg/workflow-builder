<!--
  Team Knowledge Drawer — the right-hand counterpart of the run console's
  collapsible session rail: lets you keep the team's knowledge bundle in view
  WHILE watching live activity, without ceding the main pane.

  Collapsed (default): a slim vertical strip with a BookOpen glyph and a live
  concept count that pulses when a teammate publishes something new — a
  glanceable "the bundle grew" signal that costs ~2.5rem of width.
  Open: a compact index (grouped by directory, type badges, freshness dots)
  with an inline OKF document view (back button). One bundle fetch per poll —
  content ships inline, so previews are instant and nothing touches sandboxes.
-->
<script lang="ts">
	import { ArrowLeft, BookOpen, ChevronsRight, FileText } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { Badge } from '$lib/components/ui/badge';

	type BundleFile = { path: string; content: string };

	interface Props {
		teamId: string;
		isRunning?: boolean;
		open?: boolean;
		onToggle?: (open: boolean) => void;
		/** Click-through from the live board: focus a concept. nonce retriggers
		 * on every click; path null = "whatever was just published" (latest). */
		focus?: { path: string | null; nonce: number } | null;
	}
	let { teamId, isRunning = false, open = false, onToggle, focus = null }: Props = $props();

	let files = $state<BundleFile[]>([]);
	let selectedPath = $state<string | null>(null);
	// Paths that changed in the most recent poll — drive the freshness dots +
	// the collapsed-strip pulse. Content-keyed, so revisions count as changes.
	let freshPaths = $state<Set<string>>(new Set());
	let pulse = $state(false);
	let lastContents = new Map<string, string>();

	const RESERVED = new Set(['index.md', 'log.md']);
	const concepts = $derived(
		files.filter((f) => !RESERVED.has(f.path.split('/').pop() ?? f.path))
	);
	const selected = $derived(files.find((f) => f.path === selectedPath) ?? null);

	// Group concepts by top-level directory for the index view.
	const groups = $derived.by(() => {
		const byDir = new Map<string, BundleFile[]>();
		for (const f of concepts) {
			const slash = f.path.indexOf('/');
			const dir = slash > 0 ? f.path.slice(0, slash) : '(root)';
			byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
		}
		return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
	});

	/** Cheap frontmatter peek for row labels (title/type) without a parser. */
	function fm(content: string, key: string): string | null {
		const m = content.match(new RegExp(`^${key}: "((?:[^"\\\\]|\\\\.)*)"`, 'm'));
		return m ? m[1].replace(/\\"/g, '"') : null;
	}

	async function load() {
		try {
			const r = await fetch(`/api/v1/teams/${encodeURIComponent(teamId)}/knowledge/bundle`);
			if (!r.ok) return;
			const d = (await r.json()) as { files?: BundleFile[] };
			const next = d.files ?? [];
			const changed = new Set<string>();
			for (const f of next) {
				const prev = lastContents.get(f.path);
				if (prev !== undefined && prev !== f.content) changed.add(f.path);
				if (prev === undefined && lastContents.size > 0) changed.add(f.path);
			}
			lastContents = new Map(next.map((f) => [f.path, f.content]));
			files = next;
			if (changed.size > 0) {
				freshPaths = changed;
				pulse = true;
				setTimeout(() => (pulse = false), 2500);
			}
		} catch {
			/* transient */
		}
	}
	$effect(() => {
		void teamId;
		load();
		if (!isRunning) return;
		const t = setInterval(load, 6000);
		return () => clearInterval(t);
	});

	/** Resolve a focus path against the bundle: exact → '.md' appended →
	 * suffix match → the most recently updated concept (frontmatter timestamp). */
	function resolveFocus(path: string | null): string | null {
		const paths = concepts.map((f) => f.path);
		if (path) {
			const clean = path.replace(/^\/+/, '');
			const withMd = clean.endsWith('.md') ? clean : `${clean}.md`;
			if (paths.includes(clean)) return clean;
			if (paths.includes(withMd)) return withMd;
			const suffix = paths.find((p) => p.endsWith(withMd));
			if (suffix) return suffix;
		}
		let best: string | null = null;
		let bestTs = '';
		for (const f of concepts) {
			const ts = fm(f.content, 'timestamp') ?? '';
			if (ts >= bestTs) {
				bestTs = ts;
				best = f.path;
			}
		}
		return best;
	}
	let lastFocusNonce = -1;
	$effect(() => {
		if (!focus || focus.nonce === lastFocusNonce) return;
		lastFocusNonce = focus.nonce;
		// The publish may be seconds ahead of our last poll — refresh, then focus.
		load().then(() => {
			selectedPath = resolveFocus(focus.path);
		});
	});
</script>

{#if !open}
	<!-- Collapsed strip — mirrors the left rail's collapsed affordance. -->
	<button
		type="button"
		class="flex min-h-0 flex-col items-center gap-2 border-l py-2 text-muted-foreground transition hover:bg-accent/30 hover:text-foreground"
		onclick={() => onToggle?.(true)}
		title="Team knowledge bundle ({concepts.length} concept{concepts.length === 1 ? '' : 's'})"
		data-testid="knowledge-strip"
	>
		<span class="relative">
			<BookOpen class="size-4 {pulse ? 'text-sky-300' : ''}" />
			{#if pulse}
				<span class="absolute -right-1 -top-1 size-2 animate-ping rounded-full bg-sky-400"></span>
			{/if}
		</span>
		{#if concepts.length > 0}
			<span class="rounded-full bg-muted px-1 text-[10px] tabular-nums {pulse ? 'text-sky-300' : ''}">
				{concepts.length}
			</span>
		{/if}
		<span class="text-[9px] font-medium uppercase tracking-widest" style="writing-mode: vertical-rl">
			Knowledge
		</span>
	</button>
{:else}
	<div class="flex min-h-0 flex-col border-l" transition:fly={{ x: 40, duration: 150 }}>
		<!-- header -->
		<div class="flex items-center gap-1.5 border-b px-2 py-1.5">
			{#if selected}
				<button
					type="button"
					class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
					onclick={() => (selectedPath = null)}
					title="Back to the index"
				>
					<ArrowLeft class="size-3.5" />
				</button>
				<span class="min-w-0 truncate text-xs font-medium">{selected.path}</span>
			{:else}
				<BookOpen class="size-3.5 shrink-0 text-sky-300" />
				<span class="text-xs font-medium">Knowledge</span>
				<span class="text-[10px] text-muted-foreground">({concepts.length})</span>
			{/if}
			<button
				type="button"
				class="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
				onclick={() => onToggle?.(false)}
				title="Collapse"
			>
				<ChevronsRight class="size-3.5" />
			</button>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#if selected}
				<!-- document view: the OKF wire format, verbatim -->
				<pre class="whitespace-pre-wrap break-words p-2.5 font-mono text-[11px] leading-relaxed text-foreground/90">{selected.content}</pre>
			{:else if concepts.length === 0}
				<p class="p-3 text-xs italic text-muted-foreground/70">
					Nothing published yet — concepts appear here as teammates publish_knowledge.
				</p>
			{:else}
				{#each groups as [dir, list] (dir)}
					<div class="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
						{dir}/
					</div>
					{#each list as f (f.path)}
						{@const title = fm(f.content, 'title') ?? f.path.split('/').pop()}
						{@const type = fm(f.content, 'type')}
						<button
							type="button"
							class="flex w-full items-center gap-1.5 px-2 py-1 text-left transition hover:bg-accent/30"
							onclick={() => (selectedPath = f.path)}
						>
							{#if freshPaths.has(f.path)}
								<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" title="just updated"></span>
							{:else}
								<FileText class="size-3 shrink-0 text-muted-foreground/60" />
							{/if}
							<span class="min-w-0 flex-1 truncate text-[11px]">{title}</span>
							{#if type}
								<Badge variant="outline" class="shrink-0 px-1 text-[9px]">{type}</Badge>
							{/if}
						</button>
					{/each}
				{/each}
				<!-- reserved files, tucked at the bottom -->
				<div class="mt-2 border-t border-border/40 px-2 py-1.5">
					{#each files.filter((f) => RESERVED.has(f.path.split('/').pop() ?? '')) as f (f.path)}
						<button
							type="button"
							class="flex w-full items-center gap-1.5 px-0.5 py-0.5 text-left text-[10px] text-muted-foreground hover:text-foreground"
							onclick={() => (selectedPath = f.path)}
						>
							<FileText class="size-3 shrink-0" />{f.path}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
