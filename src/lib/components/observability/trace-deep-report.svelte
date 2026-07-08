<script lang="ts">
	/**
	 * The deep-analysis quality report, readable at human scale: health gauge +
	 * executive summary, findings grouped by lens with severity chips and
	 * evidence, and IMPROVEMENTS as action cards — a `script` improvement shows
	 * its complete revised script and an Apply button; applying requires an
	 * explicit confirmation (diffable script preview) and then PUTs the target
	 * workflow (server-side evaluator validation runs on save).
	 */
	import {
		X,
		Gauge,
		Timer,
		Coins,
		ShieldCheck,
		Award,
		Sparkles,
		Check,
		Loader2,
		ExternalLink
	} from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { toast } from 'svelte-sonner';
	import type {
		TraceAnalysisImprovement,
		TraceAnalysisLens,
		TraceAnalysisReport
	} from '$lib/types/trace-analysis';

	let {
		report,
		targetWorkflowId,
		targetWorkflowName,
		slug,
		onClose
	}: {
		report: TraceAnalysisReport;
		targetWorkflowId: string | null;
		targetWorkflowName: string | null;
		slug: string;
		onClose: () => void;
	} = $props();

	const LENS_META: Record<TraceAnalysisLens, { label: string; Icon: typeof Timer; hue: string }> = {
		performance: { label: 'Performance', Icon: Timer, hue: 'text-sky-300' },
		cost: { label: 'Cost', Icon: Coins, hue: 'text-amber-300' },
		reliability: { label: 'Reliability', Icon: ShieldCheck, hue: 'text-teal-300' },
		quality: { label: 'Quality', Icon: Award, hue: 'text-fuchsia-300' }
	};

	function sevTone(sev: string): string {
		if (sev === 'high') return 'border-destructive/40 bg-destructive/10 text-destructive';
		if (sev === 'medium') return 'border-amber-400/40 bg-amber-500/10 text-amber-300';
		if (sev === 'low') return 'border-sky-400/40 bg-sky-500/10 text-sky-300';
		return 'border-border bg-muted/40 text-muted-foreground';
	}

	function healthTone(score: number): string {
		if (score >= 80) return 'text-emerald-400';
		if (score >= 55) return 'text-amber-300';
		return 'text-destructive';
	}

	// ── Apply flow: explicit confirmation, then PUT the revised script ──────
	let confirming = $state<TraceAnalysisImprovement | null>(null);
	let applying = $state(false);
	let appliedTitles = $state<string[]>([]);

	async function applyImprovement(improvement: TraceAnalysisImprovement) {
		if (!targetWorkflowId || !improvement.revisedScript) return;
		applying = true;
		try {
			const res = await fetch(`/api/workflows/${encodeURIComponent(targetWorkflowId)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: targetWorkflowName ?? undefined,
					engineType: 'dynamic-script',
					spec: { engine: 'dynamic-script', script: improvement.revisedScript, meta: {} }
				})
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				toast.error('Apply failed', {
					description: body.message || `Validation rejected the revised script (${res.status})`
				});
				return;
			}
			appliedTitles = [...appliedTitles, improvement.title];
			toast.success('Improvement applied', {
				description: `${targetWorkflowName ?? 'Workflow'} updated — run it again to compare.`
			});
			confirming = null;
		} catch (err) {
			toast.error('Apply failed', {
				description: err instanceof Error ? err.message : 'Network error'
			});
		} finally {
			applying = false;
		}
	}

	const R = 26;
	const CIRC = 2 * Math.PI * R;
	const score = $derived(Math.max(0, Math.min(100, report.healthScore)));
</script>

<div class="flex h-full min-h-0 flex-col">
	<!-- Header: health gauge + summary -->
	<div class="flex items-start gap-4 border-b bg-card/50 p-4">
		<div class="relative flex shrink-0 flex-col items-center">
			<svg width="72" height="72" viewBox="0 0 64 64" class="-rotate-90">
				<circle cx="32" cy="32" r={R} fill="none" stroke="currentColor" class="text-muted/40" stroke-width="6" />
				<circle
					cx="32"
					cy="32"
					r={R}
					fill="none"
					stroke="currentColor"
					class={healthTone(score)}
					stroke-width="6"
					stroke-linecap="round"
					stroke-dasharray={CIRC}
					stroke-dashoffset={CIRC * (1 - score / 100)}
				/>
			</svg>
			<div class="absolute inset-0 flex flex-col items-center justify-center">
				<span class="text-lg font-bold tabular-nums {healthTone(score)}">{score}</span>
				<span class="text-[8px] uppercase tracking-wider text-muted-foreground">health</span>
			</div>
		</div>
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-2">
				<Gauge class="size-4 text-primary" />
				<h2 class="text-sm font-semibold">Deep analysis</h2>
				{#if targetWorkflowName}
					<span class="text-xs text-muted-foreground">· {targetWorkflowName}</span>
				{/if}
			</div>
			<p class="mt-1.5 text-[13px] leading-relaxed text-foreground/90">{report.summary}</p>
		</div>
		<button class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onclick={onClose} title="Close report">
			<X class="size-4" />
		</button>
	</div>

	<div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
		<!-- Findings by lens -->
		{#each Object.entries(LENS_META) as [lens, meta] (lens)}
			{@const rows = report.findings.filter((f) => f.lens === lens)}
			{#if rows.length > 0}
				<section>
					<h3 class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide {meta.hue}">
						<meta.Icon class="size-3.5" />
						{meta.label}
					</h3>
					<div class="space-y-2">
						{#each rows as finding, i (i)}
							<div class="rounded-lg border border-border/70 bg-card/40 p-3">
								<div class="flex items-center gap-2">
									<span class="rounded-full border px-1.5 py-0 text-[10px] font-medium uppercase {sevTone(finding.severity)}">
										{finding.severity}
									</span>
									<span class="text-[13px] font-medium">{finding.title}</span>
								</div>
								<p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">{finding.detail}</p>
								{#if finding.evidence.length > 0}
									<div class="mt-2 flex flex-wrap gap-1">
										{#each finding.evidence as ev, j (j)}
											<span class="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{ev}</span>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				</section>
			{/if}
		{/each}

		<!-- Improvements -->
		{#if report.improvements.length > 0}
			<section>
				<h3 class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
					<Sparkles class="size-3.5" /> Improvements
				</h3>
				<div class="space-y-2.5">
					{#each report.improvements as improvement, i (i)}
						{@const applied = appliedTitles.includes(improvement.title)}
						<div class="rounded-lg border border-primary/25 bg-primary/[0.03] p-3">
							<div class="flex items-start gap-2">
								<span
									class="mt-0.5 rounded-full border px-1.5 py-0 text-[10px] font-medium uppercase
										{improvement.impact === 'high'
										? 'border-primary/50 bg-primary/15 text-primary'
										: 'border-border bg-muted/40 text-muted-foreground'}"
								>
									{improvement.impact}
								</span>
								<div class="min-w-0 flex-1">
									<div class="text-[13px] font-medium">{improvement.title}</div>
									<p class="mt-1 text-xs leading-relaxed text-muted-foreground">{improvement.rationale}</p>
								</div>
								{#if improvement.kind === 'script' && improvement.revisedScript && targetWorkflowId}
									{#if applied}
										<span class="inline-flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-300">
											<Check class="size-3" /> Applied
										</span>
									{:else}
										<Button
											size="sm"
											class="h-7 shrink-0 gap-1 text-xs"
											onclick={() => (confirming = improvement)}
										>
											<Sparkles class="size-3" /> Apply…
										</Button>
									{/if}
								{:else}
									<span class="shrink-0 rounded bg-muted/50 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
										{improvement.kind}
									</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
				{#if appliedTitles.length > 0 && targetWorkflowId}
					<a
						href={`/workspaces/${slug}/workflows/${targetWorkflowId}`}
						class="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline"
					>
						<ExternalLink class="size-3" /> Open {targetWorkflowName ?? 'workflow'} to review + run again
					</a>
				{/if}
			</section>
		{/if}
	</div>
</div>

<!-- Apply confirmation: the user SEES the complete revised script before anything runs. -->
{#if confirming}
	<div class="absolute inset-0 z-30 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
		<div class="flex max-h-full w-full max-w-2xl flex-col rounded-lg border bg-card shadow-xl">
			<div class="flex items-center gap-2 border-b px-4 py-2.5">
				<Sparkles class="size-4 text-primary" />
				<span class="text-sm font-semibold">Apply: {confirming.title}</span>
				<button
					class="ml-auto rounded p-1 text-muted-foreground hover:bg-accent"
					onclick={() => (confirming = null)}
					title="Cancel"
				>
					<X class="size-4" />
				</button>
			</div>
			<p class="border-b px-4 py-2 text-xs text-muted-foreground">
				This replaces the script of <span class="font-medium text-foreground">{targetWorkflowName ?? 'the workflow'}</span>
				— the platform validates it before saving, and the previous version stays in history. Review the complete revised script:
			</p>
			<pre class="min-h-0 flex-1 overflow-auto bg-muted/30 p-4 font-mono text-[11px] leading-relaxed">{confirming.revisedScript}</pre>
			<div class="flex items-center justify-end gap-2 border-t px-4 py-2.5">
				<Button variant="ghost" size="sm" onclick={() => (confirming = null)} disabled={applying}>
					Cancel
				</Button>
				<Button size="sm" class="gap-1" onclick={() => confirming && applyImprovement(confirming)} disabled={applying}>
					{#if applying}
						<Loader2 class="size-3.5 animate-spin" /> Applying…
					{:else}
						<Check class="size-3.5" /> Confirm apply
					{/if}
				</Button>
			</div>
		</div>
	</div>
{/if}
