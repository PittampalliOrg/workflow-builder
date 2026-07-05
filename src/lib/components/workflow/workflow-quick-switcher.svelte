<script lang="ts">
	/**
	 * Prop-driven workflow quick-switcher (Popover + Command palette) for the run
	 * cockpit + workflow detail header. Unlike `workflow-switcher.svelte` (coupled
	 * to the editor's workflow store), this is self-contained and groups workflows
	 * by **Running** (has an active execution — shown first with a live pulse) and
	 * **Recent** (by latest activity). Picking a workflow jumps straight to its
	 * latest run (variant="run") or its editor (variant="editor") — same flow,
	 * no detour through the list page.
	 */
	import { goto } from '$app/navigation';
	import { ChevronsUpDown, Check, ArrowRight, Workflow as WorkflowIcon } from '@lucide/svelte';
	import * as Popover from '$lib/components/ui/popover';
	import * as Command from '$lib/components/ui/command';
	import { formatDistanceToNow } from 'date-fns';

	interface Props {
		slug: string;
		currentWorkflowId: string;
		currentWorkflowName?: string;
		/** "run" → jump to the picked workflow's latest run cockpit; "editor" →
		 *  open its editor. */
		variant?: 'run' | 'editor';
	}

	let { slug, currentWorkflowId, currentWorkflowName = '', variant = 'run' }: Props = $props();

	type WorkflowItem = { id: string; name: string; updatedAt: string };
	type RunItem = {
		executionId: string;
		workflowId: string;
		status: string;
		startedAt: string | null;
	};

	let open = $state(false);
	let loaded = $state(false);
	let loading = $state(false);
	let workflows = $state<WorkflowItem[]>([]);
	let runs = $state<RunItem[]>([]);

	async function loadData() {
		if (loaded || loading) return;
		loading = true;
		try {
			// No hard truncation: fetch the full set so every workflow (and its run
			// status) is reachable. The Command palette filters client-side across
			// all rendered items, so typing any name surfaces it regardless of recency.
			const [wfRes, runRes] = await Promise.all([
				fetch('/api/workflows?limit=1000'),
				fetch('/api/v1/runs?limit=1000')
			]);
			if (wfRes.ok) workflows = (await wfRes.json()) as WorkflowItem[];
			if (runRes.ok) {
				const data = (await runRes.json()) as { runs?: RunItem[] };
				runs = data.runs ?? [];
			}
			loaded = true;
		} catch {
			// best-effort
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open && !loaded) void loadData();
	});

	function isRunningStatus(s: string): boolean {
		return s === 'running' || s === 'pending';
	}

	// Most-recent run + most-recent RUNNING run, per workflow.
	const latestByWf = $derived.by(() => {
		const m = new Map<string, RunItem>();
		for (const r of runs) {
			const cur = m.get(r.workflowId);
			if (!cur || (r.startedAt ?? '') > (cur.startedAt ?? '')) m.set(r.workflowId, r);
		}
		return m;
	});
	const runningByWf = $derived.by(() => {
		const m = new Map<string, RunItem>();
		for (const r of runs) {
			if (!isRunningStatus(r.status)) continue;
			const cur = m.get(r.workflowId);
			if (!cur || (r.startedAt ?? '') > (cur.startedAt ?? '')) m.set(r.workflowId, r);
		}
		return m;
	});

	// Sort key = latest RUN time only. We deliberately do NOT fall back to the
	// workflow's updatedAt: a seed/sync touches every workflow's updatedAt at
	// once, which would make unrelated workflows all read "a minute ago".
	function activityTs(w: WorkflowItem): string {
		return latestByWf.get(w.id)?.startedAt ?? '';
	}

	const runningWorkflows = $derived.by(() =>
		workflows
			.filter((w) => runningByWf.has(w.id))
			.sort((a, b) => (activityTs(b)).localeCompare(activityTs(a)))
	);
	// "Recent" = workflows that have actually RUN (not running now), newest run
	// first. NOT truncated — every run workflow is listed here (older ones are just
	// further down / found by search), so a workflow beyond any former cutoff stays
	// reachable. Run-less workflows go in the "All workflows" group below (not
	// "Recent", to avoid fake timestamps).
	const recentWorkflows = $derived.by(() =>
		workflows
			.filter((w) => !runningByWf.has(w.id) && latestByWf.has(w.id))
			.sort((a, b) => activityTs(b).localeCompare(activityTs(a)))
	);
	// Everything else (never run, not running) — alphabetical, so the dropdown is a
	// complete picker rather than only "runs so far".
	const otherWorkflows = $derived.by(() =>
		workflows
			.filter((w) => !runningByWf.has(w.id) && !latestByWf.has(w.id))
			.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
	);

	const currentIsRunning = $derived(runningByWf.has(currentWorkflowId));

	function statusDotClass(status: string | undefined): string {
		switch (status) {
			case 'running':
			case 'pending':
				return 'bg-teal-400 animate-pulse';
			case 'success':
				return 'bg-emerald-500';
			case 'error':
				return 'bg-red-500';
			case 'cancelled':
				return 'bg-muted-foreground/50';
			default:
				return 'bg-muted-foreground/30';
		}
	}

	function fmt(dateStr: string | null | undefined): string {
		if (!dateStr) return 'no runs yet';
		try {
			return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
		} catch {
			return '';
		}
	}

	function pick(id: string) {
		open = false;
		if (variant === 'editor') {
			goto(`/workspaces/${slug}/workflows/${id}`);
			return;
		}
		const latest = latestByWf.get(id);
		goto(
			latest
				? `/workspaces/${slug}/workflows/${id}/runs/${latest.executionId}`
				: `/workspaces/${slug}/workflows/${id}`
		);
	}

	function goToAll() {
		open = false;
		goto(`/workspaces/${slug}/workflows`);
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		class="group flex max-w-[260px] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium hover:bg-accent transition-colors"
		title="Switch workflow"
	>
		{#if currentIsRunning}
			<span class="size-1.5 shrink-0 animate-pulse rounded-full bg-teal-400"></span>
		{/if}
		<span class="truncate">{currentWorkflowName || currentWorkflowId}</span>
		<ChevronsUpDown size={12} class="shrink-0 text-muted-foreground group-hover:text-foreground" />
	</Popover.Trigger>

	<Popover.Content class="w-[340px] p-0" align="start" sideOffset={8}>
		<Command.Root>
			<Command.Input placeholder="Switch workflow…" class="h-9" />
			<Command.List class="max-h-[360px]">
				<Command.Empty>{loading ? 'Loading…' : 'No workflows found.'}</Command.Empty>

				{#if runningWorkflows.length > 0}
					<Command.Group heading="Running">
						{#each runningWorkflows as wf (wf.id)}
							{@const run = runningByWf.get(wf.id)}
							<Command.Item value={'run ' + wf.name} onSelect={() => pick(wf.id)} class="flex items-center gap-2">
								<span class="size-2 shrink-0 animate-pulse rounded-full bg-teal-400"></span>
								<div class="min-w-0 flex-1">
									<div class="truncate text-xs font-medium">{wf.name || 'Untitled'}</div>
									<div class="text-[10px] text-teal-600 dark:text-teal-400">
										running · started {fmt(run?.startedAt)}
									</div>
								</div>
								{#if wf.id === currentWorkflowId}
									<Check size={14} class="shrink-0 text-primary" />
								{/if}
							</Command.Item>
						{/each}
					</Command.Group>
					<Command.Separator />
				{/if}

				<Command.Group heading="Recent">
					{#each recentWorkflows as wf (wf.id)}
						{@const run = latestByWf.get(wf.id)}
						<Command.Item value={'recent ' + wf.name} onSelect={() => pick(wf.id)} class="flex items-center gap-2">
							<span class="size-2 shrink-0 rounded-full {statusDotClass(run?.status)}"></span>
							<div class="min-w-0 flex-1">
								<div class="truncate text-xs">{wf.name || 'Untitled'}</div>
								<div class="text-[10px] text-muted-foreground">
									{run ? `${run.status} · ${fmt(run.startedAt)}` : 'no runs yet'}
								</div>
							</div>
							{#if wf.id === currentWorkflowId}
								<Check size={14} class="shrink-0 text-primary" />
							{/if}
						</Command.Item>
					{/each}
				</Command.Group>

				{#if otherWorkflows.length > 0}
					<Command.Separator />
					<Command.Group heading="All workflows">
						{#each otherWorkflows as wf (wf.id)}
							<Command.Item value={'all ' + wf.name} onSelect={() => pick(wf.id)} class="flex items-center gap-2">
								<span class="size-2 shrink-0 rounded-full bg-muted-foreground/30"></span>
								<div class="min-w-0 flex-1">
									<div class="truncate text-xs">{wf.name || 'Untitled'}</div>
									<div class="text-[10px] text-muted-foreground">no runs yet</div>
								</div>
								{#if wf.id === currentWorkflowId}
									<Check size={14} class="shrink-0 text-primary" />
								{/if}
							</Command.Item>
						{/each}
					</Command.Group>
				{/if}

				<Command.Separator />
				<Command.Item value="view-all-workflows" onSelect={goToAll} class="flex items-center gap-2">
					<ArrowRight size={14} class="text-muted-foreground" />
					<span class="text-xs">View all workflows</span>
				</Command.Item>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
