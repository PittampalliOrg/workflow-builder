<script lang="ts">
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Loader2,
		ChevronDown,
		ChevronRight,
		ThumbsUp,
		ThumbsDown,
		Minus,
		HelpCircle
	} from '@lucide/svelte';
	import { formatDuration, formatTokens } from './run-status-helpers';
	import type {
		ObservabilityLlmSpan,
		ObservabilityToolSpan,
		ObservabilityTraceSpan
	} from '$lib/types/observability';

	type Verdict = 'correct' | 'incorrect' | 'partial' | 'unsure';
	type AnnotationPayload = {
		mine: { verdict: Verdict; reasoning: string | null; updatedAt: string } | null;
		counts: Record<Verdict, number>;
	};

	type ScoreRow = {
		id: string;
		scorerName: string;
		scorerVersion: number;
		score: number;
		reasoning: string | null;
		metadata: Record<string, unknown> | null;
		createdAt: string;
	};

	type Props = {
		runId: string;
		instanceId: string;
		llmSpans: ObservabilityLlmSpan[];
		toolSpans: ObservabilityToolSpan[];
		traceSpans?: ObservabilityTraceSpan[];
		traceCount: number;
		backend?: string | null;
		artifactPath?: string | null;
		summary?: {
			traceCount: number;
			traceSpanCount: number;
			llmSpanCount: number;
			toolSpanCount: number;
			errorSpanCount: number;
			source: string;
		} | null;
		warnings?: string[];
		instanceMetrics: {
			turnCount: number | null;
			toolCallCount: number | null;
			ttftFirstMs: number | null;
			ttftFirstToolMs: number | null;
			usage: Record<string, unknown> | null;
		};
	};

	const {
		runId,
		instanceId,
		llmSpans,
		toolSpans,
		traceSpans = [],
		traceCount,
		backend = null,
		artifactPath = null,
		summary = null,
		warnings = [],
		instanceMetrics
	}: Props = $props();

	type WaterfallRow =
		| { kind: 'llm'; span: ObservabilityLlmSpan; offsetMs: number }
		| { kind: 'tool'; span: ObservabilityToolSpan; offsetMs: number }
		| { kind: 'raw'; span: ObservabilityTraceSpan; offsetMs: number };

	let waterfall = $derived.by<WaterfallRow[]>(() => {
		const rows: WaterfallRow[] = [];
		for (const s of llmSpans) rows.push({ kind: 'llm', span: s, offsetMs: 0 });
		for (const s of toolSpans) rows.push({ kind: 'tool', span: s, offsetMs: 0 });
		if (rows.length === 0) {
			for (const s of traceSpans) rows.push({ kind: 'raw', span: s, offsetMs: 0 });
		}
		rows.sort((a, b) => spanTimestamp(a).localeCompare(spanTimestamp(b)));
		if (rows.length === 0) return rows;
		const t0 = new Date(spanTimestamp(rows[0])).getTime();
		return rows.map((r) => ({
			...r,
			offsetMs: Number.isFinite(t0)
				? Math.max(0, new Date(spanTimestamp(r)).getTime() - t0)
				: 0
		}));
	});

	let totalSpanMs = $derived.by(() => {
		if (waterfall.length === 0) return 0;
		return Math.max(1, waterfall[waterfall.length - 1].offsetMs);
	});

	let totalCostUsd = $derived.by(() => {
		const usage = instanceMetrics.usage;
		if (usage && typeof usage === 'object') {
			const cost = (usage as { totalCostUsd?: unknown }).totalCostUsd;
			if (typeof cost === 'number' && Number.isFinite(cost)) return cost;
		}
		return null;
	});

	let totalTokens = $derived(
		llmSpans.reduce((acc, s) => acc + (s.totalTokens ?? 0), 0)
	);
	let cacheReadTokens = $derived(
		llmSpans.reduce((acc, s) => acc + (s.cacheReadInputTokens ?? 0), 0)
	);
	let cacheCreationTokens = $derived(
		llmSpans.reduce((acc, s) => acc + (s.cacheCreationInputTokens ?? 0), 0)
	);
	let reasoningTokens = $derived(
		llmSpans.reduce((acc, s) => acc + (s.reasoningTokens ?? 0), 0)
	);

	let scores = $state<ScoreRow[] | null>(null);
	let scoresLoading = $state(false);
	let scoresError = $state<string | null>(null);

	const SCORER_LABELS: Record<string, string> = {
		patch_files_overlap_gold: 'Files overlap gold',
		edit_minimality: 'Edit minimality',
		ran_tests_locally: 'Ran tests',
		reasoning_quality: 'Reasoning quality'
	};

	async function loadScores() {
		if (scores || scoresLoading) return;
		scoresLoading = true;
		scoresError = null;
		try {
			const res = await fetch(
				`/api/benchmarks/runs/${encodeURIComponent(runId)}/instances/${encodeURIComponent(instanceId)}/scores`
			);
			if (!res.ok) throw new Error(`Failed to load scores (${res.status})`);
			const body = (await res.json()) as { scores: ScoreRow[] };
			scores = body.scores ?? [];
		} catch (err) {
			scoresError = err instanceof Error ? err.message : String(err);
		} finally {
			scoresLoading = false;
		}
	}

	$effect(() => {
		void loadScores();
	});

	let expandedSpanId = $state<string | null>(null);

	// Phase K — annotation state
	let annotation = $state<AnnotationPayload | null>(null);
	let annotationLoading = $state(false);
	let annotationError = $state<string | null>(null);
	let annotationSaving = $state(false);
	let reasoningDraft = $state('');
	let pendingVerdict = $state<Verdict | null>(null);

	async function loadAnnotation() {
		annotationLoading = true;
		annotationError = null;
		try {
			const res = await fetch(
				`/api/benchmarks/runs/${encodeURIComponent(runId)}/instances/${encodeURIComponent(instanceId)}/annotations`
			);
			if (!res.ok) throw new Error(`Failed to load annotations (${res.status})`);
			const body = (await res.json()) as AnnotationPayload;
			annotation = body;
			reasoningDraft = body.mine?.reasoning ?? '';
		} catch (err) {
			annotationError = err instanceof Error ? err.message : String(err);
		} finally {
			annotationLoading = false;
		}
	}

	async function saveAnnotation(verdict: Verdict) {
		if (annotationSaving) return;
		annotationSaving = true;
		pendingVerdict = verdict;
		annotationError = null;
		try {
			const res = await fetch(
				`/api/benchmarks/runs/${encodeURIComponent(runId)}/instances/${encodeURIComponent(instanceId)}/annotations`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ verdict, reasoning: reasoningDraft.trim() || null })
				}
			);
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new Error(`Save failed (${res.status}): ${text.slice(0, 200)}`);
			}
			await loadAnnotation();
		} catch (err) {
			annotationError = err instanceof Error ? err.message : String(err);
		} finally {
			annotationSaving = false;
			pendingVerdict = null;
		}
	}

	async function clearAnnotation() {
		if (annotationSaving) return;
		annotationSaving = true;
		annotationError = null;
		try {
			const res = await fetch(
				`/api/benchmarks/runs/${encodeURIComponent(runId)}/instances/${encodeURIComponent(instanceId)}/annotations`,
				{ method: 'DELETE' }
			);
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new Error(`Clear failed (${res.status}): ${text.slice(0, 200)}`);
			}
			reasoningDraft = '';
			await loadAnnotation();
		} catch (err) {
			annotationError = err instanceof Error ? err.message : String(err);
		} finally {
			annotationSaving = false;
		}
	}

	$effect(() => {
		void loadAnnotation();
	});

	function fmtScore(v: number): string {
		if (!Number.isFinite(v)) return '—';
		return v.toFixed(2);
	}

	function scoreColor(v: number): string {
		if (v >= 0.8) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
		if (v >= 0.5) return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
		return 'bg-red-500/15 text-red-700 dark:text-red-400';
	}

	function llmSummary(s: ObservabilityLlmSpan): string {
		const parts: string[] = [];
		parts.push(s.modelName ?? 'model');
		if (s.promptTokens !== null && s.completionTokens !== null) {
			parts.push(`${formatTokens(s.promptTokens)} in / ${formatTokens(s.completionTokens)} out`);
		}
		if (s.cacheReadInputTokens) parts.push(`${formatTokens(s.cacheReadInputTokens)} cache-read`);
		if (s.cacheCreationInputTokens) parts.push(`${formatTokens(s.cacheCreationInputTokens)} cache-write`);
		if (s.reasoningTokens) parts.push(`${formatTokens(s.reasoningTokens)} reasoning`);
		if (s.finishReason) parts.push(s.finishReason);
		return parts.join(' · ');
	}

	function toolSummary(s: ObservabilityToolSpan): string {
		return s.toolName || '(unknown tool)';
	}

	function rawSummary(s: ObservabilityTraceSpan): string {
		return `${s.serviceName || 'service'} · ${s.operationName || '(span)'}`;
	}

	function spanTimestamp(row: WaterfallRow): string {
		return row.kind === 'raw' ? row.span.startTime : row.span.timestamp;
	}

	function rowStatusCode(row: WaterfallRow): string | undefined {
		return row.span.statusCode;
	}

	function previewText(value: unknown, max = 800): string {
		if (value === null || value === undefined) return '';
		if (typeof value === 'string') return value.length > max ? value.slice(0, max) + '…' : value;
		try {
			const json = JSON.stringify(value, null, 2);
			return json.length > max ? json.slice(0, max) + '…' : json;
		} catch {
			return String(value);
		}
	}

	function lastInputMessage(s: ObservabilityLlmSpan): string {
		const last = s.inputMessages.at(-1);
		if (!last) return '(no input)';
		return previewText(last.content ?? last);
	}

	function firstOutputMessage(s: ObservabilityLlmSpan): string {
		const first = s.outputMessages[0];
		if (!first) return '(no output)';
		if (first.content) return previewText(first.content);
		if (first.toolCalls && first.toolCalls.length > 0) {
			const fn = first.toolCalls[0].function?.name ?? '(tool)';
			return `→ tool_use: ${fn}`;
		}
		return previewText(first);
	}

	function offsetLabel(ms: number): string {
		if (ms < 1) return '0ms';
		if (ms < 1000) return `${ms.toFixed(0)}ms`;
		const sec = ms / 1000;
		if (sec < 60) return `${sec.toFixed(1)}s`;
		const m = Math.floor(sec / 60);
		const s = Math.floor(sec % 60);
		return `${m}m${s}s`;
	}

	function offsetPct(ms: number): number {
		if (totalSpanMs <= 0) return 0;
		return Math.min(100, (ms / totalSpanMs) * 100);
	}

	function relevantScoresFor(_kind: 'llm' | 'tool' | 'raw', _spanId: string): ScoreRow[] {
		// Scorers are instance-level today (not per-span). When we add span-level
		// scorers in the future, this will filter by spanId or evidence.
		return [];
	}
</script>

<div class="space-y-4">
	<!-- Header strip -->
	<div class="grid gap-2 sm:grid-cols-4">
		<div class="rounded-md border border-border bg-background p-3">
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Turns</div>
			<div class="mt-1 text-lg font-semibold tabular-nums">
				{instanceMetrics.turnCount ?? '—'}
			</div>
		</div>
		<div class="rounded-md border border-border bg-background p-3">
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Tool calls</div>
			<div class="mt-1 text-lg font-semibold tabular-nums">
				{instanceMetrics.toolCallCount ?? toolSpans.length}
			</div>
		</div>
		<div class="rounded-md border border-border bg-background p-3">
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">TTFT</div>
			<div class="mt-1 text-lg font-semibold tabular-nums">
				{formatDuration(instanceMetrics.ttftFirstMs)}
			</div>
		</div>
		<div class="rounded-md border border-border bg-background p-3">
			<div class="text-[10px] uppercase tracking-wider text-muted-foreground">Tokens</div>
			<div class="mt-1 text-lg font-semibold tabular-nums">{formatTokens(totalTokens)}</div>
			{#if cacheReadTokens || cacheCreationTokens || reasoningTokens}
				<div class="mt-0.5 text-[10px] text-muted-foreground">
					{#if cacheReadTokens}{formatTokens(cacheReadTokens)} cache-read{/if}
					{#if cacheCreationTokens}{cacheReadTokens ? ' / ' : ''}{formatTokens(cacheCreationTokens)} cache-write{/if}
					{#if reasoningTokens}{cacheReadTokens || cacheCreationTokens ? ' / ' : ''}{formatTokens(reasoningTokens)} reasoning{/if}
				</div>
			{/if}
			{#if totalCostUsd !== null}
				<div class="mt-0.5 text-[10px] text-muted-foreground">${totalCostUsd.toFixed(2)}</div>
			{/if}
		</div>
	</div>

	<div class="rounded-md border border-border bg-background px-3 py-2">
		<div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
			<Badge class="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[10px]">
				{backend === 'mlflow_artifact' ? 'artifact' : backend ?? 'trace'}
			</Badge>
			{#if artifactPath}
				<code class="break-all font-mono text-[10px]">{artifactPath}</code>
			{/if}
			{#if summary}
				<span class="tabular-nums">
					{summary.traceSpanCount} raw · {summary.llmSpanCount} llm · {summary.toolSpanCount} tool
				</span>
			{/if}
		</div>
		{#if warnings.length > 0}
			<div class="mt-2 space-y-1">
				{#each warnings as warning}
					<div class="rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-300">
						{warning}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Scorers panel -->
	<section class="rounded-md border border-border">
		<div
			class="flex items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5"
		>
			<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				Scorers
			</span>
			{#if scores}
				<span class="text-[10px] text-muted-foreground">
					{scores.length} scored
				</span>
			{/if}
		</div>
		{#if scoresLoading}
			<div class="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
				<Loader2 class="h-3 w-3 animate-spin" /> Loading scorers…
			</div>
		{:else if scoresError}
			<div class="px-3 py-2">
				<Alert variant="destructive">
					<AlertDescription>{scoresError}</AlertDescription>
				</Alert>
			</div>
		{:else if !scores || scores.length === 0}
			<div class="px-3 py-3 text-xs text-muted-foreground">
				No scorer rows yet. Scorers run after the harness completes; check back after run is done.
			</div>
		{:else}
			<ul class="divide-y divide-border">
				{#each scores as s (s.id)}
					<li class="flex items-start gap-3 px-3 py-2">
						<Badge class="text-[10px] {scoreColor(s.score)}">
							{fmtScore(s.score)}
						</Badge>
						<div class="min-w-0 flex-1">
							<div class="text-xs font-medium">
								{SCORER_LABELS[s.scorerName] ?? s.scorerName}
								<span class="ml-1 text-[10px] font-normal text-muted-foreground">
									v{s.scorerVersion}
								</span>
							</div>
							{#if s.reasoning}
								<div class="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
									{s.reasoning}
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Trace waterfall -->
	<section class="rounded-md border border-border">
		<div
			class="flex items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5"
		>
			<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				Trace ({waterfall.length} spans, {traceCount} trace{traceCount === 1 ? '' : 's'})
			</span>
			<span class="text-[10px] text-muted-foreground">total {offsetLabel(totalSpanMs)}</span>
		</div>
		{#if waterfall.length === 0}
			<div class="px-3 py-6 text-center text-xs text-muted-foreground">
				No spans recorded for this instance.
			</div>
		{:else}
			<ul class="divide-y divide-border">
				{#each waterfall as row, i (row.span.spanId)}
					{@const isOpen = expandedSpanId === row.span.spanId}
					{@const pct = offsetPct(row.offsetMs)}
					<li>
						<button
							type="button"
							class="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/30"
							onclick={() =>
								(expandedSpanId = isOpen ? null : row.span.spanId)}
						>
							<span class="mt-0.5 w-6 text-[10px] tabular-nums text-muted-foreground">
								#{i + 1}
							</span>
							<span class="mt-0.5">
								{#if isOpen}
									<ChevronDown class="h-3 w-3 text-muted-foreground" />
								{:else}
									<ChevronRight class="h-3 w-3 text-muted-foreground" />
								{/if}
							</span>
							<span class="w-16 mt-0.5 text-[10px] tabular-nums text-muted-foreground">
								+{offsetLabel(row.offsetMs)}
							</span>
							<span class="min-w-0 flex-1">
								<span class="flex items-center gap-1.5">
									{#if row.kind === 'llm'}
										<Badge
											class="bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 text-[10px]"
										>
											llm
										</Badge>
									{:else if row.kind === 'tool'}
										<Badge
											class="bg-cyan-500/15 text-cyan-700 dark:text-cyan-400 text-[10px]"
										>
											tool
										</Badge>
									{:else}
										<Badge
											class="bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 text-[10px]"
										>
											raw
										</Badge>
									{/if}
									<span class="truncate text-xs">
										{#if row.kind === 'llm'}
											{llmSummary(row.span)}
										{:else if row.kind === 'tool'}
											{toolSummary(row.span)}
										{:else}
											{rawSummary(row.span)}
										{/if}
									</span>
									{#if rowStatusCode(row) && rowStatusCode(row) !== 'OK' && rowStatusCode(row) !== 'STATUS_CODE_OK'}
										<span class="text-[10px] text-red-600 dark:text-red-400">
											{rowStatusCode(row)}
										</span>
									{/if}
								</span>
								<span
									class="mt-1 block h-1 overflow-hidden rounded bg-muted"
									aria-hidden="true"
								>
									<span
										class="block h-full {row.kind === 'llm'
											? 'bg-indigo-500/60'
											: row.kind === 'tool'
												? 'bg-cyan-500/60'
												: 'bg-zinc-500/60'}"
										style="margin-left: {pct}%; width: 4px;"
									></span>
								</span>
							</span>
						</button>
						{#if isOpen}
							<div class="space-y-2 border-t border-border bg-muted/10 px-9 py-2">
								{#if row.kind === 'llm'}
									<div>
										<div
											class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground"
										>
											Last input message
										</div>
										<pre class="whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">{lastInputMessage(
												row.span
											)}</pre>
									</div>
									<div>
										<div
											class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground"
										>
											First output message
										</div>
										<pre class="whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">{firstOutputMessage(
												row.span
											)}</pre>
									</div>
									{#if row.span.invocationParameters}
										<details class="rounded border border-border bg-background p-2">
											<summary
												class="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground"
											>
												Invocation parameters
											</summary>
											<pre class="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{previewText(
													row.span.invocationParameters,
													2000
												)}</pre>
										</details>
									{/if}
								{:else if row.kind === 'tool'}
									<div>
										<div
											class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground"
										>
											Tool arguments
										</div>
										<pre class="whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">{previewText(
												row.span.toolArguments,
												1500
											)}</pre>
									</div>
									<div>
										<div
											class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground"
										>
											Tool result
										</div>
										<pre class="whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">{previewText(
												row.span.toolResult,
												1500
											)}</pre>
									</div>
								{:else}
									<div>
										<div
											class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground"
										>
											Raw span attributes
										</div>
										<pre class="whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">{previewText(
												row.span.attributes ?? {},
												2000
											)}</pre>
									</div>
									{#if row.span.statusMessage}
										<div>
											<div
												class="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground"
											>
												Status message
											</div>
											<pre class="whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground">{row.span.statusMessage}</pre>
										</div>
									{/if}
								{/if}
								{#each relevantScoresFor(row.kind, row.span.spanId) as score (score.id)}
									<div class="flex items-center gap-2 text-[11px]">
										<Badge class="text-[10px] {scoreColor(score.score)}">
											{fmtScore(score.score)}
										</Badge>
										<span>
											{SCORER_LABELS[score.scorerName] ?? score.scorerName}
										</span>
									</div>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Annotation footer (Phase K) -->
	<section class="rounded-md border border-border bg-background">
		<div
			class="flex items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5"
		>
			<span class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				Human annotation
			</span>
			{#if annotation}
				{@const total =
					annotation.counts.correct +
					annotation.counts.incorrect +
					annotation.counts.partial +
					annotation.counts.unsure}
				{#if total > 0}
					<span class="text-[10px] text-muted-foreground">
						{total} verdict{total === 1 ? '' : 's'} from team
					</span>
				{/if}
			{/if}
		</div>
		<div class="space-y-2 px-3 py-2">
			{#if annotationLoading}
				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Loader2 class="h-3 w-3 animate-spin" /> Loading annotation…
				</div>
			{:else}
				{@const mine = annotation?.mine ?? null}
				{@const counts = annotation?.counts ?? {
					correct: 0,
					incorrect: 0,
					partial: 0,
					unsure: 0
				}}
				<div class="flex flex-wrap items-center gap-1.5">
					<Button
						type="button"
						size="sm"
						variant={mine?.verdict === 'correct' ? 'default' : 'outline'}
						class="h-7 gap-1.5 text-[11px]"
						disabled={annotationSaving}
						onclick={() => saveAnnotation('correct')}
					>
						{#if pendingVerdict === 'correct' && annotationSaving}
							<Loader2 class="h-3 w-3 animate-spin" />
						{:else}
							<ThumbsUp class="h-3 w-3" />
						{/if}
						Correct ({counts.correct})
					</Button>
					<Button
						type="button"
						size="sm"
						variant={mine?.verdict === 'incorrect' ? 'default' : 'outline'}
						class="h-7 gap-1.5 text-[11px]"
						disabled={annotationSaving}
						onclick={() => saveAnnotation('incorrect')}
					>
						{#if pendingVerdict === 'incorrect' && annotationSaving}
							<Loader2 class="h-3 w-3 animate-spin" />
						{:else}
							<ThumbsDown class="h-3 w-3" />
						{/if}
						Incorrect ({counts.incorrect})
					</Button>
					<Button
						type="button"
						size="sm"
						variant={mine?.verdict === 'partial' ? 'default' : 'outline'}
						class="h-7 gap-1.5 text-[11px]"
						disabled={annotationSaving}
						onclick={() => saveAnnotation('partial')}
					>
						{#if pendingVerdict === 'partial' && annotationSaving}
							<Loader2 class="h-3 w-3 animate-spin" />
						{:else}
							<Minus class="h-3 w-3" />
						{/if}
						Partial ({counts.partial})
					</Button>
					<Button
						type="button"
						size="sm"
						variant={mine?.verdict === 'unsure' ? 'default' : 'outline'}
						class="h-7 gap-1.5 text-[11px]"
						disabled={annotationSaving}
						onclick={() => saveAnnotation('unsure')}
					>
						{#if pendingVerdict === 'unsure' && annotationSaving}
							<Loader2 class="h-3 w-3 animate-spin" />
						{:else}
							<HelpCircle class="h-3 w-3" />
						{/if}
						Unsure ({counts.unsure})
					</Button>
					{#if mine}
						<Button
							type="button"
							size="sm"
							variant="ghost"
							class="ml-auto h-7 text-[11px] text-muted-foreground"
							disabled={annotationSaving}
							onclick={() => clearAnnotation()}
						>
							Clear my verdict
						</Button>
					{/if}
				</div>
				<Textarea
					placeholder="Reasoning (optional)… stays attached to your verdict"
					rows={2}
					bind:value={reasoningDraft}
					class="text-[11px]"
					disabled={annotationSaving}
				/>
				{#if mine}
					<div class="text-[10px] text-muted-foreground">
						Your verdict: <span class="font-medium">{mine.verdict}</span>
						· last updated {new Date(mine.updatedAt).toLocaleString()}
					</div>
				{:else}
					<div class="text-[10px] text-muted-foreground">
						No verdict from you yet. Click a button above to record one.
					</div>
				{/if}
				{#if annotationError}
					<Alert variant="destructive">
						<AlertDescription>{annotationError}</AlertDescription>
					</Alert>
				{/if}
			{/if}
		</div>
	</section>
</div>
