<script lang="ts">
	/**
	 * Run quick-switcher (Popover + Command) for the cockpit breadcrumb — switch
	 * between runs of the CURRENT workflow without leaving the page. Pairs with
	 * workflow-quick-switcher (workflow ▸ run, same pane). Lists the workflow's
	 * executions with status + relative time + duration; running runs pulse.
	 */
	import { goto } from '$app/navigation';
	import { ChevronsUpDown, Check, ArrowRight, Copy } from '@lucide/svelte';
	import * as Popover from '$lib/components/ui/popover';
	import * as Command from '$lib/components/ui/command';
	import { formatDistanceToNow } from 'date-fns';

	interface Props {
		slug: string;
		workflowId: string;
		currentExecutionId: string;
	}

	let { slug, workflowId, currentExecutionId }: Props = $props();

	type RunRow = {
		id: string;
		status: string;
		startedAt: string | null;
		completedAt: string | null;
		duration: string | null;
	};

	let open = $state(false);
	let loaded = $state(false);
	let loading = $state(false);
	let runs = $state<RunRow[]>([]);

	async function loadRuns(force = false) {
		if ((loaded && !force) || loading) return;
		loading = true;
		try {
			// No hard cap: fetch the full run history so every run is reachable. The
			// Command palette filters client-side across all rendered runs, so a run
			// beyond any former limit is found by typing its id/status.
			const res = await fetch(
				`/api/workflows/${encodeURIComponent(workflowId)}/executions?include=summary&limit=1000`
			);
			if (res.ok) runs = ((await res.json()) as RunRow[]) ?? [];
			loaded = true;
		} catch {
			// best-effort
		} finally {
			loading = false;
		}
	}

	// Re-fetch when opened (runs change as the workflow executes).
	$effect(() => {
		if (open) void loadRuns(true);
	});

	function statusDotClass(status: string): string {
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

	function fmtTime(dateStr: string | null): string {
		if (!dateStr) return '';
		try {
			return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
		} catch {
			return '';
		}
	}

	function fmtDuration(ms: string | null, status: string): string {
		if (status === 'running' || status === 'pending') return 'running';
		const n = Number(ms);
		if (!ms || !Number.isFinite(n) || n <= 0) return '';
		const s = Math.floor(n / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		const rs = s % 60;
		if (m < 60) return `${m}m ${rs}s`;
		const h = Math.floor(m / 60);
		return `${h}h ${m % 60}m`;
	}

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyCurrentId() {
		try {
			await navigator.clipboard.writeText(currentExecutionId);
			copied = true;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = false), 1500);
		} catch {
			// best-effort
		}
	}

	function pick(id: string) {
		open = false;
		if (id === currentExecutionId) return;
		goto(`/workspaces/${slug}/workflows/${workflowId}/runs/${id}`);
	}

	function goToAll() {
		open = false;
		goto(`/workspaces/${slug}/runs?workflowId=${encodeURIComponent(workflowId)}`);
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		class="group flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-xs hover:bg-accent transition-colors"
		title="Switch run"
	>
		<span>{currentExecutionId.slice(0, 8)}</span>
		<ChevronsUpDown size={12} class="shrink-0 text-muted-foreground group-hover:text-foreground" />
	</Popover.Trigger>

	<Popover.Content class="w-[320px] p-0" align="start" sideOffset={8}>
		<Command.Root>
			<div class="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
				<span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
					{currentExecutionId}
				</span>
				<button
					type="button"
					aria-label="Copy current run ID"
					title={copied ? 'Copied' : 'Copy run ID'}
					onclick={copyCurrentId}
					class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					{#if copied}
						<Check size={12} class="text-emerald-500" />
					{:else}
						<Copy size={12} />
					{/if}
				</button>
			</div>
			<Command.Input placeholder="Switch run…" class="h-9" />
			<Command.List class="max-h-[360px]">
				<Command.Empty>{loading ? 'Loading…' : 'No runs found.'}</Command.Empty>
				<Command.Group heading="Runs">
					{#each runs as run (run.id)}
						<Command.Item
							value={run.id + ' ' + run.status}
							onSelect={() => pick(run.id)}
							class="flex items-center gap-2"
						>
							<span class="size-2 shrink-0 rounded-full {statusDotClass(run.status)}"></span>
							<div class="min-w-0 flex-1">
								<div class="truncate font-mono text-xs">{run.id.slice(0, 8)}</div>
								<div class="text-[10px] text-muted-foreground">
									{run.status}{fmtTime(run.startedAt) ? ` · ${fmtTime(run.startedAt)}` : ''}{fmtDuration(
										run.duration,
										run.status
									)
										? ` · ${fmtDuration(run.duration, run.status)}`
										: ''}
								</div>
							</div>
							{#if run.id === currentExecutionId}
								<Check size={14} class="shrink-0 text-primary" />
							{/if}
						</Command.Item>
					{/each}
				</Command.Group>
				<Command.Separator />
				<Command.Item value="view-all-runs" onSelect={goToAll} class="flex items-center gap-2">
					<ArrowRight size={14} class="text-muted-foreground" />
					<span class="text-xs">View all runs</span>
				</Command.Item>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
