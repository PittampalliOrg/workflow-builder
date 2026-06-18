<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		Loader2,
		RefreshCw,
		Search,
		CircleAlert,
		X,
		Sparkles,
		Wrench,
		Layers,
		Clock,
		ArrowRight
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { resolveSpanKind, SPAN_KIND_STYLE } from './span-kind';

	// Resolve a span-kind style for a row from its root operation name (heuristic).
	function kindFor(op: string) {
		return SPAN_KIND_STYLE[resolveSpanKind({ operationName: op, attributes: undefined, spanKind: undefined })];
	}

	interface Trace {
		traceId: string;
		rootOperation: string;
		rootService: string;
		services: string[];
		startTime: string;
		duration: number;
		spanCount: number;
		llmCount: number;
		toolCount: number;
		totalTokens: number;
		status: 'ok' | 'error';
		goal?: { status: string; iterations: number; verdict: 'pass' | 'active' | 'limited' | 'paused' } | null;
	}

	const GOAL_CHIP: Record<string, { label: string; cls: string }> = {
		pass: { label: 'goal ✓', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
		active: { label: 'goal …', cls: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300' },
		limited: { label: 'goal ⊘', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
		paused: { label: 'goal ‖', cls: 'border-white/15 bg-white/5 text-zinc-300' }
	};

	interface Props {
		/** Where a row navigates: `${detailBase}/<traceId>`. */
		detailBase: string;
		/** Optional session deep-link filter (chip + ?sessionId=). */
		sessionId?: string | null;
		/** Called to clear the session filter (e.g. navigate to the unfiltered list). */
		onClearSession?: () => void;
	}

	let { detailBase, sessionId = null, onClearSession }: Props = $props();

	let traces = $state<Trace[]>([]);
	let services = $state<string[]>([]);
	let selectedService = $state('');
	let selectedStatus = $state('');
	let range = $state('24h');
	let search = $state('');
	let isLoading = $state(false);
	let autoRefresh = $state(false);
	let error = $state<string | null>(null);

	// Stable color per service name (deterministic hue).
	const SERVICE_HUES = [199, 152, 32, 280, 0, 48, 220, 330, 100, 260];
	function serviceColor(name: string): string {
		let h = 0;
		for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
		const hue = SERVICE_HUES[h % SERVICE_HUES.length];
		return `hsl(${hue} 70% 60%)`;
	}

	const maxDuration = $derived(Math.max(1, ...traces.map((t) => t.duration)));

	async function fetchTraces() {
		isLoading = true;
		error = null;
		try {
			const params = new URLSearchParams({ limit: '60', range });
			if (selectedService) params.set('service', selectedService);
			if (selectedStatus) params.set('status', selectedStatus);
			if (search.trim()) params.set('search', search.trim());
			if (sessionId) params.set('sessionId', sessionId);
			const res = await fetch(`/api/observability/traces?${params}`);
			const data = await res.json();
			if (data.error && !data.traces?.length) error = data.error;
			traces = data.traces ?? [];
			if (data.services?.length) services = data.services;
		} catch (err) {
			error = 'Failed to fetch traces';
			console.error(err);
		} finally {
			isLoading = false;
		}
	}

	// Refetch on any filter / session change.
	$effect(() => {
		void selectedService;
		void selectedStatus;
		void range;
		void sessionId;
		fetchTraces();
	});

	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(fetchTraces, 300);
	}

	$effect(() => {
		if (!autoRefresh) return;
		const t = setInterval(fetchTraces, 5000);
		return () => clearInterval(t);
	});

	function formatDuration(ms: number): string {
		if (ms < 1) return '<1ms';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
		return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
	}
	function relTime(iso: string): string {
		const d = new Date(iso).getTime();
		const s = Math.max(0, (Date.now() - d) / 1000);
		if (s < 60) return `${Math.floor(s)}s ago`;
		if (s < 3600) return `${Math.floor(s / 60)}m ago`;
		if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
		return `${Math.floor(s / 86400)}d ago`;
	}
	function formatTokens(n: number): string {
		if (!n) return '';
		if (n < 1000) return `${n}`;
		return `${(n / 1000).toFixed(1)}k`;
	}
</script>

<div class="flex h-full flex-col bg-[#0b0c0e] text-zinc-200">
	<!-- Toolbar -->
	<header class="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-6 py-3">
		<div class="flex items-center gap-2.5">
			<div class="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/30 to-emerald-500/20 ring-1 ring-white/10">
				<Layers size={15} class="text-cyan-300" />
			</div>
			<h1 class="text-sm font-semibold tracking-tight text-zinc-100">Traces</h1>
			{#if sessionId}
				<Badge variant="secondary" class="gap-1 text-[10px] font-mono">
					session={sessionId.slice(0, 12)}
					<button
						type="button"
						class="ml-0.5 inline-flex size-3 items-center justify-center rounded hover:bg-background/60"
						onclick={() => onClearSession?.()}
						aria-label="Clear session filter"
					>
						<X size={10} />
					</button>
				</Badge>
			{/if}
			<span class="text-[11px] text-zinc-500">{traces.length} trace{traces.length === 1 ? '' : 's'}</span>
		</div>
		<div class="flex items-center gap-2">
			<div class="relative">
				<Search size={13} class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
				<Input
					bind:value={search}
					oninput={onSearchInput}
					placeholder="Search id / operation / session"
					class="h-8 w-56 border-white/10 bg-white/5 pl-7 text-xs"
				/>
			</div>
			<NativeSelect bind:value={selectedService} class="h-8 border-white/10 bg-white/5 text-xs">
				<option value="">All services</option>
				{#each services as svc}<option value={svc}>{svc}</option>{/each}
			</NativeSelect>
			<NativeSelect bind:value={selectedStatus} class="h-8 border-white/10 bg-white/5 text-xs">
				<option value="">Any status</option>
				<option value="ok">OK</option>
				<option value="error">Error</option>
			</NativeSelect>
			<NativeSelect bind:value={range} class="h-8 border-white/10 bg-white/5 text-xs">
				<option value="1h">1h</option>
				<option value="6h">6h</option>
				<option value="24h">24h</option>
				<option value="7d">7d</option>
			</NativeSelect>
			<Button
				variant="ghost"
				size="icon"
				class="size-8 text-zinc-400 hover:text-zinc-100"
				onclick={fetchTraces}
				disabled={isLoading}
				title="Refresh"
			>
				<RefreshCw size={15} class={isLoading ? 'animate-spin' : ''} />
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-auto px-4 py-4">
		{#if error}
			<Alert variant="destructive" class="mb-4">
				<CircleAlert class="size-4" />
				<AlertDescription>{error}</AlertDescription>
			</Alert>
		{/if}

		{#if isLoading && traces.length === 0}
			<div class="flex items-center justify-center p-16">
				<Loader2 size={24} class="animate-spin text-zinc-500" />
			</div>
		{:else if traces.length === 0}
			<div class="mx-auto mt-16 max-w-sm rounded-2xl border border-white/10 bg-white/[0.02] p-8 text-center">
				<Layers size={28} class="mx-auto mb-3 text-zinc-600" />
				<p class="text-sm font-medium text-zinc-300">No traces yet</p>
				<p class="mt-1 text-xs text-zinc-500">
					Run a workflow or agent session — its trace will appear here within seconds.
				</p>
			</div>
		{:else}
			<div class="space-y-1.5">
				{#each traces as trace (trace.traceId)}
					<button
						type="button"
						class="group block w-full rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-white/[0.01] px-4 py-3 text-left transition-all hover:border-white/20 hover:from-white/[0.07]"
						onclick={() => goto(`${detailBase}/${trace.traceId}`)}
					>
						<div class="flex items-center gap-3">
							<!-- status dot -->
							<span
								class="size-2 shrink-0 rounded-full {trace.status === 'error' ? 'bg-red-400 shadow-[0_0_8px] shadow-red-500/50' : 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-500/40'}"
							></span>
							<!-- operation + service -->
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									{#if trace.rootOperation}
										{@const ks = kindFor(trace.rootOperation)}
										{@const KIcon = ks.icon}
										<span class="flex size-5 shrink-0 items-center justify-center rounded {ks.bg} ring-1 ring-inset {ks.border}" title={ks.label}>
											<KIcon size={11} class={ks.text} />
										</span>
									{/if}
									<span class="truncate text-sm font-medium text-zinc-100">{trace.rootOperation || '(unnamed)'}</span>
									<Badge variant="outline" class="shrink-0 border-white/15 text-[10px] text-zinc-400">{trace.rootService}</Badge>
									{#if trace.goal}
										<span class="shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium {GOAL_CHIP[trace.goal.verdict]?.cls ?? GOAL_CHIP.active.cls}" title="Goal: {trace.goal.status} ({trace.goal.iterations} iter)">
											{GOAL_CHIP[trace.goal.verdict]?.label ?? 'goal'}
										</span>
									{/if}
								</div>
								<div class="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-zinc-600">
									<span>{trace.traceId.slice(0, 24)}</span>
								</div>
							</div>

							<!-- service swatches -->
							<div class="hidden items-center gap-1 md:flex" title={trace.services.join(', ')}>
								{#each trace.services.slice(0, 6) as svc (svc)}
									<span class="size-2 rounded-sm" style="background:{serviceColor(svc)}" title={svc}></span>
								{/each}
								{#if trace.services.length > 6}
									<span class="text-[9px] text-zinc-500">+{trace.services.length - 6}</span>
								{/if}
							</div>

							<!-- counts -->
							<div class="hidden items-center gap-3 text-[11px] text-zinc-400 lg:flex">
								<span class="inline-flex items-center gap-1" title="Spans"><Layers size={11} class="text-zinc-500" />{trace.spanCount}</span>
								{#if trace.llmCount}<span class="inline-flex items-center gap-1 text-cyan-300/90" title="LLM calls"><Sparkles size={11} />{trace.llmCount}</span>{/if}
								{#if trace.toolCount}<span class="inline-flex items-center gap-1 text-emerald-300/90" title="Tool calls"><Wrench size={11} />{trace.toolCount}</span>{/if}
								{#if trace.totalTokens}<span class="tabular-nums text-violet-300/80" title="Total tokens">{formatTokens(trace.totalTokens)} tok</span>{/if}
							</div>

							<!-- duration bar -->
							<div class="hidden w-40 shrink-0 sm:block">
								<div class="h-1.5 overflow-hidden rounded-full bg-white/5">
									<div
										class="h-full rounded-full {trace.status === 'error' ? 'bg-red-400/80' : 'bg-cyan-400/70'}"
										style="width:{Math.max(3, (trace.duration / maxDuration) * 100)}%"
									></div>
								</div>
								<div class="mt-1 text-right font-mono text-[10px] tabular-nums text-zinc-400">{formatDuration(trace.duration)}</div>
							</div>

							<!-- time -->
							<div class="hidden w-16 shrink-0 items-center justify-end gap-1 text-[10px] text-zinc-500 xl:flex">
								<Clock size={10} />{relTime(trace.startTime)}
							</div>
							<ArrowRight size={14} class="shrink-0 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-zinc-300" />
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>
