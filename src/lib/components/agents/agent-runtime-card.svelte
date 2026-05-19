<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import HeadlampLogo from '$lib/components/gitops/icons/HeadlampLogo.svelte';
	import { DEFAULT_HEADLAMP_URL, headlampCustomResourceUrl, headlampResourceUrl } from '$lib/headlamp/links';

	type RuntimeStatus = {
		name?: string;
		namespace?: string;
		exists?: boolean;
		phase?: 'Pending' | 'Sleeping' | 'Starting' | 'Active' | 'Failed' | string;
		replicas?: number;
		readyReplicas?: number;
		desiredReplicas?: number;
		sandboxTemplateRef?: string;
		spec?: {
			agentSlug?: string;
			appId?: string;
			environment?: { imageTag?: string };
			mcpServers?: Array<{ name: string }>;
			lifecycle?: { idleTtlSeconds?: number };
			browserSidecar?: { enabled?: boolean };
		};
		status?: {
			phase?: 'Pending' | 'Sleeping' | 'Starting' | 'Active' | 'Failed' | string;
			replicas?: number;
			readyReplicas?: number;
			deploymentRef?: string;
			lastActiveAt?: string;
			message?: string;
		};
		browserSidecarEnabled?: boolean;
		browserMcpAvailable?: boolean;
		pod?: { name: string; containers: Array<{ name: string; ready: boolean }> } | null;
	};

	let {
		slug,
		isAdmin = false,
		canManage = true
	}: { slug: string; isAdmin?: boolean; canManage?: boolean } = $props();

	let status = $state<RuntimeStatus | null>(null);
	let loading = $state(true);
	let err = $state<string | null>(null);
	let busy = $state<'wake' | 'sleep' | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;
	const phase = $derived(status?.status?.phase ?? status?.phase);
	const replicas = $derived(status?.status?.replicas ?? status?.replicas ?? 0);
	const readyReplicas = $derived(
		status?.status?.readyReplicas ?? status?.readyReplicas ?? 0
	);
	const lastActiveAt = $derived(status?.status?.lastActiveAt);
	const poolHeadlampUrl = $derived(
		status?.name
			? headlampCustomResourceUrl({
					headlampBase: DEFAULT_HEADLAMP_URL,
					cluster: 'ryzen',
					crd: 'sandboxwarmpools.extensions.agents.x-k8s.io',
					namespace: status.namespace ?? 'workflow-builder',
					name: status.name
				})
			: null
	);
	const podHeadlampUrl = $derived(
		status?.pod?.name
			? headlampResourceUrl({
					headlampBase: DEFAULT_HEADLAMP_URL,
					cluster: 'ryzen',
					kind: 'Pod',
					namespace: status.namespace ?? 'workflow-builder',
					name: status.pod.name
				})
			: null
	);

	async function refresh() {
		try {
			const res = await fetch(`/api/v1/agent-runtimes/${encodeURIComponent(slug)}`);
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			status = (await res.json()) as RuntimeStatus;
			err = null;
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function wake() {
		busy = 'wake';
		try {
			await fetch(`/api/v1/agent-runtimes/${encodeURIComponent(slug)}/wake`, {
				method: 'POST'
			});
			await refresh();
		} finally {
			busy = null;
		}
	}

	async function sleep() {
		busy = 'sleep';
		try {
			await fetch(`/api/v1/agent-runtimes/${encodeURIComponent(slug)}/sleep`, {
				method: 'POST'
			});
			await refresh();
		} finally {
			busy = null;
		}
	}

	function phaseColor(phase: string | undefined): string {
		switch (phase) {
			case 'Active':
				return 'bg-emerald-500';
			case 'Starting':
				return 'bg-amber-500 animate-pulse';
			case 'Sleeping':
				return 'bg-slate-500';
			case 'Failed':
				return 'bg-red-600';
			case 'Pending':
				return 'bg-sky-500';
			default:
				return 'bg-slate-400';
		}
	}

	function relativeTime(iso: string | undefined): string {
		if (!iso) return '—';
		const then = new Date(iso).getTime();
		const now = Date.now();
		const diff = Math.max(0, now - then);
		const sec = Math.floor(diff / 1000);
		if (sec < 60) return `${sec}s ago`;
		const min = Math.floor(sec / 60);
		if (min < 60) return `${min}m ago`;
		const hr = Math.floor(min / 60);
		if (hr < 24) return `${hr}h ago`;
		const day = Math.floor(hr / 24);
		return `${day}d ago`;
	}

	onMount(() => {
		void refresh();
		timer = setInterval(() => {
			void refresh();
		}, 10_000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

<div class="rounded-lg border bg-card p-4 space-y-3">
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-2">
			<span class="text-sm font-semibold">Runtime</span>
			{#if phase}
				<span
					class="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
				>
					<span class={`h-1.5 w-1.5 rounded-full ${phaseColor(phase)}`}></span>
					{phase}
				</span>
			{:else if loading}
				<span class="text-xs text-muted-foreground">loading…</span>
			{/if}
		</div>
		<button
			type="button"
			class="text-xs text-muted-foreground hover:underline"
			onclick={() => refresh()}
			disabled={loading}
			aria-label="Refresh runtime status"
		>
			refresh
		</button>
	</div>

	{#if err}
		<p class="text-xs text-destructive">Error: {err}</p>
	{/if}

	{#if status?.exists === false}
		<p class="text-xs text-muted-foreground">
			No AgentRuntime materialized yet. Publish the agent to create one (or click Wake).
		</p>
	{/if}

	{#if status?.spec || status?.exists}
		<dl class="grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
			<dt class="text-muted-foreground">App id</dt>
			<dd class="col-span-2 font-mono">{status.spec?.appId ?? `agent-runtime-${slug}`}</dd>

			<dt class="text-muted-foreground">Image</dt>
			<dd
				class="col-span-2 font-mono break-all text-[11px]"
				title={status.spec?.environment?.imageTag}
			>
				{status.spec?.environment?.imageTag?.split('/').pop() ?? '—'}
			</dd>

			<dt class="text-muted-foreground">MCPs</dt>
			<dd class="col-span-2">
				{#if status.spec?.mcpServers?.length}
					{status.spec.mcpServers.map((s) => s.name).join(', ')}
				{:else}
					<span class="text-muted-foreground">none</span>
				{/if}
			</dd>

			<dt class="text-muted-foreground">Browser</dt>
			<dd class="col-span-2">
				{#if status.browserSidecarEnabled}
					<span class="inline-flex items-center gap-1">
						<span aria-hidden="true">🌐</span>
						Sidecar enabled
						<span class="text-muted-foreground/70">(chromium + playwright-mcp)</span>
					</span>
				{:else}
					<span class="text-muted-foreground">none</span>
				{/if}
			</dd>

			<dt class="text-muted-foreground">Replicas</dt>
			<dd class="col-span-2">
				{readyReplicas}/{replicas}
			</dd>

			{#if poolHeadlampUrl}
				<dt class="text-muted-foreground">Headlamp</dt>
				<dd class="col-span-2 flex flex-wrap gap-1">
					<a
						href={poolHeadlampUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
						title="Open SandboxWarmPool in Headlamp"
					>
						<HeadlampLogo class="h-3 w-3" />
						Pool
					</a>
					{#if podHeadlampUrl}
						<a
							href={podHeadlampUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
							title="Open active runtime Pod in Headlamp"
						>
							<HeadlampLogo class="h-3 w-3" />
							Pod
						</a>
					{/if}
				</dd>
			{/if}

			{#if status.pod?.containers?.length}
				<dt class="text-muted-foreground">Containers</dt>
				<dd class="col-span-2 flex flex-wrap gap-1">
					{#each status.pod.containers as c (c.name)}
						<span
							title={c.ready ? 'Ready' : 'Not ready'}
							class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] {c.ready
								? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
								: 'border-muted-foreground/30 text-muted-foreground'}"
						>
							<span
								class="inline-block size-1.5 rounded-full {c.ready
									? 'bg-emerald-500'
									: 'bg-muted-foreground/40'}"
								aria-hidden="true"
							></span>
							{c.name}
						</span>
					{/each}
				</dd>
			{/if}

			<dt class="text-muted-foreground">Last active</dt>
			<dd class="col-span-2">{relativeTime(lastActiveAt)}</dd>

			<dt class="text-muted-foreground">Idle TTL</dt>
			<dd class="col-span-2">
				{((status.spec?.lifecycle?.idleTtlSeconds ?? 1800) / 60).toFixed(0)} min
			</dd>
		</dl>
	{/if}

	{#if status?.status?.message}
		<p class="text-xs text-muted-foreground italic">{status.status.message}</p>
	{/if}

	{#if canManage}
		<div class="flex gap-2 pt-1">
			<Button
				size="sm"
				variant="outline"
				disabled={busy !== null || phase === 'Active'}
				onclick={wake}
			>
				{busy === 'wake' ? 'Waking…' : 'Wake'}
			</Button>
			{#if isAdmin}
				<Button
					size="sm"
					variant="outline"
					disabled={busy !== null || replicas === 0}
					onclick={sleep}
				>
					{busy === 'sleep' ? 'Sleeping…' : 'Sleep now'}
				</Button>
			{/if}
		</div>
	{/if}
</div>
