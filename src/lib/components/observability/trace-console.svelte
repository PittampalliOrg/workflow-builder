<script lang="ts">
	import type { ObservabilityTraceSpan } from '$lib/types/observability';
	import {
		resolveSpanKind,
		SPAN_KIND_STYLE,
		ERROR_STYLE,
		serviceColor,
		formatDuration,
		formatTokens
	} from './span-kind';
	import { ChevronDown, ChevronRight, Zap } from '@lucide/svelte';

	export type ColorMode = 'kind' | 'service' | 'duration';

	interface Props {
		/** Visible spans (already filtered by service/signal upstream). */
		spans: ObservabilityTraceSpan[];
		/** `${traceId}:${spanId}` of the selected span. */
		selectedKey?: string | null;
		/** When non-null, only these keys match the active filter (others dim). */
		matchKeys?: Set<string> | null;
		/** Cross-highlight keys from the selected turn. */
		relatedKeys?: Set<string>;
		llmMeta?: Record<string, { model: string | null; tokens: number | null }>;
		toolMeta?: Record<string, { name: string }>;
		logCounts?: Record<string, number>;
		colorMode?: ColorMode;
		showCriticalPath?: boolean;
		globalStartMs: number;
		globalDurationMs: number;
		/** Bumping these from the parent triggers collapse-all / expand-all. */
		collapseSignal?: number;
		expandSignal?: number;
		onSelectSpan?: (span: ObservabilityTraceSpan) => void;
	}

	let {
		spans,
		selectedKey = null,
		matchKeys = null,
		relatedKeys = new Set<string>(),
		llmMeta = {},
		toolMeta = {},
		logCounts = {},
		colorMode = 'kind',
		showCriticalPath = false,
		globalStartMs,
		globalDurationMs,
		collapseSignal = 0,
		expandSignal = 0,
		onSelectSpan = () => {}
	}: Props = $props();

	const key = (s: ObservabilityTraceSpan) => `${s.traceId}:${s.spanId}`;

	// --- Build the span forest (parent → children) per the flat span list ---
	interface TreeNode {
		span: ObservabilityTraceSpan;
		children: TreeNode[];
		depth: number;
		descendants: number;
		endMs: number;
	}

	const forest = $derived.by(() => {
		const byId = new Map<string, ObservabilityTraceSpan>();
		for (const s of spans) byId.set(s.spanId, s);
		const childrenOf = new Map<string, ObservabilityTraceSpan[]>();
		const roots: ObservabilityTraceSpan[] = [];
		for (const s of spans) {
			if (s.parentSpanId && byId.has(s.parentSpanId)) {
				const arr = childrenOf.get(s.parentSpanId) ?? [];
				arr.push(s);
				childrenOf.set(s.parentSpanId, arr);
			} else {
				roots.push(s);
			}
		}
		const sortByStart = (a: ObservabilityTraceSpan, b: ObservabilityTraceSpan) =>
			new Date(a.startTime).getTime() - new Date(b.startTime).getTime();

		function build(span: ObservabilityTraceSpan, depth: number): TreeNode {
			const kids = (childrenOf.get(span.spanId) ?? []).sort(sortByStart).map((c) => build(c, depth + 1));
			const descendants = kids.reduce((n, k) => n + 1 + k.descendants, 0);
			const endMs = Math.max(
				new Date(span.startTime).getTime() + span.duration,
				...kids.map((k) => k.endMs)
			);
			return { span, children: kids, depth, descendants, endMs };
		}
		return roots.sort(sortByStart).map((r) => build(r, 0));
	});

	// --- Critical path: from each root, follow the latest-finishing child ---
	const criticalKeys = $derived.by(() => {
		const set = new Set<string>();
		if (!showCriticalPath) return set;
		function walk(node: TreeNode) {
			set.add(key(node.span));
			if (node.children.length === 0) return;
			const next = node.children.reduce((a, b) => (b.endMs > a.endMs ? b : a));
			walk(next);
		}
		for (const root of forest) walk(root);
		return set;
	});

	// --- Collapse state (internal) ---
	let collapsed = $state(new Set<string>());

	function toggle(spanId: string) {
		const next = new Set(collapsed);
		if (next.has(spanId)) next.delete(spanId);
		else next.add(spanId);
		collapsed = next;
	}

	// React to collapse-all / expand-all signals from the parent toolbar.
	let lastCollapse = $state(0);
	let lastExpand = $state(0);
	$effect(() => {
		if (collapseSignal !== lastCollapse) {
			lastCollapse = collapseSignal;
			const next = new Set<string>();
			const visit = (n: TreeNode) => {
				if (n.children.length) next.add(n.span.spanId);
				n.children.forEach(visit);
			};
			forest.forEach(visit);
			collapsed = next;
		}
	});
	$effect(() => {
		if (expandSignal !== lastExpand) {
			lastExpand = expandSignal;
			collapsed = new Set();
		}
	});

	// --- Flatten the forest into visible rows honoring collapse ---
	interface Row {
		span: ObservabilityTraceSpan;
		depth: number;
		hasChildren: boolean;
		childCount: number;
		descendants: number;
		isCollapsed: boolean;
	}

	const rows = $derived.by(() => {
		const out: Row[] = [];
		function walk(node: TreeNode) {
			const isCollapsed = collapsed.has(node.span.spanId);
			out.push({
				span: node.span,
				depth: node.depth,
				hasChildren: node.children.length > 0,
				childCount: node.children.length,
				descendants: node.descendants,
				isCollapsed
			});
			if (!isCollapsed) node.children.forEach(walk);
		}
		forest.forEach(walk);
		return out;
	});

	// Cap very large traces to keep the DOM light; offer "show all".
	let showAll = $state(false);
	const ROW_CAP = 600;
	const cappedRows = $derived(showAll ? rows : rows.slice(0, ROW_CAP));
	const hiddenCount = $derived(rows.length - cappedRows.length);

	function offsetPct(s: ObservabilityTraceSpan): number {
		if (globalDurationMs <= 0) return 0;
		return Math.max(0, ((new Date(s.startTime).getTime() - globalStartMs) / globalDurationMs) * 100);
	}
	function widthPct(s: ObservabilityTraceSpan): number {
		if (globalDurationMs <= 0) return 100;
		return Math.min(100, Math.max((s.duration / globalDurationMs) * 100, 0.6));
	}

	// Bar appearance per color mode (error always wins).
	function barStyle(s: ObservabilityTraceSpan): { class: string; style: string } {
		if (s.status === 'error') return { class: ERROR_STYLE.bar, style: '' };
		if (colorMode === 'service') {
			const c = serviceColor(s.serviceName);
			return { class: '', style: `background:linear-gradient(90deg, ${c}, ${c}cc)` };
		}
		if (colorMode === 'duration') {
			const ratio = globalDurationMs > 0 ? s.duration / globalDurationMs : 0;
			if (ratio > 0.2) return { class: 'bg-gradient-to-r from-red-500 to-orange-400', style: '' };
			if (ratio > 0.05) return { class: 'bg-gradient-to-r from-amber-500 to-amber-300', style: '' };
			return { class: 'bg-gradient-to-r from-emerald-500 to-emerald-300', style: '' };
		}
		return { class: SPAN_KIND_STYLE[resolveSpanKind(s)].bar, style: '' };
	}

	const ticks = [0, 0.25, 0.5, 0.75, 1];

	// Auto-scroll the selected row into view (error-nav, turn cross-select).
	let scrollEl = $state<HTMLElement | null>(null);
	$effect(() => {
		const k = selectedKey;
		if (!k || !scrollEl) return;
		const node = scrollEl.querySelector(`[data-spankey="${CSS.escape(k)}"]`);
		node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});
</script>

<div class="flex h-full flex-col">
	<!-- Sticky header: column labels + time-axis ruler -->
	<div class="sticky top-0 z-10 flex items-stretch border-b border-white/10 bg-[#0b0c0e]/95 backdrop-blur">
		<div class="flex w-[46%] min-w-0 items-center gap-2 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-zinc-500">
			Span
		</div>
		<div class="relative flex-1 px-3 py-1.5">
			<div class="relative h-full">
				{#each ticks as t}
					<div class="absolute top-0 bottom-0 flex flex-col" style="left:{t * 100}%">
						<span class="-translate-x-1/2 whitespace-nowrap font-mono text-[9px] tabular-nums text-zinc-600">
							{formatDuration(t * globalDurationMs)}
						</span>
					</div>
				{/each}
			</div>
		</div>
	</div>

	<div class="flex-1 overflow-auto" bind:this={scrollEl}>
		{#if cappedRows.length === 0}
			<div class="px-4 py-12 text-center text-sm text-zinc-500">No spans match the current filters.</div>
		{:else}
			<!-- gridline backdrop for the waterfall lane -->
			<div class="relative">
				{#each cappedRows as row (key(row.span))}
					{@const s = row.span}
					{@const k = key(s)}
					{@const kind = resolveSpanKind(s)}
					{@const style = s.status === 'error' ? ERROR_STYLE : SPAN_KIND_STYLE[kind]}
					{@const Icon = SPAN_KIND_STYLE[kind].icon}
					{@const isSelected = selectedKey === k}
					{@const isDimmed = matchKeys != null && !matchKeys.has(k)}
					{@const isMatch = matchKeys != null && matchKeys.has(k)}
					{@const isRelated = relatedKeys.has(k)}
					{@const onCritical = criticalKeys.has(k)}
					{@const bar = barStyle(s)}
					{@const llm = llmMeta[k]}
					{@const tool = toolMeta[k]}
					<div
						role="button"
						tabindex="0"
						data-spankey={k}
						class="group flex w-full cursor-pointer items-stretch border-b border-white/[0.04] text-left transition-colors duration-100
							{isSelected ? 'bg-cyan-500/[0.07] ring-1 ring-inset ring-cyan-500/20' : isRelated ? 'bg-white/[0.04]' : 'hover:bg-white/[0.03]'}
							{isDimmed ? 'opacity-25' : ''}
							{isMatch ? 'bg-amber-500/[0.05]' : ''}"
						onclick={() => onSelectSpan(s)}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectSpan(s); } }}
					>
						<!-- LEFT: tree + name + meta -->
						<div class="relative flex w-[46%] min-w-0 items-center py-1.5 pr-2" style="padding-left:{8 + row.depth * 14}px">
							<!-- depth guide lines -->
							{#each Array.from({ length: row.depth }) as _, d (d)}
								<span class="absolute top-0 bottom-0 w-px bg-white/[0.06]" style="left:{14 + d * 14}px"></span>
							{/each}

							<!-- caret / spacer -->
							{#if row.hasChildren}
								<button
									class="z-[1] mr-1 flex size-4 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
									onclick={(e) => { e.stopPropagation(); toggle(s.spanId); }}
									aria-label={row.isCollapsed ? 'Expand' : 'Collapse'}
								>
									{#if row.isCollapsed}<ChevronRight size={12} />{:else}<ChevronDown size={12} />{/if}
								</button>
							{:else}
								<span class="mr-1 size-4 shrink-0"></span>
							{/if}

							<!-- selection/critical rail -->
							<span
								class="mr-2 h-4 w-[3px] shrink-0 rounded-full {isSelected ? 'bg-cyan-400' : onCritical ? 'bg-amber-400' : style.dot}"
								class:opacity-40={!isSelected && !onCritical}
							></span>

							<Icon size={13} class="mr-1.5 shrink-0 {s.status === 'error' ? 'text-red-400' : style.text}" />

							<span class="truncate font-mono text-[12.5px] {s.status === 'error' ? 'text-red-200' : 'text-zinc-100'}">{s.operationName}</span>

							{#if row.isCollapsed && row.descendants > 0}
								<span class="ml-1.5 shrink-0 rounded-full bg-white/10 px-1.5 text-[9px] tabular-nums text-zinc-400">{row.descendants}</span>
							{/if}
							{#if onCritical}
								<Zap size={10} class="ml-1 shrink-0 text-amber-400" />
							{/if}
						</div>

						<!-- RIGHT: waterfall lane -->
						<div class="relative flex-1 px-3 py-1.5">
							<!-- vertical gridlines -->
							{#each ticks as t}
								<span class="pointer-events-none absolute top-0 bottom-0 w-px bg-white/[0.03]" style="left:calc({t * 100}% )"></span>
							{/each}
							<div class="relative h-5">
								<div
									class="absolute top-1/2 flex h-[7px] -translate-y-1/2 items-center rounded-full {bar.class} shadow-sm"
									style="left:{offsetPct(s)}%; width:{widthPct(s)}%; min-width:3px; {bar.style}"
								></div>
								<!-- meta floats after the bar -->
								<div
									class="absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap pl-2 text-[10px]"
									style="left:calc({Math.min(offsetPct(s) + widthPct(s), 88)}%)"
								>
									<span class="font-mono tabular-nums {s.status === 'error' ? 'text-red-300' : 'text-zinc-300'}">{formatDuration(s.duration)}</span>
									{#if llm?.model}<span class="hidden truncate text-cyan-300/80 lg:inline">{llm.model}</span>{/if}
									{#if llm?.tokens}<span class="hidden font-mono tabular-nums text-cyan-300/60 lg:inline">{formatTokens(llm.tokens)}</span>{/if}
									{#if tool?.name}<span class="hidden truncate text-emerald-300/80 lg:inline">{tool.name}</span>{/if}
									{#if (logCounts[k] ?? 0) > 0}<span class="hidden font-mono text-amber-300/60 xl:inline">{logCounts[k]}&nbsp;log</span>{/if}
									<span class="hidden truncate text-zinc-600 xl:inline">{s.serviceName}</span>
								</div>
							</div>
						</div>
					</div>
				{/each}

				{#if hiddenCount > 0}
					<button
						class="w-full border-b border-white/5 bg-white/[0.02] px-4 py-2 text-center text-xs text-zinc-400 hover:bg-white/5"
						onclick={() => (showAll = true)}
					>
						Show {hiddenCount} more spans
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>
