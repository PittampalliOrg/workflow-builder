<script lang="ts">
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import HeadlampLogo from '$lib/components/gitops/icons/HeadlampLogo.svelte';
	import { embeddedHeadlampResourceUrl, type HeadlampCluster } from '$lib/headlamp/links';
	import {
		Activity,
		Bot,
		Check,
		ChevronDown,
		Coins,
		Copy,
		ExternalLink,
		FileDiff,
		FlaskConical,
		Loader2,
		Repeat,
		Scale,
		StopCircle,
		Timer,
		Wrench,
		X
	} from '@lucide/svelte';
	import PromoteToDataset from './promote-to-dataset.svelte';
	import RenderedPatch from './rendered-patch.svelte';
	import RunStatusBadge from './run-status-badge.svelte';
	import TraceDetail from './trace-detail.svelte';
	import { formatDuration, formatRelative, formatTokens } from './run-status-helpers';
	import type { ParsedHarnessResult } from '$lib/server/benchmarks/harness-result';
	import type {
		ObservabilityLlmSpan,
		ObservabilityToolSpan,
		ObservabilityTraceSpan
	} from '$lib/types/observability';

	type DrilldownPayload = {
		runInstance: {
			id: string;
			instanceId: string;
			repo: string | null;
			status: string;
			inferenceStatus: string;
			evaluationStatus: string;
			modelPatch: string | null;
			patchBytes: number | null;
			patchAddedLines: number | null;
			patchRemovedLines: number | null;
			patchFilesTouched: number | null;
			patchFilesOverlapGold: number | null;
			patchWellFormed: boolean | null;
			turnCount: number | null;
			toolCallCount: number | null;
			terminationReason: string | null;
			ttftFirstMs: number | null;
			ttftFirstToolMs: number | null;
			toolHistogram: Record<string, number> | null;
			testOutputSummary: string | null;
			usage: Record<string, unknown> | null;
			timings: Record<string, unknown> | null;
			traceIds: string[] | null;
			sessionId: string | null;
			workflowExecutionId: string | null;
			daprInstanceId: string | null;
			mlflowTracesUrl: string | null;
			hostJobName: string | null;
			sandboxName: string | null;
			workspaceRef: string | null;
			logsPath: string | null;
			startedAt: string | null;
			inferenceCompletedAt: string | null;
			evaluatedAt: string | null;
			error: string | null;
			inferenceError: string | null;
			evaluationError: string | null;
		};
		instance: {
			repo: string | null;
			baseCommit: string | null;
			problemStatement: string | null;
			hintsText: string | null;
			testMetadata: Record<string, unknown> | null;
			metadata: Record<string, unknown> | null;
		};
		goldPatch: string | null;
		goldPatchStats: {
			addedLines: number;
			removedLines: number;
			filesTouched: number;
		};
		parsedHarness: ParsedHarnessResult;
		postHocEvaluationArtifactsAvailable: boolean;
	};

	type Props = {
		open: boolean;
		runId: string | null;
		instanceId: string | null;
		workspaceSlug: string;
		headlampCluster?: HeadlampCluster;
		onOpenChange: (next: boolean) => void;
		onTerminated?: () => void;
	};

	let {
		open = $bindable(false),
		runId,
		instanceId,
		workspaceSlug,
		headlampCluster = 'ryzen',
		onOpenChange,
		onTerminated
	}: Props = $props();

	type SpansPayload = {
		traceIds: string[];
		mlflowTracesUrl: string | null;
		backend?: string;
		artifactPath?: string | null;
		traceSpans?: ObservabilityTraceSpan[];
		llmSpans: ObservabilityLlmSpan[];
		toolSpans: ObservabilityToolSpan[];
		summary?: {
			traceCount: number;
			traceSpanCount: number;
			llmSpanCount: number;
			toolSpanCount: number;
			errorSpanCount: number;
			source: string;
		};
		warnings?: string[];
		truncated?: boolean;
		nextCursor?: string | null;
	};

	type TabValue = 'overview' | 'patch' | 'scoring' | 'trace' | 'harness' | 'logs';

	let detail = $state<DrilldownPayload | null>(null);
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);
	let activeTab = $state<TabValue>('overview');
	let patchView = $state<'model' | 'gold' | 'both'>('both');
	let patchMode = $state<'rendered' | 'raw'>('rendered');
	let copied = $state<string | null>(null);
	let spans = $state<SpansPayload | null>(null);
	let spansLoading = $state(false);
	let spansLoadingMore = $state(false);
	let spansError = $state<string | null>(null);
	let spansMoreError = $state<string | null>(null);
	let terminating = $state(false);

	const canTerminate = $derived(
		!!detail &&
			['queued', 'inferencing', 'evaluating'].includes(detail.runInstance.status)
	);
	const hostJobHeadlampUrl = $derived(
		detail?.runInstance.hostJobName
			? embeddedHeadlampResourceUrl({
					workspaceSlug,
					cluster: headlampCluster,
					kind: 'Job',
					namespace: 'workflow-builder',
					name: detail.runInstance.hostJobName,
					logs: true
				})
			: null
	);

	// --- Resizable panel ---
	const STORAGE_KEY = 'benchmarks.runInstanceDrawer.width';
	const MIN_WIDTH = 480;
	const MAX_WIDTH = 1200;

	function defaultWidth() {
		if (typeof window === 'undefined') return 880;
		return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.55)));
	}

	function loadStoredWidth(): number {
		if (typeof window === 'undefined') return defaultWidth();
		try {
			const raw = window.localStorage.getItem(STORAGE_KEY);
			if (!raw) return defaultWidth();
			const n = Number(raw);
			if (!Number.isFinite(n)) return defaultWidth();
			return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
		} catch {
			return defaultWidth();
		}
	}

	let panelWidth = $state(loadStoredWidth());
	let isResizing = $state(false);
	let resizeStartX = 0;
	let resizeStartWidth = 0;

	function persistWidth(w: number) {
		if (typeof window === 'undefined') return;
		try {
			window.localStorage.setItem(STORAGE_KEY, String(w));
		} catch {
			// noop
		}
	}

	function onResizeStart(e: MouseEvent) {
		isResizing = true;
		resizeStartX = e.clientX;
		resizeStartWidth = panelWidth;
		e.preventDefault();
	}

	function onResizeMove(e: MouseEvent) {
		if (!isResizing) return;
		const delta = resizeStartX - e.clientX;
		const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeStartWidth + delta));
		panelWidth = next;
	}

	function onResizeEnd() {
		if (isResizing) {
			isResizing = false;
			persistWidth(panelWidth);
		}
	}

	function onResizeHandleDblClick() {
		const d = defaultWidth();
		panelWidth = d;
		persistWidth(d);
	}

	function close() {
		onOpenChange(false);
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.stopPropagation();
			close();
		}
	}

	$effect(() => {
		if (!open || !runId || !instanceId) {
			return;
		}
		void load(runId, instanceId);
	});

	$effect(() => {
		if (typeof document === 'undefined') return;
		const prev = document.body.style.overflow;
		if (open) {
			document.body.style.overflow = 'hidden';
		} else {
			document.body.style.overflow = prev === 'hidden' ? '' : prev;
		}
		return () => {
			if (typeof document !== 'undefined') document.body.style.overflow = '';
		};
	});

	async function load(rid: string, iid: string) {
		loading = true;
		errorMessage = null;
		detail = null;
		spans = null;
		spansError = null;
		spansMoreError = null;
		try {
			const res = await fetch(
				`/api/benchmarks/runs/${encodeURIComponent(rid)}/instances/${encodeURIComponent(iid)}`
			);
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			detail = (await res.json()) as DrilldownPayload;
			activeTab = 'overview';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function loadSpans(rid: string, iid: string) {
		if (spans || spansLoading) return;
		spansLoading = true;
		spansError = null;
		try {
			const res = await fetch(
				`/api/benchmarks/runs/${encodeURIComponent(rid)}/instances/${encodeURIComponent(iid)}/spans`
			);
			if (!res.ok) throw new Error(`Failed to load spans (${res.status})`);
			spans = (await res.json()) as SpansPayload;
		} catch (err) {
			spansError = err instanceof Error ? err.message : String(err);
		} finally {
			spansLoading = false;
		}
	}

	async function loadMoreSpans(rid: string, iid: string) {
		const cursor = spans?.nextCursor;
		if (!cursor || spansLoadingMore) return;
		spansLoadingMore = true;
		spansMoreError = null;
		try {
			const query = new URLSearchParams({ cursor });
			const res = await fetch(
				`/api/benchmarks/runs/${encodeURIComponent(rid)}/instances/${encodeURIComponent(iid)}/spans?${query}`
			);
			if (!res.ok) throw new Error(`Failed to load more spans (${res.status})`);
			const next = (await res.json()) as SpansPayload;
			spans = spans ? mergeSpansPayload(spans, next) : next;
		} catch (err) {
			spansMoreError = err instanceof Error ? err.message : String(err);
		} finally {
			spansLoadingMore = false;
		}
	}

	function mergeSpansPayload(current: SpansPayload, next: SpansPayload): SpansPayload {
		const traceSpans = dedupeBySpanKey([
			...(current.traceSpans ?? []),
			...(next.traceSpans ?? [])
		]);
		const llmSpans = dedupeBySpanKey([...current.llmSpans, ...next.llmSpans]);
		const toolSpans = dedupeBySpanKey([...current.toolSpans, ...next.toolSpans]);
		return {
			...current,
			...next,
			traceIds: [...new Set([...current.traceIds, ...next.traceIds])],
			traceSpans,
			llmSpans,
			toolSpans,
			warnings: [...new Set([...(current.warnings ?? []), ...(next.warnings ?? [])])],
			summary: next.summary
				? {
						...next.summary,
						traceCount: new Set([...current.traceIds, ...next.traceIds]).size,
						traceSpanCount: traceSpans.length,
						llmSpanCount: llmSpans.length,
						toolSpanCount: toolSpans.length,
						errorSpanCount: traceSpans.filter((span) => span.status === 'error').length
					}
				: current.summary
		};
	}

	function dedupeBySpanKey<T extends { traceId: string; spanId: string }>(items: T[]): T[] {
		return [...new Map(items.map((item) => [`${item.traceId}:${item.spanId}`, item])).values()];
	}

	async function terminateInstance() {
		if (!runId || !instanceId || !detail) return;
		terminating = true;
		errorMessage = null;
		try {
			const res = await fetch(
				`/api/benchmarks/runs/${encodeURIComponent(runId)}/instances/${encodeURIComponent(instanceId)}/terminate`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ reason: 'benchmark instance terminated by user' })
				}
			);
			if (!res.ok) {
				// The terminate endpoint returns 409 { cleanupConfirmed:false, message }
				// while the durable cascade is still converging — the same "requested,
				// converging, retry later" semantic the durable-run Stop surfaces render
				// as 202 "Stopping…". Surface the server's explanatory message as an
				// in-progress notice (retryable) instead of a misleading bare failure.
				const body = (await res
					.json()
					.catch(() => null)) as { message?: string; cleanupConfirmed?: boolean } | null;
				if (res.status === 409 && body?.cleanupConfirmed === false) {
					errorMessage =
						body.message ||
						'Stopping… durable cleanup not yet confirmed; resources left active. Try again shortly.';
					await load(runId, instanceId);
					return;
				}
				throw new Error(body?.message || `Terminate failed (${res.status})`);
			}
			await load(runId, instanceId);
			onTerminated?.();
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			terminating = false;
		}
	}

	$effect(() => {
		if ((activeTab === 'trace' || activeTab === 'scoring') && runId && instanceId) {
			void loadSpans(runId, instanceId);
		}
	});

	async function copyToClipboard(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = key;
			setTimeout(() => {
				if (copied === key) copied = null;
			}, 1200);
		} catch {
			// noop
		}
	}

	function tokenSum(usage: Record<string, unknown> | null | undefined): number {
		if (!usage) return 0;
		const t = usage.total_tokens ?? usage.totalTokens;
		if (typeof t === 'number' && Number.isFinite(t)) return t;
		const i = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
		const o = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
		return (Number.isFinite(i) ? i : 0) + (Number.isFinite(o) ? o : 0);
	}

	function costUsd(usage: Record<string, unknown> | null | undefined): number | null {
		if (!usage || typeof usage !== 'object') return null;
		const c = (usage as { totalCostUsd?: unknown }).totalCostUsd;
		return typeof c === 'number' && Number.isFinite(c) ? c : null;
	}

	function durationMs(ri: DrilldownPayload['runInstance']): number | null {
		if (ri.startedAt && ri.inferenceCompletedAt) {
			const a = new Date(ri.startedAt).getTime();
			const b = new Date(ri.inferenceCompletedAt).getTime();
			if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return b - a;
		}
		return null;
	}

	function formatTtft(ms: number | null): string {
		if (ms == null || !Number.isFinite(ms)) return '—';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatCost(n: number | null): string {
		if (n == null) return '—';
		if (n < 0.01) return '<$0.01';
		return `$${n.toFixed(2)}`;
	}
</script>

<svelte:window onmousemove={onResizeMove} onmouseup={onResizeEnd} onkeydown={onKeyDown} />

{#if open}
	<!-- Backdrop -->
	<button
		type="button"
		aria-label="Close drawer"
		class="fixed inset-0 z-40 bg-black/30 transition-opacity"
		onclick={close}
	></button>

	<!-- Drawer -->
	<div
		role="dialog"
		aria-modal="true"
		aria-labelledby="run-instance-drawer-title"
		class="fixed right-0 top-0 bottom-0 z-50 flex flex-col border-l border-border bg-background shadow-2xl"
		style:width="{panelWidth}px"
	>
		<!-- Resize handle -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute left-0 top-0 bottom-0 z-50 w-1.5 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/40"
			class:bg-primary={isResizing}
			onmousedown={onResizeStart}
			ondblclick={onResizeHandleDblClick}
			title="Drag to resize · double-click to reset"
		></div>

		<!-- Header -->
		<header class="flex-none border-b border-border px-5 pb-3 pt-4">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0 flex-1 space-y-1">
					<div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
						<FlaskConical class="h-3 w-3" />
						<span>Benchmark instance</span>
						{#if detail?.instance.repo}
							<span class="text-foreground/60">·</span>
							<span class="font-mono normal-case tracking-normal text-foreground/80">
								{detail.instance.repo}
							</span>
						{/if}
					</div>
					<h2
						id="run-instance-drawer-title"
						class="break-all font-mono text-base font-semibold text-foreground"
					>
						{instanceId ?? '—'}
					</h2>
					{#if detail}
						<div class="flex flex-wrap items-center gap-1.5 pt-1">
							<RunStatusBadge status={detail.runInstance.status} />
							{#if detail.runInstance.terminationReason}
								<Badge variant="outline" class="font-normal text-[10px]">
									{detail.runInstance.terminationReason}
								</Badge>
							{/if}
							{#if detail.runInstance.sessionId}
								<a
									href={`/workspaces/${workspaceSlug}/sessions/${detail.runInstance.sessionId}`}
									class="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
									title="Open agent session"
								>
									<Bot class="h-3 w-3" />
									Session
									<ExternalLink class="h-2.5 w-2.5" />
								</a>
							{/if}
							{#if detail.runInstance.mlflowTracesUrl}
								<a
									href={detail.runInstance.mlflowTracesUrl}
									class="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
									title="Open trace"
								>
									Trace
									<ExternalLink class="h-2.5 w-2.5" />
								</a>
							{/if}
							{#if hostJobHeadlampUrl && detail.runInstance.hostJobName}
								<a
									href={hostJobHeadlampUrl}
									class="inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground"
									title="Open benchmark instance Job logs in Headlamp"
								>
									<HeadlampLogo class="h-3 w-3" />
									Job
									<span class="max-w-36 truncate font-mono">{detail.runInstance.hostJobName}</span>
									<ExternalLink class="h-2.5 w-2.5" />
								</a>
							{/if}
							{#if canTerminate}
								<Button
									variant="destructive"
									size="sm"
									class="h-6 px-2 text-[10px]"
									onclick={terminateInstance}
									disabled={terminating}
									title="Terminate this benchmark instance"
								>
									{#if terminating}
										<Loader2 class="h-3 w-3 animate-spin" />
									{:else}
										<StopCircle class="h-3 w-3" />
									{/if}
									Terminate
								</Button>
							{/if}
						</div>
					{/if}
				</div>
				<Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" onclick={close}>
					<X class="h-4 w-4" />
					<span class="sr-only">Close</span>
				</Button>
			</div>

			{#if detail}
				<!-- Metric strip -->
				{@const dur = durationMs(detail.runInstance)}
				{@const toks = tokenSum(detail.runInstance.usage)}
				{@const cost = costUsd(detail.runInstance.usage)}
				<div class="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
					<div class="rounded-md border border-border bg-muted/20 px-2.5 py-2">
						<div class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							<Repeat class="h-2.5 w-2.5" /> Turns
						</div>
						<div class="mt-0.5 text-sm font-semibold tabular-nums">
							{detail.runInstance.turnCount ?? '—'}
						</div>
					</div>
					<div class="rounded-md border border-border bg-muted/20 px-2.5 py-2">
						<div class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							<Wrench class="h-2.5 w-2.5" /> Tools
						</div>
						<div class="mt-0.5 text-sm font-semibold tabular-nums">
							{detail.runInstance.toolCallCount ?? '—'}
						</div>
					</div>
					<div class="rounded-md border border-border bg-muted/20 px-2.5 py-2">
						<div class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							<Activity class="h-2.5 w-2.5" /> TTFT
						</div>
						<div class="mt-0.5 text-sm font-semibold tabular-nums">
							{formatTtft(detail.runInstance.ttftFirstMs)}
						</div>
					</div>
					<div class="rounded-md border border-border bg-muted/20 px-2.5 py-2">
						<div class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							<Coins class="h-2.5 w-2.5" /> Tokens
						</div>
						<div class="mt-0.5 text-sm font-semibold tabular-nums">
							{toks > 0 ? formatTokens(toks) : '—'}
						</div>
					</div>
					<div class="rounded-md border border-border bg-muted/20 px-2.5 py-2">
						<div class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							<Scale class="h-2.5 w-2.5" /> Cost
						</div>
						<div class="mt-0.5 text-sm font-semibold tabular-nums">
							{formatCost(cost)}
						</div>
					</div>
					<div class="rounded-md border border-border bg-muted/20 px-2.5 py-2">
						<div class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
							<Timer class="h-2.5 w-2.5" /> Duration
						</div>
						<div class="mt-0.5 text-sm font-semibold tabular-nums">
							{dur != null ? formatDuration(dur) : '—'}
						</div>
					</div>
				</div>

				<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
					{#if detail.runInstance.startedAt}
						<span>started {formatRelative(detail.runInstance.startedAt)}</span>
					{/if}
					{#if detail.runInstance.evaluatedAt}
						<span>graded {formatRelative(detail.runInstance.evaluatedAt)}</span>
					{/if}
					{#if detail.runInstance.patchBytes}
						<span>{detail.runInstance.patchBytes} B patch</span>
					{/if}
				</div>
			{/if}
		</header>

		<!-- Body -->
		<div class="flex flex-1 flex-col overflow-hidden">
			{#if loading}
				<div class="flex flex-1 items-center justify-center">
					<Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
				</div>
			{:else if errorMessage}
				<div class="px-5 py-6">
					<Alert variant="destructive">
						<AlertDescription>{errorMessage}</AlertDescription>
					</Alert>
				</div>
			{:else if !detail}
				<div class="px-5 py-6 text-sm text-muted-foreground">No instance loaded.</div>
			{:else}
				<Tabs
					value={activeTab}
					onValueChange={(v) => (activeTab = v as TabValue)}
					class="flex flex-1 flex-col overflow-hidden"
				>
					<TabsList class="mx-5 mt-3 h-9 self-start">
						<TabsTrigger value="overview" class="text-xs">Overview</TabsTrigger>
						<TabsTrigger value="patch" class="text-xs">
							Patch
							{#if !detail.runInstance.modelPatch}
								<span class="ml-1 text-muted-foreground">—</span>
							{/if}
						</TabsTrigger>
						<TabsTrigger value="scoring" class="text-xs">Scoring</TabsTrigger>
						<TabsTrigger value="trace" class="text-xs">
							Trace
							{#if (detail.runInstance.traceIds?.length ?? 0) === 0}
								<span class="ml-1 text-muted-foreground">—</span>
							{/if}
						</TabsTrigger>
						<TabsTrigger value="harness" class="text-xs">
							Harness
							<RunStatusBadge
								status={detail.parsedHarness.failureCategory}
								class="ml-2 text-[9px] px-1"
							/>
						</TabsTrigger>
						<TabsTrigger value="logs" class="text-xs">Logs</TabsTrigger>
					</TabsList>

					<div class="flex-1 overflow-y-auto px-5 py-4">
						<!-- Overview -->
						<TabsContent value="overview" class="m-0 space-y-4">
							<section>
								<h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Problem statement
								</h3>
								{#if detail.instance.problemStatement}
									<pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-3 font-mono text-[12px] leading-relaxed">{detail.instance.problemStatement}</pre>
								{:else}
									<p class="text-sm text-muted-foreground">No problem statement available.</p>
								{/if}
							</section>

							<section class="grid gap-2 sm:grid-cols-2">
								<button
									type="button"
									class="rounded-md border border-border bg-background p-3 text-left transition-colors hover:bg-muted/40"
									onclick={() => (activeTab = 'patch')}
								>
									<div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
										<FileDiff class="h-3 w-3" /> Patch
									</div>
									<div class="mt-1 text-sm font-semibold tabular-nums">
										{#if detail.runInstance.modelPatch}
											+{detail.runInstance.patchAddedLines ?? 0} / -{detail.runInstance.patchRemovedLines ?? 0}
											<span class="ml-1 text-[11px] font-normal text-muted-foreground">
												{detail.runInstance.patchFilesTouched ?? 0} files
											</span>
										{:else}
											<span class="text-muted-foreground">No patch yet</span>
										{/if}
									</div>
								</button>
								<button
									type="button"
									class="rounded-md border border-border bg-background p-3 text-left transition-colors hover:bg-muted/40"
									onclick={() => (activeTab = 'harness')}
								>
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
										Harness
									</div>
									<div class="mt-1 flex items-center gap-2 text-sm font-semibold">
										<RunStatusBadge status={detail.parsedHarness.failureCategory} />
										<span class="text-[11px] font-normal tabular-nums text-muted-foreground">
											F2P {detail.parsedHarness.failToPass.success.length}/{detail.parsedHarness.failToPass.failure.length}
											· P2P {detail.parsedHarness.passToPass.success.length}/{detail.parsedHarness.passToPass.failure.length}
										</span>
									</div>
								</button>
								<button
									type="button"
									class="rounded-md border border-border bg-background p-3 text-left transition-colors hover:bg-muted/40"
									onclick={() => (activeTab = 'scoring')}
								>
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
										Scoring
									</div>
									<div class="mt-1 text-[11px] text-muted-foreground">
										LLM-judge scorers + verdict text
									</div>
								</button>
								<button
									type="button"
									class="rounded-md border border-border bg-background p-3 text-left transition-colors hover:bg-muted/40"
									onclick={() => (activeTab = 'trace')}
								>
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
										Trace
									</div>
									<div class="mt-1 text-sm font-semibold tabular-nums">
										{detail.runInstance.traceIds?.length ?? 0}
										<span class="ml-1 text-[11px] font-normal text-muted-foreground">
											OTEL trace{(detail.runInstance.traceIds?.length ?? 0) === 1 ? '' : 's'}
										</span>
									</div>
								</button>
							</section>

							{#if detail.runInstance.error || detail.runInstance.inferenceError || detail.runInstance.evaluationError}
								<section class="space-y-2">
									{#if detail.runInstance.inferenceError}
										<Alert variant="destructive">
											<AlertDescription>
												<strong>Inference:</strong> {detail.runInstance.inferenceError}
											</AlertDescription>
										</Alert>
									{/if}
									{#if detail.runInstance.evaluationError}
										<Alert variant="destructive">
											<AlertDescription>
												<strong>Harness:</strong> {detail.runInstance.evaluationError}
											</AlertDescription>
										</Alert>
									{:else if detail.runInstance.error}
										<Alert variant="destructive">
											<AlertDescription>{detail.runInstance.error}</AlertDescription>
										</Alert>
									{/if}
								</section>
							{/if}

							{#if detail.instance.hintsText}
								<details class="rounded-md border border-border p-3">
									<summary class="cursor-pointer text-xs font-medium uppercase tracking-wider text-muted-foreground">
										Hints
									</summary>
									<pre class="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">{detail.instance.hintsText}</pre>
								</details>
							{/if}
						</TabsContent>

						<!-- Patch -->
						<TabsContent value="patch" class="m-0 space-y-3">
							<Alert>
								<AlertDescription>
									{#if detail.postHocEvaluationArtifactsAvailable}
										Gold patch comparison is a post-hoc evaluation artifact shown after the submitted model patch is finalized.
									{:else}
										Gold patch comparison appears after official evaluation completes.
									{/if}
								</AlertDescription>
							</Alert>
							<div class="flex flex-wrap items-center justify-between gap-2">
								<div class="flex items-center gap-2 text-xs">
									<FileDiff class="h-3.5 w-3.5 text-muted-foreground" />
									<span class="font-medium">Patch comparison</span>
								</div>
								<div class="flex flex-wrap items-center gap-2">
									<div class="flex h-7 items-center gap-0.5 rounded-md border border-border p-0.5 text-[11px]">
										<button
											type="button"
											class="h-6 rounded px-2 transition-colors {patchMode === 'rendered' ? 'bg-muted' : 'hover:bg-muted/40'}"
											onclick={() => (patchMode = 'rendered')}
										>
											Rendered
										</button>
										<button
											type="button"
											class="h-6 rounded px-2 transition-colors {patchMode === 'raw' ? 'bg-muted' : 'hover:bg-muted/40'}"
											onclick={() => (patchMode = 'raw')}
										>
											Raw
										</button>
									</div>
									<div class="flex h-7 items-center gap-0.5 rounded-md border border-border p-0.5 text-[11px]">
										<button
											type="button"
											class="h-6 rounded px-2 transition-colors {patchView === 'both' ? 'bg-muted' : 'hover:bg-muted/40'}"
											onclick={() => (patchView = 'both')}
										>
											Both
										</button>
										<button
											type="button"
											class="h-6 rounded px-2 transition-colors {patchView === 'model' ? 'bg-muted' : 'hover:bg-muted/40'}"
											onclick={() => (patchView = 'model')}
										>
											Model
										</button>
										<button
											type="button"
											class="h-6 rounded px-2 transition-colors {patchView === 'gold' ? 'bg-muted' : 'hover:bg-muted/40'}"
											onclick={() => (patchView = 'gold')}
										>
											Gold
										</button>
									</div>
								</div>
							</div>

							<div class="grid gap-3 {patchView === 'both' ? 'lg:grid-cols-2' : 'grid-cols-1'}">
								{#if patchView === 'both' || patchView === 'model'}
									<div class="rounded-md border border-border bg-background">
										<div class="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5">
											<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
												Model patch
											</span>
											{#if detail.runInstance.modelPatch}
												<Button
													variant="ghost"
													size="sm"
													class="h-6 px-2 text-[10px]"
													onclick={() => copyToClipboard('model', detail!.runInstance.modelPatch ?? '')}
												>
													{#if copied === 'model'}
														<Check class="h-3 w-3 text-emerald-500" />
													{:else}
														<Copy class="h-3 w-3" />
													{/if}
												</Button>
											{/if}
										</div>
										{#if detail.runInstance.modelPatch}
											{#if patchMode === 'rendered'}
												<div class="max-h-[60vh] overflow-auto">
													<RenderedPatch
														patch={detail.runInstance.modelPatch}
														layout={patchView === 'both' ? 'line-by-line' : 'side-by-side'}
													/>
												</div>
											{:else}
												<pre class="max-h-[60vh] overflow-auto whitespace-pre p-3 font-mono text-[11px] leading-snug">{detail.runInstance.modelPatch}</pre>
											{/if}
										{:else}
											<div class="px-3 py-6 text-center text-xs text-muted-foreground">
												No patch captured yet.
											</div>
										{/if}
									</div>
								{/if}

								{#if patchView === 'both' || patchView === 'gold'}
									<div class="rounded-md border border-border bg-background">
										<div class="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-1.5">
											<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
												Gold patch
											</span>
											{#if detail.goldPatch}
												<Button
													variant="ghost"
													size="sm"
													class="h-6 px-2 text-[10px]"
													onclick={() => copyToClipboard('gold', detail!.goldPatch ?? '')}
												>
													{#if copied === 'gold'}
														<Check class="h-3 w-3 text-emerald-500" />
													{:else}
														<Copy class="h-3 w-3" />
													{/if}
												</Button>
											{/if}
										</div>
										{#if detail.goldPatch}
											{#if patchMode === 'rendered'}
												<div class="max-h-[60vh] overflow-auto">
													<RenderedPatch
														patch={detail.goldPatch}
														layout={patchView === 'both' ? 'line-by-line' : 'side-by-side'}
													/>
												</div>
											{:else}
												<pre class="max-h-[60vh] overflow-auto whitespace-pre p-3 font-mono text-[11px] leading-snug">{detail.goldPatch}</pre>
											{/if}
										{:else}
											<div class="px-3 py-6 text-center text-xs text-muted-foreground">
												No gold patch.
											</div>
										{/if}
									</div>
								{/if}
							</div>
						</TabsContent>

						<!-- Scoring (LLM-judge scorers — sourced from runInstance + scores API) -->
						<TabsContent value="scoring" class="m-0 space-y-3">
							<Alert>
								<AlertDescription>
									LLM-judge scorers run after the model patch is submitted. Scores are post-hoc artifacts and are not seen by the agent during inference.
								</AlertDescription>
							</Alert>
							{#if spansLoading}
								<div class="flex items-center gap-2 text-xs text-muted-foreground">
									<Loader2 class="h-3 w-3 animate-spin" /> Loading scoring data…
								</div>
							{:else if runId && instanceId}
								<TraceDetail
									{runId}
									{instanceId}
									llmSpans={spans?.llmSpans ?? []}
									toolSpans={spans?.toolSpans ?? []}
									traceSpans={spans?.traceSpans ?? []}
									traceCount={spans?.traceIds.length ?? 0}
									backend={spans?.backend ?? null}
									artifactPath={spans?.artifactPath ?? null}
									summary={spans?.summary ?? null}
									warnings={spans?.warnings ?? []}
									instanceMetrics={{
										turnCount: detail.runInstance.turnCount,
										toolCallCount: detail.runInstance.toolCallCount,
										ttftFirstMs: detail.runInstance.ttftFirstMs,
										ttftFirstToolMs: detail.runInstance.ttftFirstToolMs,
										usage: detail.runInstance.usage
									}}
								/>
							{/if}
						</TabsContent>

						<!-- Trace detail -->
						<TabsContent value="trace" class="m-0 space-y-3">
							{#if spansLoading}
								<div class="flex items-center gap-2 text-xs text-muted-foreground">
									<Loader2 class="h-3 w-3 animate-spin" /> Loading spans…
								</div>
							{:else if spansError}
								<Alert variant="destructive">
									<AlertDescription>
										Failed to load spans: {spansError}
									</AlertDescription>
								</Alert>
								{#if detail.runInstance.mlflowTracesUrl}
									<a
										href={detail.runInstance.mlflowTracesUrl}
										class="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-primary hover:bg-muted"
									>
										Open trace <ExternalLink class="h-3 w-3" />
									</a>
								{/if}
							{:else if spans && runId && instanceId}
								<div class="flex flex-wrap items-center justify-between gap-2">
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
										{spans.traceIds.length} trace{spans.traceIds.length === 1 ? '' : 's'} · {spans.backend ?? 'trace'} backend
									</div>
									{#if spans.mlflowTracesUrl}
										<a
											href={spans.mlflowTracesUrl}
											class="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-primary hover:bg-muted"
										>
											Open trace <ExternalLink class="h-3 w-3" />
										</a>
									{/if}
								</div>
								<TraceDetail
									{runId}
									{instanceId}
									llmSpans={spans.llmSpans}
									toolSpans={spans.toolSpans}
									traceSpans={spans.traceSpans ?? []}
									traceCount={spans.traceIds.length}
									backend={spans.backend ?? null}
									artifactPath={spans.artifactPath ?? null}
									summary={spans.summary ?? null}
									warnings={spans.warnings ?? []}
									instanceMetrics={{
										turnCount: detail.runInstance.turnCount,
										toolCallCount: detail.runInstance.toolCallCount,
										ttftFirstMs: detail.runInstance.ttftFirstMs,
										ttftFirstToolMs: detail.runInstance.ttftFirstToolMs,
										usage: detail.runInstance.usage
									}}
								/>
								{#if spans.nextCursor}
									<div class="flex justify-center pt-1">
										<Button
											variant="outline"
											size="sm"
											disabled={spansLoadingMore}
											onclick={() => loadMoreSpans(runId, instanceId)}
										>
											{#if spansLoadingMore}
												<Loader2 class="h-3.5 w-3.5 animate-spin" />
											{:else}
												<ChevronDown class="h-3.5 w-3.5" />
											{/if}
											Load more
										</Button>
									</div>
								{/if}
								{#if spansMoreError}
									<Alert variant="destructive">
										<AlertDescription>{spansMoreError}</AlertDescription>
									</Alert>
								{/if}
							{:else if (detail.runInstance.traceIds?.length ?? 0) === 0}
								<div class="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
									No trace IDs or workflow-log fallback spans are available for this instance.
								</div>
							{/if}
						</TabsContent>

						<!-- Harness -->
						<TabsContent value="harness" class="m-0 space-y-3">
							<Alert>
								<AlertDescription>
									Harness results are post-hoc SWE-bench evaluator artifacts recorded after model_patch submission; they are not sent to agent inference.
								</AlertDescription>
							</Alert>
							{#if runId && instanceId}
								<div class="flex items-center justify-end">
									<PromoteToDataset {runId} {instanceId} />
								</div>
							{/if}
							<div class="grid gap-3 sm:grid-cols-3">
								<div class="rounded-md border border-border p-3">
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
										Verdict
									</div>
									<div class="mt-1">
										<RunStatusBadge
											status={detail.parsedHarness.failureCategory}
											class="text-xs"
										/>
									</div>
								</div>
								<div class="rounded-md border border-border p-3">
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
										FAIL_TO_PASS
									</div>
									<div class="mt-1 text-sm font-semibold tabular-nums">
										<span class="text-emerald-600 dark:text-emerald-400">
											{detail.parsedHarness.failToPass.success.length}
										</span>
										<span class="text-muted-foreground">/</span>
										<span class="text-red-600 dark:text-red-400">
											{detail.parsedHarness.failToPass.failure.length}
										</span>
										<span class="ml-1 text-[10px] text-muted-foreground">pass / fail</span>
									</div>
								</div>
								<div class="rounded-md border border-border p-3">
									<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
										PASS_TO_PASS
									</div>
									<div class="mt-1 text-sm font-semibold tabular-nums">
										<span class="text-emerald-600 dark:text-emerald-400">
											{detail.parsedHarness.passToPass.success.length}
										</span>
										<span class="text-muted-foreground">/</span>
										<span class="text-red-600 dark:text-red-400">
											{detail.parsedHarness.passToPass.failure.length}
										</span>
										<span class="ml-1 text-[10px] text-muted-foreground">pass / fail</span>
									</div>
								</div>
							</div>

							<section>
								<h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
									Patch vs gold
								</h4>
								<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
									<div class="rounded-md border border-border p-3">
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Added
										</div>
										<div class="mt-1 text-sm font-semibold tabular-nums">
											<span class="text-emerald-600 dark:text-emerald-400">
												+{detail.runInstance.patchAddedLines ?? '—'}
											</span>
											<span class="ml-1 text-[10px] text-muted-foreground">
												/ +{detail.goldPatchStats.addedLines} gold
											</span>
										</div>
									</div>
									<div class="rounded-md border border-border p-3">
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Removed
										</div>
										<div class="mt-1 text-sm font-semibold tabular-nums">
											<span class="text-red-600 dark:text-red-400">
												-{detail.runInstance.patchRemovedLines ?? '—'}
											</span>
											<span class="ml-1 text-[10px] text-muted-foreground">
												/ -{detail.goldPatchStats.removedLines} gold
											</span>
										</div>
									</div>
									<div class="rounded-md border border-border p-3">
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Files touched
										</div>
										<div class="mt-1 text-sm font-semibold tabular-nums">
											{detail.runInstance.patchFilesTouched ?? '—'}
											<span class="ml-1 text-[10px] text-muted-foreground">
												{#if detail.runInstance.patchFilesOverlapGold !== null}
													({detail.runInstance.patchFilesOverlapGold} / {detail.goldPatchStats.filesTouched} overlap)
												{:else}
													/ {detail.goldPatchStats.filesTouched} gold
												{/if}
											</span>
										</div>
									</div>
									<div class="rounded-md border border-border p-3">
										<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
											Well-formed
										</div>
										<div class="mt-1 text-sm font-semibold tabular-nums">
											{#if detail.runInstance.patchWellFormed === true}
												<span class="text-emerald-600 dark:text-emerald-400">✓ yes</span>
											{:else if detail.runInstance.patchWellFormed === false}
												<span class="text-red-600 dark:text-red-400">✗ no</span>
											{:else}
												<span class="text-muted-foreground">—</span>
											{/if}
										</div>
									</div>
								</div>
							</section>

							{#if detail.parsedHarness.failToPass.failure.length > 0}
								<section>
									<h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-red-700 dark:text-red-400">
										FAIL_TO_PASS failures
									</h4>
									<ul class="max-h-32 space-y-0.5 overflow-y-auto rounded border border-border bg-muted/20 p-2">
										{#each detail.parsedHarness.failToPass.failure as t (t)}
											<li class="font-mono text-[11px]">{t}</li>
										{/each}
									</ul>
								</section>
							{/if}

							{#if detail.parsedHarness.passToPass.failure.length > 0}
								<section>
									<h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-red-700 dark:text-red-400">
										PASS_TO_PASS regressions
									</h4>
									<ul class="max-h-32 space-y-0.5 overflow-y-auto rounded border border-border bg-muted/20 p-2">
										{#each detail.parsedHarness.passToPass.failure as t (t)}
											<li class="font-mono text-[11px]">{t}</li>
										{/each}
									</ul>
								</section>
							{/if}

							{#if detail.runInstance.testOutputSummary}
								<section>
									<h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
										Test output
									</h4>
									<pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/20 p-2 font-mono text-[10px] leading-snug">{detail.runInstance.testOutputSummary}</pre>
								</section>
							{/if}
						</TabsContent>

						<!-- Logs -->
						<TabsContent value="logs" class="m-0">
							<div class="space-y-2 text-xs">
								<div>
									<span class="text-muted-foreground">Workflow execution:</span>
									<span class="ml-2 font-mono">
										{detail.runInstance.workflowExecutionId ?? 'pending'}
									</span>
								</div>
								<div>
									<span class="text-muted-foreground">Dapr instance:</span>
									<span class="ml-2 font-mono">
										{detail.runInstance.daprInstanceId ?? 'pending'}
									</span>
								</div>
								<div>
									<span class="text-muted-foreground">Sandbox:</span>
									<span class="ml-2 font-mono">
										{detail.runInstance.sandboxName ?? 'pending'}
									</span>
								</div>
								<div>
									<span class="text-muted-foreground">Workspace ref:</span>
									<span class="ml-2 break-all font-mono">
										{detail.runInstance.workspaceRef ?? 'pending'}
									</span>
								</div>
								<div>
									<span class="text-muted-foreground">Logs path:</span>
									<span class="ml-2 break-all font-mono">
										{detail.runInstance.logsPath ?? 'pending'}
									</span>
								</div>
								{#if detail.runInstance.mlflowTracesUrl}
									<div>
										<span class="text-muted-foreground">Trace:</span>
										<a
											href={detail.runInstance.mlflowTracesUrl}
											class="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
										>
											Open trace <ExternalLink class="h-3 w-3" />
										</a>
									</div>
								{/if}
								{#if detail.runInstance.traceIds && detail.runInstance.traceIds.length > 0}
									<div>
										<span class="text-muted-foreground">Trace IDs:</span>
										<ul class="mt-1 space-y-0.5">
											{#each detail.runInstance.traceIds as tid (tid)}
												<li class="break-all font-mono">{tid}</li>
											{/each}
										</ul>
									</div>
								{/if}
							</div>
						</TabsContent>
					</div>
				</Tabs>
			{/if}
		</div>
	</div>

	{#if isResizing}
		<div class="fixed inset-0 z-[60] cursor-col-resize"></div>
	{/if}
{/if}
