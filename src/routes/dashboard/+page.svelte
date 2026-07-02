<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import {
		Activity,
		Bot,
		ExternalLink,
		KeyRound,
		Layers,
		MessageSquare,
		MessagesSquare,
		Plus,
		Sparkles,
		CheckCircle2,
		XCircle,
		AlertTriangle,
		Clock,
		Coins,
		ShieldCheck,
		Terminal,
		ChevronDown,
		ChevronUp,
		RefreshCw,
		Cpu,
		Zap,
		Settings,
		Server,
		Lock,
		Play
	} from '@lucide/svelte';

	// Receive data loaded from +page.server.ts
	let { data: serverData } = $props();

	// Create local states initialized from server load data
	let dashboard = $state(serverData.dashboard);
	let recentRuns = $state(serverData.recentRuns);
	let devEnvironments = $state(serverData.devEnvironments);
	let capacity = $state(serverData.capacity);
	let gitops = $state(serverData.gitops);
	let user = $state(serverData.user);

	let loading = $state(false);
	let isPolling = $state(false);
	let pollError = $state<string | null>(null);

	const slug = DEFAULT_WORKSPACE_SLUG;

	// Local state for tracking which elements are expanded (progressive disclosure)
	let expandedItems = $state<Record<string, boolean>>({});

	function toggleExpand(id: string) {
		expandedItems[id] = !expandedItems[id];
	}

	async function pollData(silent = true) {
		if (!silent) loading = true;
		pollError = null;
		isPolling = true;
		try {
			const [dRes, rRes, devRes, capRes, gitRes] = await Promise.all([
				fetch('/api/v1/dashboard').then(r => r.ok ? r.json() : null),
				fetch('/api/v1/runs?limit=10').then(r => r.ok ? r.json() : null),
				fetch('/api/dev-environments').then(r => r.ok ? r.json() : null),
				fetch('/api/capacity/overview').then(r => r.ok ? r.json() : null),
				fetch('/api/v1/gitops/events?limit=10').then(r => r.ok ? r.json() : null).catch(() => null)
			]);

			if (dRes) dashboard = dRes;
			if (rRes) recentRuns = rRes.runs ?? [];
			if (devRes) devEnvironments = devRes.environments ?? [];
			if (capRes) capacity = capRes;
			if (gitRes) gitops = gitRes;
		} catch (err) {
			pollError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
			isPolling = false;
		}
	}

	onMount(() => {
		const interval = setInterval(() => pollData(true), 8000);
		return () => clearInterval(interval);
	});

	// Derived: Greetings and display names
	let greeting = $derived.by(() => {
		const hour = new Date().getHours();
		if (hour < 12) return 'Good morning';
		if (hour < 18) return 'Good afternoon';
		return 'Good evening';
	});

	let displayName = $derived(
		user?.name?.split(' ')[0] ?? user?.email?.split('@')[0] ?? 'Operator'
	);

	// Derived: System Health Index Status
	let healthStatus = $derived.by(() => {
		const finished = recentRuns.filter((r: any) => r.status === 'success' || r.status === 'error');
		let successRate = 100;
		if (finished.length > 0) {
			const successCount = finished.filter((r: any) => r.status === 'success').length;
			successRate = Math.round((successCount / finished.length) * 100);
		}

		const totalVaults = dashboard?.stats?.totalVaults ?? 0;
		const totalAgents = dashboard?.stats?.totalAgents ?? 0;

		let score = successRate;
		let label = 'HEALTHY';
		let colorClass = 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
		let bgPulse = 'bg-emerald-500';

		if (totalVaults === 0 && totalAgents > 0) {
			score = Math.min(score, 85);
			label = 'WARNING (No Vaults)';
			colorClass = 'text-amber-400 bg-amber-500/10 border-amber-500/20';
			bgPulse = 'bg-amber-500';
		} else if (successRate < 50) {
			label = 'CRITICAL';
			colorClass = 'text-rose-400 bg-rose-500/10 border-rose-500/20';
			bgPulse = 'bg-rose-500';
		} else if (successRate < 80) {
			label = 'DEGRADED';
			colorClass = 'text-amber-400 bg-amber-500/10 border-amber-500/20';
			bgPulse = 'bg-amber-500';
		}

		return {
			percent: score,
			label,
			colorClass,
			bgPulse
		};
	});

	// Derived: Active Operations (What is running NOW)
	let activeOperations = $derived.by(() => {
		const list: Array<{
			id: string;
			type: 'session' | 'workflow' | 'devenvs';
			name: string;
			status: string;
			startedAt: string;
			badgeClass: string;
			avatar?: string;
			raw: any;
		}> = [];

		// Active sessions
		if (dashboard?.activeSessions) {
			dashboard.activeSessions.forEach((s: any) => {
				list.push({
					id: `session-${s.id}`,
					type: 'session',
					name: s.title || `Untitled Session (${s.id.slice(0, 8)})`,
					status: s.status, // running, idle
					startedAt: s.createdAt,
					badgeClass: s.status === 'running' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20',
					avatar: s.agentAvatar || '🤖',
					raw: s
				});
			});
		}

		// In-flight workflows
		recentRuns.forEach((r: any) => {
			if (r.status === 'running' || r.status === 'pending') {
				list.push({
					id: `workflow-${r.executionId}`,
					type: 'workflow',
					name: r.workflowName || `Workflow (${r.executionId.slice(0, 8)})`,
					status: r.status,
					startedAt: r.startedAt,
					badgeClass: r.status === 'running' ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20',
					avatar: '⚡',
					raw: r
				});
			}
		});

		// Live preview environments
		devEnvironments.forEach((e: any) => {
			if (e.runStatus !== 'success' && e.runStatus !== 'error' && e.runStatus !== 'cancelled') {
				list.push({
					id: `devenvs-${e.executionId}`,
					type: 'devenvs',
					name: `Dev Space (${e.service})`,
					status: e.ready ? 'ready' : 'provisioning',
					startedAt: e.createdAt,
					badgeClass: e.ready ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20',
					avatar: '📦',
					raw: e
				});
			}
		});

		return list.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
	});

	// Derived: Chronicle (Timeline of recent events in ACTIVE VOICE)
	let recentChronicle = $derived.by(() => {
		const list: Array<{
			id: string;
			time: string;
			description: string;
			outcome: 'success' | 'error' | 'warning' | 'info';
			badgeLabel: string;
			badgeClass: string;
			link: string;
		}> = [];

		// Recent changes (versions)
		if (dashboard?.recentChanges) {
			dashboard.recentChanges.forEach((c: any) => {
				list.push({
					id: `change-${c.resourceId}-${c.version}`,
					time: c.publishedAt || new Date().toISOString(),
					description: c.kind === 'agent'
						? `Operator published agent ${c.resourceName} v${c.version}`
						: `System published environment ${c.resourceName} v${c.version}`,
					outcome: 'info',
					badgeLabel: `v${c.version}`,
					badgeClass: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
					link: c.kind === 'agent' ? `/workspaces/${slug}/agents/${c.resourceId}` : `/workspaces/${slug}/environments/${c.resourceId}`
				});
			});
		}

		// Finished workflow runs
		recentRuns.forEach((r: any) => {
			if (r.status !== 'running' && r.status !== 'pending') {
				const durationStr = r.durationMs ? ` in ${(r.durationMs / 1000).toFixed(1)}s` : '';
				let outcome: 'success' | 'error' | 'warning' = 'success';
				let badgeClass = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
				if (r.status === 'error') {
					outcome = 'error';
					badgeClass = 'bg-rose-500/10 text-rose-400 border-rose-500/20';
				} else if (r.status === 'cancelled') {
					outcome = 'warning';
					badgeClass = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
				}

				list.push({
					id: `run-${r.executionId}`,
					time: r.startedAt,
					description: r.status === 'success'
						? `Workflow ${r.workflowName} executed successfully${durationStr}`
						: r.status === 'error'
							? `Workflow ${r.workflowName} failed after error`
							: `Operator aborted workflow ${r.workflowName}`,
					outcome,
					badgeLabel: r.status.toUpperCase(),
					badgeClass,
					link: `/workspaces/${slug}/workflows/${r.workflowId}/runs/${r.executionId}`
				});
			}
		});

		// Gitops events (if present)
		if (gitops?.events) {
			gitops.events.forEach((g: any) => {
				const author = g.author || 'Operator';
				const commit = g.commitHash ? ` (${g.commitHash.slice(0, 7)})` : '';
				const envName = g.environmentName ? ` to ${g.environmentName}` : '';
				
				list.push({
					id: `gitops-${g.id || g.sequence}`,
					time: g.createdAt || g.timestamp,
					description: `${author} promoted deployment${commit}${envName}`,
					outcome: g.status === 'failed' ? 'error' : 'success',
					badgeLabel: 'GITOPS',
					badgeClass: g.status === 'failed' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
					link: '#'
				});
			});
		}

		return list.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 8);
	});

	// Derived: Capacity Details
	let capacityDetails = $derived.by(() => {
		if (!capacity || !capacity.observer || !capacity.observer.available || !capacity.observer.snapshot) {
			return null;
		}
		const snap = capacity.observer.snapshot;
		
		const admittedWorkloads = snap.queues?.reduce((acc: number, q: any) => acc + (q.admittedWorkloads || 0), 0) ?? 0;
		const pendingWorkloads = snap.queues?.reduce((acc: number, q: any) => acc + (q.pendingWorkloads || 0), 0) ?? 0;

		let avgNodePressure = 0;
		if (snap.nodePressure) {
			const values = Object.values(snap.nodePressure) as number[];
			if (values.length > 0) {
				avgNodePressure = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
			}
		}

		return {
			cluster: snap.cluster || 'Primary',
			flavor: snap.flavor || 'standard',
			admittedWorkloads,
			pendingWorkloads,
			avgNodePressure,
			admissionActive: snap.admissionHealth ? snap.admissionHealth.activeQueues : snap.queues?.filter((q:any) => q.active).length ?? 0,
			admissionTotal: snap.admissionHealth ? snap.admissionHealth.totalQueues : snap.queues?.length ?? 0,
		};
	});

	// Time formatting helper
	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}
</script>

<style>
	:global(:root) {
		--dark-obsidian: #0b0f17;
		--steel-indigo: #1e293b;
		--synth-cyan: #06b6d4;
		--cyber-emerald: #10b981;
		--pyro-amber: #f59e0b;
		--crimson-pulse: #ef4444;
	}

	.command-center {
		font-family: 'Plus Jakarta Sans', 'Inter', system-ui, sans-serif;
		background-color: var(--dark-obsidian);
		min-height: 100%;
		color: #e2e8f0;
	}

	.glass-card {
		background: rgba(30, 41, 59, 0.45);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		border: 1px solid rgba(255, 255, 255, 0.08);
		box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.4);
		transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
	}

	.glass-card:hover {
		border-color: rgba(6, 182, 212, 0.25);
		box-shadow: 0 12px 40px 0 rgba(6, 182, 212, 0.06);
	}

	/* Interactive Focus Ring */
	.interactive-target {
		outline: none;
		transition: all 0.2s ease-in-out;
	}
	.interactive-target:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--synth-cyan), 0 0 12px rgba(6, 182, 212, 0.6);
	}

	/* Heartbeat Pulse animation */
	@keyframes pulse-fast {
		0%, 100% {
			transform: scale(1);
			opacity: 0.8;
			filter: drop-shadow(0 0 4px var(--synth-cyan));
		}
		50% {
			transform: scale(1.08);
			opacity: 1;
			filter: drop-shadow(0 0 14px var(--synth-cyan));
		}
	}

	@keyframes breathe-slow {
		0%, 100% {
			opacity: 0.45;
			filter: drop-shadow(0 0 2px var(--steel-indigo));
		}
		50% {
			opacity: 0.75;
			filter: drop-shadow(0 0 10px var(--steel-indigo));
		}
	}

	.pulse-active {
		animation: pulse-fast 1.6s infinite ease-in-out;
	}

	.pulse-idle {
		animation: breathe-slow 3.5s infinite ease-in-out;
	}

	@media (prefers-reduced-motion: reduce) {
		.pulse-active, .pulse-idle {
			animation: none !important;
			transform: none !important;
			opacity: 0.85 !important;
			filter: drop-shadow(0 0 4px var(--synth-cyan)) !important;
		}
		.glass-card {
			transition: none !important;
		}
	}

	.scrollbar-custom::-webkit-scrollbar {
		width: 6px;
		height: 6px;
	}
	.scrollbar-custom::-webkit-scrollbar-track {
		background: rgba(0, 0, 0, 0.2);
		border-radius: 4px;
	}
	.scrollbar-custom::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.1);
		border-radius: 4px;
	}
	.scrollbar-custom::-webkit-scrollbar-thumb:hover {
		background: rgba(6, 182, 212, 0.3);
	}
</style>

<div class="command-center p-6 flex flex-col gap-6 w-full max-w-7xl mx-auto">
	
	<!-- COMMAND CENTER SIGNATURE HEADER -->
	<header class="glass-card rounded-2xl p-6 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 relative overflow-hidden">
		<!-- Live Heartbeat Fleet Pulse Background glow -->
		<div class="absolute -right-16 -top-16 w-64 h-64 rounded-full bg-cyan-500/5 blur-3xl pointer-events-none"></div>
		
		<div class="flex items-center gap-4">
			<!-- Pulsing signature element -->
			<div class="relative flex items-center justify-center size-10 rounded-xl bg-slate-900 border border-slate-700">
				<div 
					class="size-3.5 rounded-full {activeOperations.length > 0 ? 'bg-cyan-400 pulse-active' : 'bg-slate-500 pulse-idle'}"
					aria-label={activeOperations.length > 0 ? "Fleet Active pulse" : "Fleet Idle breath"}
				></div>
			</div>
			
			<div>
				<div class="flex items-center gap-2">
					<h1 class="text-xl font-bold tracking-tight text-white">COMMAND CENTER</h1>
					<span class="text-[10px] uppercase font-mono tracking-widest text-cyan-400 px-1.5 py-0.5 rounded bg-cyan-950 border border-cyan-800/40">Live Fleet Monitor</span>
				</div>
				<p class="text-xs text-slate-400 mt-0.5">
					{greeting}, <span class="text-slate-200 font-semibold">{displayName}</span>. Telemetry operational.
				</p>
			</div>
		</div>

		<!-- QUICK GENERAL ACTIONS -->
		<div class="flex items-center flex-wrap gap-2 z-10">
			<button 
				onclick={() => goto(`/workspaces/${slug}/agents/quickstart`)}
				class="interactive-target text-xs font-semibold px-4 py-2 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-500 hover:to-cyan-400 text-white rounded-lg flex items-center gap-2 shadow-lg shadow-cyan-950/30 active:scale-[0.98]"
			>
				<Sparkles class="size-3.5" />
				Get started with agents
			</button>
			<button 
				onclick={() => goto('/workbench')}
				class="interactive-target text-xs font-semibold px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 hover:border-slate-600 rounded-lg flex items-center gap-1.5 active:scale-[0.98]"
			>
				<MessageSquare class="size-3.5" />
				Workbench
			</button>
			<button 
				onclick={() => goto(`/workspaces/${slug}/settings/keys`)}
				class="interactive-target text-xs font-semibold px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 hover:border-slate-600 rounded-lg flex items-center gap-1.5 active:scale-[0.98]"
			>
				<KeyRound class="size-3.5" />
				API Keys
			</button>
			{#if isPolling}
				<RefreshCw class="size-3.5 text-cyan-400 animate-spin ml-2" />
			{/if}
		</div>
	</header>

	<!-- SYSTEM HEALTH INTEGRATED STATUS BANNER -->
	<section class="glass-card rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4 border-l-4 border-l-cyan-400">
		<div class="flex items-center gap-6">
			<div class="flex items-center gap-2.5">
				<span class="text-xs text-slate-400 uppercase tracking-wider font-mono">SYSTEM STATUS:</span>
				<div class="flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-bold {healthStatus.colorClass}">
					<span class="size-2 rounded-full {healthStatus.bgPulse} animate-pulse"></span>
					{healthStatus.label} ({healthStatus.percent}%)
				</div>
			</div>
			
			<div class="h-4 w-px bg-slate-800 hidden sm:block"></div>

			<div class="flex items-center gap-2 text-xs">
				<span class="text-slate-400 font-mono">ACTIVE FLEET:</span>
				<span class="font-bold text-white font-mono bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
					{dashboard?.stats?.activeSessions ?? 0} / 50
				</span>
			</div>

			<div class="h-4 w-px bg-slate-800 hidden sm:block"></div>

			<div class="flex items-center gap-2 text-xs">
				<span class="text-slate-400 font-mono font-medium">TOKENS (7d):</span>
				<span class="font-bold text-cyan-400 font-mono">
					{((dashboard?.stats?.tokensOut7d ?? 0) + (dashboard?.stats?.tokensIn7d ?? 0)).toLocaleString()}
				</span>
			</div>
		</div>

		{#if pollError}
			<div class="flex items-center gap-1.5 text-xs text-rose-400 bg-rose-950/20 border border-rose-900/30 px-3 py-1 rounded-lg">
				<AlertTriangle class="size-3.5" />
				<span>Telemetry lag: {pollError}</span>
			</div>
		{/if}
	</section>

	<!-- MAIN WORKSPACE COMMAND CONTROL GRID -->
	<main class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
		
		<!-- COLUMN 1: FLEET RADAR / LIVE OPERATIONS (Left 7 Cols) -->
		<section class="lg:col-span-7 flex flex-col gap-4">
			<div class="glass-card rounded-2xl p-5 flex flex-col gap-4 relative">
				<div class="flex items-center justify-between border-b border-slate-800/80 pb-3">
					<div class="flex items-center gap-2">
						<Activity class="size-4.5 text-cyan-400" />
						<h2 class="text-sm font-bold uppercase tracking-wider text-slate-200">Fleet Operations Radar</h2>
					</div>
					<div class="flex items-center gap-2">
						<Badge variant="outline" class="text-[10px] bg-slate-900 font-mono text-cyan-400 border-cyan-500/20">
							{activeOperations.length} operational now
						</Badge>
					</div>
				</div>

				<!-- ACTIVE OPERATIONS LIST (Progressive disclosure) -->
				{#if activeOperations.length === 0}
					<div class="flex flex-col items-center justify-center py-12 px-4 rounded-xl border border-dashed border-slate-800 bg-slate-900/20">
						<Terminal class="size-8 text-slate-600 mb-3" />
						<h3 class="text-sm font-semibold text-slate-400">All Nodes Silent</h3>
						<p class="text-xs text-slate-500 text-center mt-1 max-w-xs">
							No agent sessions, workflow executions, or dev environments are active on the cluster.
						</p>
						<button 
							onclick={() => goto(`/workspaces/${slug}/sessions/new`)}
							class="interactive-target text-xs font-semibold mt-4 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-400 rounded-md border border-slate-700 hover:border-cyan-500/30 flex items-center gap-1.5"
						>
							<Plus class="size-3.5" /> Start new session
						</button>
					</div>
				{:else}
					<div class="flex flex-col gap-2 max-h-[580px] overflow-y-auto scrollbar-custom pr-1.5">
						{#each activeOperations as op (op.id)}
							<div class="rounded-xl border border-slate-800/60 bg-slate-950/40 hover:bg-slate-900/30 overflow-hidden transition-all duration-200">
								<!-- ROW HEADER (Keyboard accessible trigger) -->
								<button 
									onclick={() => toggleExpand(op.id)}
									class="interactive-target w-full text-left p-3.5 flex items-center justify-between gap-3 text-slate-200"
									aria-expanded={expandedItems[op.id] ? "true" : "false"}
								>
									<div class="flex items-center gap-3 min-w-0 flex-1">
										<span class="text-lg bg-slate-900/80 size-8 rounded-lg border border-slate-800 flex items-center justify-center shrink-0">
											{op.avatar}
										</span>
										<div class="min-w-0">
											<div class="text-sm font-bold truncate pr-2 text-white">
												{op.name}
											</div>
											<div class="text-[10px] text-slate-400 font-mono mt-0.5 flex items-center gap-1.5">
												<span class="uppercase tracking-wider text-slate-500">{op.type}</span>
												<span>·</span>
												<span>{formatRelative(op.startedAt)}</span>
											</div>
										</div>
									</div>

									<div class="flex items-center gap-2">
										<span class="text-[10px] uppercase font-mono tracking-wider font-bold px-2 py-0.5 rounded-full border {op.badgeClass}">
											{op.status}
										</span>
										{#if expandedItems[op.id]}
											<ChevronUp class="size-4 text-slate-500 shrink-0" />
										{:else}
											<ChevronDown class="size-4 text-slate-500 shrink-0" />
										{/if}
									</div>
								</button>

								<!-- PROGRESSIVE DISCLOSURE COLLAPSIBLE DETAILS -->
								{#if expandedItems[op.id]}
									<div class="border-t border-slate-900 bg-slate-950/60 p-4 text-xs flex flex-col gap-3">
										
										<!-- Case: Session details -->
										{#if op.type === 'session'}
											<div class="grid grid-cols-2 gap-4">
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Session UID</div>
													<div class="font-mono text-slate-300 select-all mt-0.5 break-all">{op.raw.id}</div>
												</div>
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Agent Associated</div>
													<div class="text-slate-300 font-semibold mt-0.5">{op.raw.agentName}</div>
												</div>
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Initialization Time</div>
													<div class="text-slate-300 mt-0.5">{new Date(op.raw.createdAt).toLocaleString()}</div>
												</div>
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Last Interaction</div>
													<div class="text-slate-300 mt-0.5">{formatRelative(op.raw.updatedAt)}</div>
												</div>
											</div>
											<div class="flex justify-end gap-2 border-t border-slate-900 pt-3 mt-1">
												<a 
													href="/workspaces/{slug}/sessions/{op.raw.id}"
													class="interactive-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs active:scale-[0.98]"
												>
													<Terminal class="size-3.5" />
													Open Live Stream
												</a>
											</div>

										<!-- Case: Workflow details -->
										{:else if op.type === 'workflow'}
											<div class="grid grid-cols-2 gap-4">
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Execution UID</div>
													<div class="font-mono text-slate-300 select-all mt-0.5 break-all">{op.raw.executionId}</div>
												</div>
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">In-flight Status</div>
													<div class="text-slate-300 font-semibold mt-0.5 flex items-center gap-1">
														<span class="size-1.5 rounded-full bg-cyan-400 animate-ping"></span>
														{op.raw.status}
													</div>
												</div>
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Active Sessions</div>
													<div class="text-slate-300 mt-0.5 font-mono">{op.raw.sessionCount} session(s) launched</div>
												</div>
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Execution Duration</div>
													<div class="text-slate-300 mt-0.5 font-mono">{op.raw.durationMs ? `${(op.raw.durationMs/1000).toFixed(1)}s` : 'Calculating...'}</div>
												</div>
											</div>
											<div class="flex justify-end gap-2 border-t border-slate-900 pt-3 mt-1">
												<a 
													href="/workspaces/{slug}/workflows/{op.raw.workflowId}/runs/{op.raw.executionId}"
													class="interactive-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-semibold text-xs active:scale-[0.98]"
												>
													<Zap class="size-3.5" />
													View Workflow Logs
												</a>
											</div>

										<!-- Case: Dev Preview Space details -->
										{:else if op.type === 'devenvs'}
											<div class="grid grid-cols-2 gap-4">
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Sandbox Namespace</div>
													<div class="font-mono text-slate-300 mt-0.5 select-all">{op.raw.sandboxName || 'Provisioning'}</div>
												</div>
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Bound Session</div>
													<div class="text-slate-300 mt-0.5 font-mono">{op.raw.sessionId ? op.raw.sessionId.slice(0,12) : 'None bound'}</div>
												</div>
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">Network Port & IP</div>
													<div class="text-slate-300 mt-0.5 font-mono">{op.raw.podIP || '---'}:{op.raw.port || '---'}</div>
												</div>
												<div>
													<div class="text-slate-500 font-mono text-[9px] uppercase tracking-wider">VCluster Workspace</div>
													<div class="text-slate-300 mt-0.5 truncate select-all">{op.raw.workspaceRef}</div>
												</div>
											</div>
											<div class="flex justify-end gap-2 border-t border-slate-900 pt-3 mt-1">
												{#if op.raw.sessionId}
													<a 
														href="/workspaces/{slug}/sessions/{op.raw.sessionId}"
														class="interactive-target inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 text-xs font-semibold active:scale-[0.98]"
													>
														Interactive Coding Session
													</a>
												{/if}
												{#if op.raw.browseUrl}
													<a 
														href={op.raw.browseUrl}
														target="_blank"
														rel="noreferrer"
														class="interactive-target inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold text-xs active:scale-[0.98]"
													>
														<ExternalLink class="size-3.5" />
														Browse Live Preview
													</a>
												{/if}
											</div>
										{/if}

									</div>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</section>

		<!-- COLUMN 2: TELEMETRY & CHRONICLE (Right 5 Cols) -->
		<section class="lg:col-span-5 flex flex-col gap-6">
			
			<!-- SECTION A: INTEGRATED FLEET TELEMETRY & CAPACITY -->
			<div class="glass-card rounded-2xl p-5 flex flex-col gap-4">
				<div class="flex items-center gap-2 border-b border-slate-800/80 pb-3">
					<Cpu class="size-4.5 text-cyan-400" />
					<h2 class="text-sm font-bold uppercase tracking-wider text-slate-200">System Telemetry & Cost</h2>
				</div>

				<div class="flex flex-col gap-4">
					<!-- Resource pressure (Kubernetes averages) -->
					{#if capacityDetails}
						<div class="grid grid-cols-2 gap-3 bg-slate-950/40 p-3 rounded-xl border border-slate-800/50">
							<div>
								<div class="text-[10px] text-slate-500 font-mono uppercase tracking-wider">Cluster</div>
								<div class="text-xs font-bold text-white mt-0.5">{capacityDetails.cluster}</div>
							</div>
							<div>
								<div class="text-[10px] text-slate-500 font-mono uppercase tracking-wider">Kueue Queues</div>
								<div class="text-xs font-bold text-white mt-0.5 font-mono">
									{capacityDetails.admissionActive} / {capacityDetails.admissionTotal} Active
								</div>
							</div>
							<div class="col-span-2">
								<div class="flex justify-between text-[10px] text-slate-500 font-mono uppercase tracking-wider">
									<span>Avg Node Pressure</span>
									<span class="text-cyan-400 font-bold">{capacityDetails.avgNodePressure}%</span>
								</div>
								<div class="h-2 w-full bg-slate-900 rounded mt-1 overflow-hidden border border-slate-800">
									<div class="h-full bg-cyan-500 rounded" style="width: {capacityDetails.avgNodePressure}%"></div>
								</div>
							</div>
						</div>
					{:else}
						<div class="text-xs text-slate-500 py-1 font-medium bg-slate-900/30 border border-slate-800/60 p-2.5 rounded-lg">
							Cluster observer snapshot offline. Running in standalone fallback.
						</div>
					{/if}

					<!-- Token allocation -->
					<div class="flex flex-col gap-1.5">
						<div class="flex justify-between text-xs text-slate-400 font-mono font-medium">
							<span>7-Day Token Footprint</span>
							<span class="text-slate-200">
								{#if (dashboard?.stats?.tokensOut7d ?? 0) > 0}
									{((dashboard?.stats?.tokensOut7d ?? 0) + (dashboard?.stats?.tokensIn7d ?? 0)).toLocaleString()} / 10M Limit
								{:else}
									<span class="text-slate-500 font-mono italic">No usage logged</span>
								{/if}
							</span>
						</div>
						<div class="h-2 w-full bg-slate-900 rounded overflow-hidden border border-slate-800">
							{#if (dashboard?.stats?.tokensOut7d ?? 0) > 0}
								<div 
									class="h-full bg-gradient-to-r from-cyan-500 to-indigo-500 rounded" 
									style="width: {Math.min(100, (((dashboard?.stats?.tokensOut7d ?? 0) + (dashboard?.stats?.tokensIn7d ?? 0)) / 10000000) * 100)}%"
								></div>
							{/if}
						</div>
						<div class="flex justify-between text-[10px] text-slate-500 font-mono">
							<span>IN: {(dashboard?.stats?.tokensIn7d ?? 0).toLocaleString()}</span>
							<span>OUT: {(dashboard?.stats?.tokensOut7d ?? 0).toLocaleString()}</span>
						</div>
					</div>

					<div class="h-px bg-slate-800/80 my-1"></div>

					<!-- Cost footprint and Vault details -->
					<div class="flex flex-col gap-2.5">
						<div class="flex justify-between items-center text-xs">
							<span class="text-slate-400 flex items-center gap-1.5">
								<Coins class="size-3.5 text-amber-500" />
								Estimated Expense (7d)
							</span>
							<span class="font-bold text-white font-mono">
								${(((dashboard?.stats?.tokensOut7d ?? 0) * 15 + (dashboard?.stats?.tokensIn7d ?? 0) * 3) / 1000000).toFixed(2)}
							</span>
						</div>
						<div class="flex justify-between items-center text-xs">
							<span class="text-slate-400 flex items-center gap-1.5">
								<Lock class="size-3.5 text-emerald-400" />
								Mounted Secure Credentials
							</span>
							<span class="font-bold text-slate-200 font-mono bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
								{dashboard?.stats?.totalVaults ?? 0} vaults active
							</span>
						</div>
						<div class="flex justify-between items-center text-xs">
							<span class="text-slate-400 flex items-center gap-1.5">
								<Layers class="size-3.5 text-indigo-400" />
								Provisioned Environments
							</span>
							<span class="font-bold text-slate-200 font-mono bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
								{dashboard?.stats?.totalEnvironments ?? 0} templates
							</span>
						</div>
					</div>
				</div>
			</div>

			<!-- SECTION B: OPERATIONAL CHRONICLE TIMELINE (ACTIVE VOICE) -->
			<div class="glass-card rounded-2xl p-5 flex flex-col gap-4">
				<div class="flex items-center justify-between border-b border-slate-800/80 pb-3">
					<div class="flex items-center gap-2">
						<Server class="size-4.5 text-cyan-400" />
						<h2 class="text-sm font-bold uppercase tracking-wider text-slate-200">Workspace Chronology</h2>
					</div>
					<button 
						onclick={() => pollData(false)}
						class="interactive-target text-slate-500 hover:text-cyan-400 font-semibold text-[10px] uppercase font-mono tracking-wider flex items-center gap-1"
					>
						<RefreshCw class="size-3" /> Refresh
					</button>
				</div>

				<!-- ACTIVITY FEED -->
				{#if recentChronicle.length === 0}
					<div class="text-center text-xs text-slate-500 py-10">
						No chronicle logs recorded in this workspace environment.
					</div>
				{:else}
					<div class="flex flex-col gap-3">
						{#each recentChronicle as change (change.id)}
							<div class="flex items-start gap-2.5 text-xs text-slate-300">
								<span 
									class="text-[9px] px-1.5 py-0.5 border font-mono rounded shrink-0 font-bold mt-0.5 {change.badgeClass}"
								>
									{change.badgeLabel}
								</span>
								<div class="flex-1 min-w-0">
									<p class="leading-relaxed break-words text-slate-200 font-medium">
										{change.description}
									</p>
									<span class="text-[10px] text-slate-500 block mt-0.5 font-mono">
										{formatRelative(change.time)}
									</span>
								</div>
								{#if change.link !== '#'}
									<a 
										href={change.link} 
										class="interactive-target p-1 text-slate-500 hover:text-cyan-400 rounded shrink-0"
										aria-label="Drill down to details"
									>
										<ExternalLink class="size-3.5" />
									</a>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

		</section>

	</main>

	<!-- BOTTOM GRID: DETAILED RESOURCE CONTROLS -->
	<section class="glass-card rounded-2xl p-5 flex flex-col gap-4">
		<div class="border-b border-slate-800/80 pb-3 flex items-center gap-2">
			<Settings class="size-4.5 text-cyan-400" />
			<h2 class="text-sm font-bold uppercase tracking-wider text-slate-200">System Quick Actions</h2>
		</div>

		<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
			<button 
				onclick={() => goto(`/workspaces/${slug}/agents/new`)}
				class="interactive-target p-4 rounded-xl border border-slate-800 bg-slate-950/40 hover:bg-slate-900/30 hover:border-cyan-500/30 text-left transition-all group active:scale-[0.98]"
			>
				<Bot class="size-5 text-cyan-400 group-hover:scale-110 transition-transform duration-200" />
				<h3 class="text-xs font-bold text-white mt-2">Publish New Agent</h3>
				<p class="text-[10px] text-slate-400 mt-0.5 leading-normal">
					Build versioned configurations and configure capabilities.
				</p>
			</button>

			<button 
				onclick={() => goto(`/workspaces/${slug}/sessions/new`)}
				class="interactive-target p-4 rounded-xl border border-slate-800 bg-slate-950/40 hover:bg-slate-900/30 hover:border-cyan-500/30 text-left transition-all group active:scale-[0.98]"
			>
				<Play class="size-5 text-emerald-400 group-hover:scale-110 transition-transform duration-200" />
				<h3 class="text-xs font-bold text-white mt-2">Spawn Session</h3>
				<p class="text-[10px] text-slate-400 mt-0.5 leading-normal">
					Instantiate an interactive runtime window directly.
				</p>
			</button>

			<button 
				onclick={() => goto(`/workspaces/${slug}/environments/new`)}
				class="interactive-target p-4 rounded-xl border border-slate-800 bg-slate-950/40 hover:bg-slate-900/30 hover:border-cyan-500/30 text-left transition-all group active:scale-[0.98]"
			>
				<Layers class="size-5 text-indigo-400 group-hover:scale-110 transition-transform duration-200" />
				<h3 class="text-xs font-bold text-white mt-2">Provision Dev Space</h3>
				<p class="text-[10px] text-slate-400 mt-0.5 leading-normal">
					Configure sandbox containers and network namespaces.
				</p>
			</button>

			<button 
				onclick={() => goto(`/workspaces/${slug}/credentials`)}
				class="interactive-target p-4 rounded-xl border border-slate-800 bg-slate-950/40 hover:bg-slate-900/30 hover:border-cyan-500/30 text-left transition-all group active:scale-[0.98]"
			>
				<Lock class="size-5 text-amber-500 group-hover:scale-110 transition-transform duration-200" />
				<h3 class="text-xs font-bold text-white mt-2">Mount Secret Vault</h3>
				<p class="text-[10px] text-slate-400 mt-0.5 leading-normal">
					Store credentials and tokens securely for integration.
				</p>
			</button>
		</div>
	</section>

</div>
