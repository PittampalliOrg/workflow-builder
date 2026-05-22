<script lang="ts">
	import { ChevronsDownUp, ChevronsUpDown } from '@lucide/svelte';
	import type { ObservabilityTraceSpan } from '$lib/types/observability';
	import DrilldownSpanRow from './drilldown-span-row.svelte';
	import { buildIoFallbackBySpanId } from './io-fallback';

	let { spans }: { spans: ObservabilityTraceSpan[] } = $props();

	const ROW_CAP = 800;
	const DEFAULT_DEPTH = 2;

	// Build a forest from parentSpanId; roots = spans whose parent isn't present.
	let tree = $derived.by(() => {
		const byId = new Map(spans.map((s) => [s.spanId, s]));
		const childrenOf = new Map<string, ObservabilityTraceSpan[]>();
		const roots: ObservabilityTraceSpan[] = [];
		for (const s of spans) {
			if (s.parentSpanId && byId.has(s.parentSpanId)) {
				const list = childrenOf.get(s.parentSpanId);
				if (list) list.push(s);
				else childrenOf.set(s.parentSpanId, [s]);
			} else {
				roots.push(s);
			}
		}
		const byStart = (a: ObservabilityTraceSpan, b: ObservabilityTraceSpan) =>
			new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
		roots.sort(byStart);
		for (const list of childrenOf.values()) list.sort(byStart);
		return { childrenOf, roots };
	});

	let globalMaxMs = $derived(Math.max(1, ...spans.map((s) => s.duration)));
	let hasChildren = (id: string) => (tree.childrenOf.get(id)?.length ?? 0) > 0;
	let ioFallbackBySpanId = $derived(buildIoFallbackBySpanId(spans));

	let expanded = $state(new Set<string>());
	let selectedSpanId = $state<string | null>(null);

	// Default-expand the top DEFAULT_DEPTH levels whenever the span set changes.
	$effect(() => {
		const next = new Set<string>();
		const seed = (nodes: ObservabilityTraceSpan[], depth: number) => {
			for (const n of nodes) {
				if (depth < DEFAULT_DEPTH && hasChildren(n.spanId)) {
					next.add(n.spanId);
					seed(tree.childrenOf.get(n.spanId) ?? [], depth + 1);
				}
			}
		};
		seed(tree.roots, 0);
		expanded = next;
		selectedSpanId = null;
	});

	type FlatRow = { span: ObservabilityTraceSpan; depth: number; hasChildren: boolean };
	let visible = $derived.by(() => {
		const out: FlatRow[] = [];
		const seen = new Set<string>();
		const walk = (nodes: ObservabilityTraceSpan[], depth: number) => {
			for (const span of nodes) {
				if (out.length >= ROW_CAP || seen.has(span.spanId)) continue;
				seen.add(span.spanId);
				const kids = hasChildren(span.spanId);
				out.push({ span, depth, hasChildren: kids });
				if (kids && expanded.has(span.spanId)) {
					walk(tree.childrenOf.get(span.spanId) ?? [], depth + 1);
				}
			}
		};
		walk(tree.roots, 0);
		return out;
	});

	function toggle(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}
	function select(id: string) {
		selectedSpanId = selectedSpanId === id ? null : id;
	}
	function expandAll() {
		expanded = new Set(spans.filter((s) => hasChildren(s.spanId)).map((s) => s.spanId));
	}
	function collapseAll() {
		expanded = new Set();
	}
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center justify-between px-1 pb-1.5">
		<span class="text-[11px] text-muted-foreground">{spans.length} spans · ordered by causality</span>
		<div class="flex gap-1">
			<button class="wb-tool" onclick={expandAll} title="Expand all">
				<ChevronsUpDown size={13} />
			</button>
			<button class="wb-tool" onclick={collapseAll} title="Collapse all">
				<ChevronsDownUp size={13} />
			</button>
		</div>
	</div>
	<div class="min-h-0 flex-1 overflow-auto pr-1">
		{#each visible as row (row.span.traceId + row.span.spanId)}
			<DrilldownSpanRow
				span={row.span}
				depth={row.depth}
				hasChildren={row.hasChildren}
				expanded={expanded.has(row.span.spanId)}
				selected={selectedSpanId === row.span.spanId}
				{globalMaxMs}
				ioFallback={ioFallbackBySpanId.get(row.span.spanId) ?? null}
				onToggle={() => toggle(row.span.spanId)}
				onSelect={() => select(row.span.spanId)}
			/>
		{/each}
		{#if visible.length >= ROW_CAP}
			<p class="px-2 py-2 text-[11px] text-muted-foreground">
				Showing first {ROW_CAP} spans. Narrow the selection to see more.
			</p>
		{/if}
	</div>
</div>

<style>
	.wb-tool {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 22px;
		border-radius: calc(var(--radius) - 4px);
		border: 1px solid var(--border);
		color: var(--muted-foreground);
		background: var(--card);
	}
	.wb-tool:hover {
		color: var(--foreground);
		background: var(--muted);
	}
</style>
