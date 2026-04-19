<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';

	type RuntimeStatus = {
		name?: string;
		exists?: boolean;
		spec?: {
			agentSlug?: string;
			appId?: string;
			environment?: { imageTag?: string };
			mcpServers?: Array<{ name: string }>;
			lifecycle?: { idleTtlSeconds?: number };
		};
		status?: {
			phase?: 'Pending' | 'Sleeping' | 'Starting' | 'Active' | 'Failed' | string;
			replicas?: number;
			readyReplicas?: number;
			deploymentRef?: string;
			lastActiveAt?: string;
			message?: string;
		};
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
			{#if status?.status?.phase}
				<span
					class="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
				>
					<span class={`h-1.5 w-1.5 rounded-full ${phaseColor(status.status.phase)}`}></span>
					{status.status.phase}
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

	{#if status?.spec}
		<dl class="grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
			<dt class="text-muted-foreground">App id</dt>
			<dd class="col-span-2 font-mono">{status.spec.appId ?? `agent-runtime-${slug}`}</dd>

			<dt class="text-muted-foreground">Image</dt>
			<dd
				class="col-span-2 font-mono break-all text-[11px]"
				title={status.spec.environment?.imageTag}
			>
				{status.spec.environment?.imageTag?.split('/').pop() ?? '—'}
			</dd>

			<dt class="text-muted-foreground">MCPs</dt>
			<dd class="col-span-2">
				{#if status.spec.mcpServers?.length}
					{status.spec.mcpServers.map((s) => s.name).join(', ')}
				{:else}
					<span class="text-muted-foreground">none</span>
				{/if}
			</dd>

			<dt class="text-muted-foreground">Replicas</dt>
			<dd class="col-span-2">
				{status.status?.readyReplicas ?? 0}/{status.status?.replicas ?? 0}
			</dd>

			<dt class="text-muted-foreground">Last active</dt>
			<dd class="col-span-2">{relativeTime(status.status?.lastActiveAt)}</dd>

			<dt class="text-muted-foreground">Idle TTL</dt>
			<dd class="col-span-2">
				{((status.spec.lifecycle?.idleTtlSeconds ?? 1800) / 60).toFixed(0)} min
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
				disabled={busy !== null || status?.status?.phase === 'Active'}
				onclick={wake}
			>
				{busy === 'wake' ? 'Waking…' : 'Wake'}
			</Button>
			{#if isAdmin}
				<Button
					size="sm"
					variant="outline"
					disabled={busy !== null || (status?.status?.replicas ?? 0) === 0}
					onclick={sleep}
				>
					{busy === 'sleep' ? 'Sleeping…' : 'Sleep now'}
				</Button>
			{/if}
		</div>
	{/if}
</div>
