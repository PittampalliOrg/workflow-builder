<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Card, CardContent } from '$lib/components/ui/card';
	import { fmtTokens } from '$lib/utils/format-tokens';
	import { Activity, AlertTriangle, Coins, Cpu, Loader2, Wrench } from '@lucide/svelte';

	type TokenWindow = {
		input: number;
		output: number;
		cacheRead: number;
		cacheCreation: number;
		total: number;
	};

	type PodClass =
		| 'agent-runtime'
		| 'sandbox'
		| 'workspace-runtime'
		| 'workflow-orchestrator'
		| 'workflow-builder'
		| 'swebench'
		| 'other';

	type ResourceBucket = { count: number; cpuMillicores: number; memoryMiB: number };
	type Resources = {
		totalCpuMillicores: number;
		totalMemoryMiB: number;
		byClass: Record<PodClass, ResourceBucket>;
		pods: Array<{ name: string; cpuMillicores: number; memoryMiB: number; class: PodClass }>;
	} | null;

	type Snapshot = {
		ts: string;
		resources: Resources;
		workflows: {
			running: number;
			success: number;
			error: number;
			cancelled: number;
			pending: number;
			failuresLast5Min: number;
		};
		sessions: {
			running: number;
			idle: number;
			rescheduling: number;
			terminated: number;
			uniqueActiveAgents: number;
		};
		tokens: {
			lastHour: TokenWindow;
			lastMinute: TokenWindow;
			ratePerSec: number;
		};
		toolCallsLastHour: number;
	};

	let snapshot = $state<Snapshot | null>(null);
	let loading = $state(true);
	let err = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function refresh() {
		try {
			const res = await fetch('/api/metrics/aggregate');
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			snapshot = (await res.json()) as Snapshot;
			err = null;
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
		timer = setInterval(() => void refresh(), 5_000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
		timer = null;
	});

	const stamp = $derived(snapshot ? new Date(snapshot.ts).toLocaleTimeString() : '—');

	function fmtCores(millicores: number): string {
		const cores = millicores / 1000;
		if (cores >= 10) return cores.toFixed(0);
		return cores.toFixed(2);
	}

	function fmtMem(mib: number): string {
		if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
		return `${Math.round(mib)} MiB`;
	}

	const classOrder: PodClass[] = [
		'agent-runtime',
		'sandbox',
		'workspace-runtime',
		'workflow-orchestrator',
		'workflow-builder',
		'swebench',
		'other'
	];

	const classLabels: Record<PodClass, string> = {
		'agent-runtime': 'Agent runtimes',
		sandbox: 'Sandboxes',
		'workspace-runtime': 'Workspace runtime',
		'workflow-orchestrator': 'Orchestrator',
		'workflow-builder': 'BFF',
		swebench: 'SWE-bench',
		other: 'Other'
	};
</script>

<svelte:head>
	<title>Metrics · Admin · Workflow Builder</title>
</svelte:head>

<div class="flex flex-col gap-4 p-6">
	<header class="flex items-baseline justify-between">
		<div>
			<h1 class="text-xl font-semibold">Workflow metrics</h1>
			<p class="text-sm text-muted-foreground">
				Aggregate view across every workspace in this environment. Polls every 5 s.
			</p>
		</div>
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			{#if loading}
				<Loader2 class="size-3 animate-spin" /> loading…
			{:else if err}
				<AlertTriangle class="size-3 text-red-500" /> {err}
			{:else}
				updated {stamp}
			{/if}
		</div>
	</header>

	{#if snapshot}
		<!-- Workflow execution counts -->
		<section class="grid grid-cols-2 gap-3 md:grid-cols-6">
			<Card>
				<CardContent class="flex flex-col gap-1 p-4">
					<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Activity class="size-3" /> Running
					</div>
					<div class="text-2xl font-mono font-semibold">{snapshot.workflows.running}</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="flex flex-col gap-1 p-4">
					<div class="text-xs text-muted-foreground">Pending</div>
					<div class="text-2xl font-mono font-semibold">{snapshot.workflows.pending}</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="flex flex-col gap-1 p-4">
					<div class="text-xs text-muted-foreground">Success (1h)</div>
					<div class="text-2xl font-mono font-semibold">{snapshot.workflows.success}</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="flex flex-col gap-1 p-4">
					<div class="text-xs text-muted-foreground">Error (1h)</div>
					<div class="text-2xl font-mono font-semibold">
						{snapshot.workflows.error}
						{#if snapshot.workflows.failuresLast5Min > 0}
							<Badge variant="destructive" class="ml-2 text-[10px]">
								+{snapshot.workflows.failuresLast5Min} in 5m
							</Badge>
						{/if}
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="flex flex-col gap-1 p-4">
					<div class="text-xs text-muted-foreground">Cancelled (1h)</div>
					<div class="text-2xl font-mono font-semibold">{snapshot.workflows.cancelled}</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="flex flex-col gap-1 p-4">
					<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Cpu class="size-3" /> Active agents
					</div>
					<div class="text-2xl font-mono font-semibold">
						{snapshot.sessions.uniqueActiveAgents}
					</div>
					<div class="text-[10px] text-muted-foreground">
						{snapshot.sessions.running} running session{snapshot.sessions.running === 1 ? '' : 's'}
					</div>
				</CardContent>
			</Card>
		</section>

		<!-- Resource usage (metrics-server, populated when RBAC is in place) -->
		{#if snapshot.resources}
			<section class="grid grid-cols-1 gap-3 md:grid-cols-3">
				<Card>
					<CardContent class="flex flex-col gap-1 p-4">
						<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
							<Cpu class="size-3" /> CPU in use
						</div>
						<div class="text-2xl font-mono font-semibold">
							{fmtCores(snapshot.resources.totalCpuMillicores)}<span class="text-sm text-muted-foreground"> cores</span>
						</div>
						<div class="text-[10px] text-muted-foreground">
							across {snapshot.resources.pods.length} pod{snapshot.resources.pods.length === 1 ? '' : 's'}
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="flex flex-col gap-1 p-4">
						<div class="text-xs text-muted-foreground">Memory in use</div>
						<div class="text-2xl font-mono font-semibold">
							{fmtMem(snapshot.resources.totalMemoryMiB)}
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardContent class="p-4">
						<div class="mb-2 text-xs text-muted-foreground">By pod class</div>
						<div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
							{#each classOrder as cls}
								{@const b = snapshot.resources.byClass[cls]}
								{#if b.count > 0}
									<span class="text-muted-foreground">{classLabels[cls]}</span>
									<span class="text-right font-mono">
										{b.count} · {fmtCores(b.cpuMillicores)}c · {fmtMem(b.memoryMiB)}
									</span>
								{/if}
							{/each}
						</div>
					</CardContent>
				</Card>
			</section>
		{/if}

		<!-- Token usage -->
		<section class="grid grid-cols-1 gap-3 md:grid-cols-3">
			<Card>
				<CardContent class="flex flex-col gap-2 p-4">
					<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Activity class="size-3" /> Token rate
					</div>
					<div class="text-2xl font-mono font-semibold">
						{fmtTokens(snapshot.tokens.ratePerSec)}<span class="text-sm text-muted-foreground"> / s</span>
					</div>
					<div class="text-[10px] text-muted-foreground">
						Last 1m window: {fmtTokens(snapshot.tokens.lastMinute.input)} in /
						{fmtTokens(snapshot.tokens.lastMinute.output)} out
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="flex flex-col gap-2 p-4">
					<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Coins class="size-3" /> Tokens (1h)
					</div>
					<div class="text-2xl font-mono font-semibold">
						{fmtTokens(snapshot.tokens.lastHour.total)}
					</div>
					<div class="text-[10px] text-muted-foreground">
						{fmtTokens(snapshot.tokens.lastHour.input)} in /
						{fmtTokens(snapshot.tokens.lastHour.output)} out{#if snapshot.tokens.lastHour.cacheRead}
							/ {fmtTokens(snapshot.tokens.lastHour.cacheRead)} cache-read
						{/if}{#if snapshot.tokens.lastHour.cacheCreation}
							/ {fmtTokens(snapshot.tokens.lastHour.cacheCreation)} cache-write
						{/if}
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardContent class="flex flex-col gap-2 p-4">
					<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Wrench class="size-3" /> Tool calls (1h)
					</div>
					<div class="text-2xl font-mono font-semibold">
						{snapshot.toolCallsLastHour.toLocaleString()}
					</div>
				</CardContent>
			</Card>
		</section>

		<!-- Session breakdown -->
		<section>
			<Card>
				<CardContent class="p-4">
					<h2 class="mb-3 text-sm font-semibold">Sessions (last hour, by status)</h2>
					<div class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
						<div class="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
							<span class="text-muted-foreground">Running</span>
							<span class="font-mono">{snapshot.sessions.running}</span>
						</div>
						<div class="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
							<span class="text-muted-foreground">Rescheduling</span>
							<span class="font-mono">{snapshot.sessions.rescheduling}</span>
						</div>
						<div class="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
							<span class="text-muted-foreground">Idle</span>
							<span class="font-mono">{snapshot.sessions.idle}</span>
						</div>
						<div class="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2">
							<span class="text-muted-foreground">Terminated</span>
							<span class="font-mono">{snapshot.sessions.terminated}</span>
						</div>
					</div>
				</CardContent>
			</Card>
		</section>
	{/if}
</div>
