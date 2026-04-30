<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Layers, RefreshCw, Tag, X } from 'lucide-svelte';
	import CompareAxisDiffStrip from '$lib/components/benchmarks/compare-axis-diff-strip.svelte';
	import CompareHeadlineBar from '$lib/components/benchmarks/compare-headline-bar.svelte';
	import CompareGrid from '$lib/components/benchmarks/compare-grid.svelte';
	import LaunchRunSheet from '$lib/components/benchmarks/launch-run-sheet.svelte';
	import RunInstanceDrawer from '$lib/components/benchmarks/run-instance-drawer.svelte';
	import { isActiveRunStatus } from '$lib/components/benchmarks/run-status-helpers';
	import type { AxisName, RunConfigSummary } from '$lib/server/benchmarks/comparison';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');

	const view = $state<{ value: 'all' | 'shared' | 'disagreement' }>({
		value: (page.url.searchParams.get('view') as 'all' | 'shared' | 'disagreement') ?? 'disagreement'
	});

	let drawerOpen = $state(false);
	let drawerRunId = $state<string | null>(null);
	let drawerInstanceId = $state<string | null>(null);

	// Launch Sheet state for "Fork → re-run" affordance.
	let launchOpen = $state(false);
	let launchInstanceIds = $state<string[]>([]);
	let launchSuiteSlug = $state<string>('SWE-bench_Verified');
	let launchDefaults = $state<{
		agentId?: string;
		modelNameOrPath?: string;
		modelConfigLabel?: string;
		tags?: string[];
	} | null>(null);
	let launcherAgents = $state<
		Array<{
			id: string;
			slug: string;
			name: string;
			avatar: string | null;
			runtime: string;
			currentVersion: number;
			registryStatus: string;
			modelSpec: string | null;
		}>
	>([]);
	let launcherSuites = $state<Array<{ slug: string; name: string; instanceCount: number }>>([]);
	let loadingFork = $state(false);

	function bumpLabel(current: string | null | undefined): string {
		const base = (current ?? '').trim();
		if (!base) return 'fork-1';
		// "v1" → "v2", "exp-3" → "exp-4", anything else → append "-fork".
		const m = base.match(/^(.*?)(\d+)$/);
		if (m) return `${m[1]}${Number.parseInt(m[2], 10) + 1}`;
		return `${base}-fork`;
	}

	async function ensureLauncherContext() {
		if (launcherAgents.length > 0 && launcherSuites.length > 0) return;
		try {
			const [agentsRes, suitesRes] = await Promise.all([
				fetch('/api/agents'),
				fetch('/api/benchmarks/suites')
			]);
			if (agentsRes.ok) {
				const body = (await agentsRes.json()) as {
					agents: Array<{
						id: string;
						slug: string;
						name: string;
						avatar?: string | null;
						runtime: string;
						currentVersion: number | null;
						registryStatus: string | null;
						modelSpec?: string | null;
					}>;
				};
				launcherAgents = (body.agents ?? [])
					.filter(
						(a) =>
							a.runtime === 'dapr-agent-py' &&
							a.registryStatus === 'registered' &&
							typeof a.currentVersion === 'number'
					)
					.map((a) => ({
						id: a.id,
						slug: a.slug,
						name: a.name,
						avatar: a.avatar ?? null,
						runtime: a.runtime,
						currentVersion: a.currentVersion as number,
						registryStatus: a.registryStatus ?? 'unregistered',
						modelSpec: a.modelSpec ?? null
					}));
			}
			if (suitesRes.ok) {
				const body = (await suitesRes.json()) as {
					suites: Array<{ slug: string; name: string; instanceCount: number }>;
				};
				launcherSuites = body.suites ?? [];
			}
		} catch {
			// best effort — Sheet still opens
		}
	}

	async function forkRun(run: RunConfigSummary) {
		if (!compare) return;
		loadingFork = true;
		try {
			await ensureLauncherContext();
			// The compare grid already has every instance per run; pick the
			// instances for this run from the grid (cheaper than re-querying).
			const instanceMap = compare.grid[run.runId] ?? {};
			launchInstanceIds = Object.keys(instanceMap).sort();
			launchSuiteSlug = run.suiteSlug;
			launchDefaults = {
				agentId: run.agent.id,
				modelNameOrPath: run.model,
				modelConfigLabel: bumpLabel(run.modelLabel),
				tags: data.resolvedFromTag ? [data.resolvedFromTag] : []
			};
			launchOpen = true;
		} finally {
			loadingFork = false;
		}
	}

	const compare = $derived(data.compare);
	const hasInProgress = $derived(
		compare?.runs?.some((r) => isActiveRunStatus(r.status)) ?? false
	);

	// "Stats by axis" — when exactly one axis differs, show a per-value
	// resolved% bar chart. Powerful when running a clean A/B experiment.
	const singleAxis = $derived.by<AxisName | null>(() => {
		if (!compare) return null;
		const differing = (Object.entries(compare.axisDiff) as Array<[AxisName, { differs: boolean }]>).filter(
			([, d]) => d.differs
		);
		if (differing.length !== 1) return null;
		// Skip uninteresting axes for stats-by-axis
		const axis = differing[0][0];
		if (axis === 'modelLabel' || axis === 'concurrency' || axis === 'evaluatorResourceClass') {
			return null;
		}
		return axis;
	});

	const statsByAxis = $derived.by(() => {
		if (!compare || !singleAxis) return null;
		const axis = singleAxis;
		return compare.runs.map((r, idx) => ({
			runIdx: idx,
			runId: r.runId,
			value: readAxis(r, axis),
			resolvedRate: r.resolvedRate,
			resolved: r.resolved,
			total: r.total
		}));
	});

	function readAxis(r: RunConfigSummary, axis: AxisName): unknown {
		switch (axis) {
			case 'agent':
				return r.agent.slug ?? r.agent.id ?? r.agent.name;
			case 'agentVersion':
				return r.agentVersion;
			case 'model':
				return r.model;
			case 'modelLabel':
				return r.modelLabel;
			case 'mcpServerNames':
				return r.mcpServerNames.join(', ') || '∅';
			case 'skillNames':
				return r.skillNames.join(', ') || '∅';
			case 'hookNames':
				return r.hookNames.join(', ') || '∅';
			case 'pluginNames':
				return r.pluginNames.join(', ') || '∅';
			case 'concurrency':
				return r.concurrency;
			case 'evaluatorResourceClass':
				return r.evaluatorResourceClass;
		}
	}

	function setView(next: 'all' | 'shared' | 'disagreement') {
		view.value = next;
		const params = new URLSearchParams(window.location.search);
		if (next !== 'disagreement') params.set('view', next);
		else params.delete('view');
		const qs = params.toString();
		window.history.replaceState(window.history.state, '', qs ? `?${qs}` : window.location.pathname);
	}

	function openDrawer(args: { runId: string; instanceId: string }) {
		drawerRunId = args.runId;
		drawerInstanceId = args.instanceId;
		drawerOpen = true;
	}

	function removeRun(runId: string) {
		const remaining = data.runIds.filter((id) => id !== runId);
		if (remaining.length === 0) {
			goto(`/workspaces/${slug}/benchmarks/runs`);
			return;
		}
		goto(`/workspaces/${slug}/benchmarks/compare?runs=${remaining.join(',')}`, {
			invalidateAll: true
		});
	}

	async function refresh() {
		if (data.runIds.length === 0) return;
		await goto(window.location.pathname + window.location.search, {
			invalidateAll: true,
			noScroll: true,
			keepFocus: true
		});
	}

	const SUITE_DIVERGES = $derived.by(() => {
		if (!compare) return false;
		const slugs = new Set(compare.runs.map((r) => r.suiteSlug));
		return slugs.size > 1;
	});
</script>

<svelte:head><title>Compare runs · Benchmarks</title></svelte:head>

<div class="space-y-4">
	<header class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h1 class="flex items-center gap-2 text-2xl font-semibold">
				<Layers class="size-6" /> Compare runs
			</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				Side-by-side comparison across configuration axes — agent, model, skills, MCP, hooks, plugins.
			</p>
		</div>
		<div class="flex items-center gap-2">
			{#if data.runIds.length > 0}
				<Button variant="outline" size="sm" onclick={refresh}>
					<RefreshCw class="size-3.5" /> Refresh
				</Button>
			{/if}
			<Button
				variant="outline"
				size="sm"
				onclick={() => goto(`/workspaces/${slug}/benchmarks/runs`)}
			>
				Pick runs →
			</Button>
		</div>
	</header>

	{#if !compare || data.runIds.length < 2}
		<div class="rounded-md border border-dashed border-border bg-muted/20 px-4 py-12 text-center">
			<Layers class="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
			{#if data.resolvedFromTag && data.runIds.length === 0}
				<h2 class="text-base font-medium">No runs tagged <code>#{data.resolvedFromTag}</code></h2>
				<p class="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
					Tag one or more runs with <code>#{data.resolvedFromTag}</code> in the launch flow to use
					the <code>?tag=</code> shortcut.
				</p>
			{:else if data.resolvedFromTag && data.runIds.length === 1}
				<h2 class="text-base font-medium">Only one run tagged <code>#{data.resolvedFromTag}</code></h2>
				<p class="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
					Need at least 2 runs sharing this tag for a meaningful comparison.
				</p>
			{:else}
				<h2 class="text-base font-medium">Pick runs to compare</h2>
				<p class="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
					Compare 2 to 4 benchmark runs to see how a change in agent, model, MCP servers, skills,
					hooks, or plugins moved the resolved rate.
				</p>
			{/if}
			<Button class="mt-4" onclick={() => goto(`/workspaces/${slug}/benchmarks/runs`)}>
				Browse benchmark runs →
			</Button>
		</div>
	{:else}
		{#if hasInProgress}
			<Alert variant="default" class="border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30">
				<AlertDescription class="text-amber-900 dark:text-amber-200">
					Some runs are still executing — comparisons may shift.
				</AlertDescription>
			</Alert>
		{/if}

		{#if SUITE_DIVERGES}
			<Alert variant="default" class="border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30">
				<AlertDescription class="text-amber-900 dark:text-amber-200">
					These runs target different suites. Resolved-rate comparisons across suites are not apples-to-apples.
				</AlertDescription>
			</Alert>
		{/if}

		{#if data.resolvedFromTag}
			<div class="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
				<Tag class="h-3 w-3 text-muted-foreground" />
				<span class="text-muted-foreground">
					Auto-picked {compare.runs.length} run{compare.runs.length === 1 ? '' : 's'} tagged
					<code class="rounded bg-muted px-1 font-mono">#{data.resolvedFromTag}</code>.
				</span>
			</div>
		{/if}

		<!-- Run pills (with remove) -->
		<div class="flex flex-wrap items-center gap-1.5">
			<span class="text-[11px] uppercase tracking-wider text-muted-foreground">Comparing:</span>
			{#each compare.runs as run, idx (run.runId)}
				<Badge variant={idx === 0 ? 'default' : 'secondary'} class="gap-1 pl-2 pr-1 text-[11px]">
					<span class="tabular-nums opacity-70">#{idx + 1}</span>
					<span class="truncate max-w-[180px]">
						{run.modelLabel ?? `${run.agent.name} · ${run.model}`}
					</span>
					<button
						type="button"
						class="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-muted-foreground/20"
						onclick={() => removeRun(run.runId)}
						aria-label="Remove this run from the comparison"
					>
						<X class="h-3 w-3" />
					</button>
				</Badge>
			{/each}
		</div>

		<CompareHeadlineBar runs={compare.runs} workspaceSlug={slug} onFork={forkRun} />

		<CompareAxisDiffStrip axisDiff={compare.axisDiff} runs={compare.runs} />

		{#if statsByAxis && statsByAxis.length > 0}
			<div class="rounded-md border border-border bg-background p-4">
				<h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					Resolved % by {String(singleAxis)}
				</h3>
				<div class="space-y-1.5">
					{#each statsByAxis as bar (bar.runId)}
						{@const pct = Math.round(bar.resolvedRate * 100)}
						<div>
							<div class="flex items-baseline justify-between text-xs">
								<span class="truncate font-mono text-muted-foreground" title={String(bar.value)}>
									#{bar.runIdx + 1} · {String(bar.value)}
								</span>
								<span class="shrink-0 tabular-nums">
									<span class="font-semibold">{pct}%</span>
									<span class="text-muted-foreground"> ({bar.resolved}/{bar.total})</span>
								</span>
							</div>
							<div class="mt-0.5 h-2 overflow-hidden rounded-full bg-muted">
								<div
									class="h-full bg-emerald-500 transition-all"
									style:width="{Math.min(100, pct)}%"
								></div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<section class="space-y-2">
			<div class="flex items-center justify-between">
				<h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
					Per-instance grid
				</h2>
				<span class="text-[11px] text-muted-foreground">
					{compare.disagreements.length} disagreements · {compare.sharedInstanceIds.length} shared · {compare.allInstanceIds.length} total
				</span>
			</div>

			<CompareGrid
				data={compare}
				view={view.value}
				onView={setView}
				onCellClick={openDrawer}
			/>
		</section>
	{/if}
</div>

<RunInstanceDrawer
	bind:open={drawerOpen}
	runId={drawerRunId}
	instanceId={drawerInstanceId}
	workspaceSlug={slug}
	onOpenChange={(next) => (drawerOpen = next)}
/>

<LaunchRunSheet
	bind:open={launchOpen}
	instanceIds={launchInstanceIds}
	suiteSlug={launchSuiteSlug}
	runnableAgents={launcherAgents}
	suiteFacets={launcherSuites}
	defaults={launchDefaults}
	onOpenChange={(next) => (launchOpen = next)}
/>
