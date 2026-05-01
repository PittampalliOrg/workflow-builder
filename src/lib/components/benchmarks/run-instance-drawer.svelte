<script lang="ts">
	import * as Sheet from '$lib/components/ui/sheet';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Tabs, TabsList, TabsTrigger, TabsContent } from '$lib/components/ui/tabs';
	import { Bot, Check, Copy, ExternalLink, FileDiff, Loader2 } from '@lucide/svelte';
	import PromoteToDataset from './promote-to-dataset.svelte';
	import RenderedPatch from './rendered-patch.svelte';
	import RunStatusBadge from './run-status-badge.svelte';
	import SpansTimeline from './spans-timeline.svelte';
	import TraceDetail from './trace-detail.svelte';
	import {
		formatDuration,
		formatRelative,
		formatTokens
	} from './run-status-helpers';
	import type { ParsedHarnessResult } from '$lib/server/benchmarks/harness-result';
	import type {
		ObservabilityLlmSpan,
		ObservabilityToolSpan
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
			mlflowRunId: string | null;
			mlflowUrl: string | null;
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
		onOpenChange: (next: boolean) => void;
	};

	let {
		open = $bindable(false),
		runId,
		instanceId,
		workspaceSlug,
		onOpenChange
	}: Props = $props();

	type SpansPayload = {
		traceIds: string[];
		llmSpans: ObservabilityLlmSpan[];
		toolSpans: ObservabilityToolSpan[];
		error?: string;
	};

	let detail = $state<DrilldownPayload | null>(null);
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);
	let activeTab = $state<'problem' | 'patch' | 'harness' | 'trace' | 'spans' | 'logs'>(
		'problem'
	);
	let patchView = $state<'model' | 'gold' | 'both'>('both');
	let patchMode = $state<'rendered' | 'raw'>('rendered');
	let copied = $state<string | null>(null);
	let spans = $state<SpansPayload | null>(null);
	let spansLoading = $state(false);
	let spansError = $state<string | null>(null);

	$effect(() => {
		if (!open || !runId || !instanceId) {
			return;
		}
		void load(runId, instanceId);
	});

	async function load(rid: string, iid: string) {
		loading = true;
		errorMessage = null;
		detail = null;
		spans = null;
		spansError = null;
		try {
			const res = await fetch(
				`/api/benchmarks/runs/${encodeURIComponent(rid)}/instances/${encodeURIComponent(iid)}`
			);
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			detail = (await res.json()) as DrilldownPayload;
			activeTab = 'problem';
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

	$effect(() => {
		if ((activeTab === 'spans' || activeTab === 'trace') && runId && instanceId) {
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

	function durationMs(ri: DrilldownPayload['runInstance']): number | null {
		if (ri.startedAt && ri.inferenceCompletedAt) {
			const a = new Date(ri.startedAt).getTime();
			const b = new Date(ri.inferenceCompletedAt).getTime();
			if (Number.isFinite(a) && Number.isFinite(b) && b >= a) return b - a;
		}
		return null;
	}
</script>

<Sheet.Root {open} {onOpenChange}>
	<Sheet.Content side="right" class="w-full sm:max-w-3xl flex flex-col">
		<Sheet.Header class="space-y-2">
			<div class="flex items-center justify-between gap-3">
				<Sheet.Title class="break-all font-mono text-sm">
					{instanceId ?? '—'}
				</Sheet.Title>
				{#if detail}
					<div class="flex items-center gap-1.5">
						<RunStatusBadge status={detail.runInstance.status} />
						{#if detail.runInstance.sessionId}
							<a
								href={`/workspaces/${workspaceSlug}/sessions/${detail.runInstance.sessionId}`}
								class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
								title="Open agent session"
							>
								<Bot class="h-3 w-3" />
								<span>Session</span>
								<ExternalLink class="h-3 w-3" />
							</a>
						{/if}
					</div>
				{/if}
			</div>
			<Sheet.Description class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
				{#if detail}
					{#if detail.instance.repo}
						<span class="font-mono">{detail.instance.repo}</span>
					{/if}
					{#if detail.runInstance.startedAt}
						<span>started {formatRelative(detail.runInstance.startedAt)}</span>
					{/if}
					{#if detail.runInstance.evaluatedAt}
						<span>graded {formatRelative(detail.runInstance.evaluatedAt)}</span>
					{/if}
					{@const dur = durationMs(detail.runInstance)}
					{#if dur != null}
						<span>{formatDuration(dur)}</span>
					{/if}
					{@const toks = tokenSum(detail.runInstance.usage)}
					{#if toks > 0}
						<span>{formatTokens(toks)} tokens</span>
					{/if}
					{#if detail.runInstance.patchBytes}
						<span>{detail.runInstance.patchBytes} B patch</span>
					{/if}
					{#if detail.runInstance.turnCount !== null}
						<Badge variant="secondary" class="font-normal">
							{detail.runInstance.turnCount} turn{detail.runInstance.turnCount === 1 ? '' : 's'}
						</Badge>
					{/if}
					{#if detail.runInstance.terminationReason}
						<Badge variant="outline" class="font-normal">
							{detail.runInstance.terminationReason}
						</Badge>
					{/if}
				{/if}
			</Sheet.Description>
		</Sheet.Header>

		<div class="flex flex-1 flex-col overflow-hidden">
			{#if loading}
				<div class="flex flex-1 items-center justify-center">
					<Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
				</div>
			{:else if errorMessage}
				<div class="px-4 py-6">
					<Alert variant="destructive">
						<AlertDescription>{errorMessage}</AlertDescription>
					</Alert>
				</div>
			{:else if !detail}
				<div class="px-4 py-6 text-sm text-muted-foreground">No instance loaded.</div>
			{:else}
				<Tabs
					value={activeTab}
					onValueChange={(v) => (activeTab = v as typeof activeTab)}
					class="flex flex-1 flex-col overflow-hidden"
				>
					<TabsList class="mx-4 mt-2 h-9">
						<TabsTrigger value="problem" class="text-xs">Problem</TabsTrigger>
						<TabsTrigger value="patch" class="text-xs">
							Patch
							{#if !detail.runInstance.modelPatch}
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
						<TabsTrigger value="trace" class="text-xs">
							Trace
							{#if (detail.runInstance.traceIds?.length ?? 0) === 0}
								<span class="ml-1 text-muted-foreground">—</span>
							{/if}
						</TabsTrigger>
						<TabsTrigger value="spans" class="text-xs">
							Spans
							{#if (detail.runInstance.traceIds?.length ?? 0) === 0}
								<span class="ml-1 text-muted-foreground">—</span>
							{/if}
						</TabsTrigger>
						<TabsTrigger value="logs" class="text-xs">Logs</TabsTrigger>
					</TabsList>

					<div class="flex-1 overflow-y-auto px-4 py-3">
						<TabsContent value="problem" class="m-0">
							{#if detail.instance.problemStatement}
								<pre class="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-foreground">{detail.instance.problemStatement}</pre>
							{:else}
								<p class="text-sm text-muted-foreground">No problem statement available.</p>
							{/if}
							{#if detail.instance.hintsText}
								<details class="mt-4 rounded-md border border-border p-3">
									<summary class="cursor-pointer text-xs font-medium uppercase tracking-wider text-muted-foreground">
										Hints
									</summary>
									<pre class="mt-2 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">{detail.instance.hintsText}</pre>
								</details>
							{/if}
						</TabsContent>

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

							<div
								class="grid gap-3 {patchView === 'both' ? 'lg:grid-cols-2' : 'grid-cols-1'}"
							>
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
										<span class="ml-1 text-[10px] text-muted-foreground">
											pass / fail
										</span>
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
										<span class="ml-1 text-[10px] text-muted-foreground">
											pass / fail
										</span>
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
									<ul class="space-y-0.5 rounded border border-border bg-muted/20 p-2 max-h-32 overflow-y-auto">
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
									<ul class="space-y-0.5 rounded border border-border bg-muted/20 p-2 max-h-32 overflow-y-auto">
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
						</TabsContent>

						<TabsContent value="trace" class="m-0 space-y-3">
							{#if spansLoading}
								<div class="flex items-center gap-2 text-xs text-muted-foreground">
									<Loader2 class="h-3 w-3 animate-spin" /> Loading trace…
								</div>
							{:else if spansError}
								<Alert variant="destructive">
									<AlertDescription>{spansError}</AlertDescription>
								</Alert>
							{:else if !spans || (detail.runInstance.traceIds?.length ?? 0) === 0}
								<div class="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
									No trace IDs recorded for this instance. The runtime may have completed
									before OTel spans propagated, or this run predates OTel instrumentation.
								</div>
							{:else if runId && instanceId}
								<TraceDetail
									{runId}
									{instanceId}
									llmSpans={spans.llmSpans}
									toolSpans={spans.toolSpans}
									traceCount={spans.traceIds.length}
									instanceMetrics={{
										turnCount: detail.runInstance.turnCount,
										toolCallCount: detail.runInstance.toolCallCount,
										ttftFirstMs: detail.runInstance.ttftFirstMs,
										ttftFirstToolMs: detail.runInstance.ttftFirstToolMs,
										usage: detail.runInstance.usage
									}}
								/>
								{#if spans.error}
									<Alert variant="destructive">
										<AlertDescription>
											ClickHouse query partially failed: {spans.error}
										</AlertDescription>
									</Alert>
								{/if}
							{/if}
						</TabsContent>

						<TabsContent value="spans" class="m-0 space-y-3">
							{#if spansLoading}
								<div class="flex items-center gap-2 text-xs text-muted-foreground">
									<Loader2 class="h-3 w-3 animate-spin" /> Loading spans…
								</div>
							{:else if spansError}
								<Alert variant="destructive">
									<AlertDescription>{spansError}</AlertDescription>
								</Alert>
							{:else if !spans || (detail.runInstance.traceIds?.length ?? 0) === 0}
								<div class="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
									No trace IDs recorded for this instance. The runtime may have completed
									before OTel spans propagated, or this run predates OTel instrumentation.
								</div>
							{:else}
								<div class="text-[10px] uppercase tracking-wider text-muted-foreground">
									{spans.traceIds.length} trace{spans.traceIds.length === 1 ? '' : 's'}
								</div>
								<SpansTimeline llmSpans={spans.llmSpans} toolSpans={spans.toolSpans} />
								{#if spans.error}
									<Alert variant="destructive">
										<AlertDescription>
											ClickHouse query partially failed: {spans.error}
										</AlertDescription>
									</Alert>
								{/if}
							{/if}
						</TabsContent>

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
								{#if detail.runInstance.mlflowUrl}
									<div>
										<span class="text-muted-foreground">MLflow:</span>
										<a
											href={detail.runInstance.mlflowUrl}
											target="_blank"
											rel="noopener noreferrer"
											class="ml-2 inline-flex items-center gap-1 break-all text-primary hover:underline"
										>
											<span class="font-mono">{detail.runInstance.mlflowRunId}</span>
											<ExternalLink class="h-3 w-3" />
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
	</Sheet.Content>
</Sheet.Root>
