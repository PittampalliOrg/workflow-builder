<script lang="ts">
	import { onMount } from 'svelte';
	import {
		RefreshCw,
		AlertTriangle,
		CircleCheck,
		Boxes,
		Server,
		Wrench,
		Sparkles
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import InspectablePayload from '$lib/components/inspectable-payload.svelte';
	import { cn } from '$lib/components/ui/utils';

	// Structurally-loose view of the /api/agents/[id]/compiled response. The
	// authoritative type lives server-side in
	// $lib/server/agents/compiled-capabilities.ts (can't be imported here without
	// pulling server code into the browser bundle).
	type SwapDrop = { capability: string; severity: 'reject' | 'warn'; detail: string };
	type CompiledMcpServer = {
		serverName?: string;
		server_name?: string;
		name?: string;
		displayName?: string;
		pieceName?: string;
		sourceType?: string;
		transport?: string;
		url?: string;
		serverUrl?: string;
		allowedTools?: string[];
		headers?: Record<string, string>;
	};
	type BundleProvenanceEntry = {
		id: string;
		name: string;
		version: number;
		mcpServers: string[];
		skills: string[];
		tools: string[];
		builtinTools: string[];
	};
	type Compiled = {
		agent: { id: string; slug: string; name: string; rowRuntime: string };
		resolvedRuntime: string | null;
		runtimeMismatch: boolean;
		runtimeDescriptor: {
			id: string;
			family: string;
			capabilities: Record<string, unknown>;
		} | null;
		mcpServers: CompiledMcpServer[];
		mcpServerCount: number;
		skills: unknown[];
		tools: string[];
		builtinTools: string[];
		bundleRefs: Array<{ id: string; version?: number }>;
		bundleProvenance: BundleProvenanceEntry[];
		swapVerdict: { decision: 'allow' | 'warn' | 'reject'; drops: SwapDrop[] } | null;
		warnings: string[];
	};

	let { agentId, class: className = '' }: { agentId: string; class?: string } = $props();

	let loading = $state(true);
	let error = $state<string | null>(null);
	let data = $state<Compiled | null>(null);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/agents/${agentId}/compiled`);
			if (!res.ok) {
				error = `Failed to compile (${res.status})`;
				data = null;
				return;
			}
			const body = await res.json();
			data = body.compiled as Compiled;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to compile';
			data = null;
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function mcpLabel(s: CompiledMcpServer): string {
		return (
			s.displayName ?? s.serverName ?? s.server_name ?? s.name ?? s.pieceName ?? 'server'
		);
	}
	function mcpUrl(s: CompiledMcpServer): string {
		return s.url ?? s.serverUrl ?? '';
	}
	function skillLabel(s: unknown): string {
		if (typeof s === 'string') return s;
		const r = (s ?? {}) as Record<string, unknown>;
		return String(r.slug ?? r.registryId ?? r.name ?? JSON.stringify(s));
	}
	const drops = $derived(data?.swapVerdict?.drops ?? []);
	const rejectDrops = $derived(drops.filter((d) => d.severity === 'reject'));
	const warnDrops = $derived(drops.filter((d) => d.severity === 'warn'));
</script>

<div class={cn('space-y-4', className)}>
	<div class="flex items-center justify-between">
		<div>
			<h3 class="text-sm font-semibold">Compiled capabilities</h3>
			<p class="text-xs text-muted-foreground">
				The effective configuration the runtime receives at spawn — flattened bundles +
				project-resolved MCP servers + swap-safety. Secrets are redacted.
			</p>
		</div>
		<button
			class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
			onclick={load}
			disabled={loading}
		>
			<RefreshCw class={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
			Refresh
		</button>
	</div>

	{#if loading && !data}
		<p class="text-sm text-muted-foreground">Compiling…</p>
	{:else if error}
		<div class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
			{error}
		</div>
	{:else if data}
		<!-- Runtime + swap-safety -->
		<div class="rounded-md border p-3">
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<span class="text-muted-foreground">Resolved runtime</span>
				<Badge variant="secondary" class="font-mono">{data.resolvedRuntime ?? '—'}</Badge>
				{#if data.runtimeDescriptor}
					<span class="text-xs text-muted-foreground">family</span>
					<Badge variant="outline">{data.runtimeDescriptor.family}</Badge>
				{/if}
				{#if data.runtimeMismatch}
					<Badge variant="destructive" class="gap-1">
						<AlertTriangle class="h-3 w-3" />
						runtime ≠ agent.runtime ({data.agent.rowRuntime})
					</Badge>
				{/if}
			</div>

			{#if rejectDrops.length > 0 || warnDrops.length > 0}
				<div class="mt-3 space-y-1.5">
					{#each rejectDrops as d (d.capability + d.detail)}
						<div class="flex items-start gap-2 text-xs">
							<Badge variant="destructive">reject · {d.capability}</Badge>
							<span class="text-muted-foreground">{d.detail}</span>
						</div>
					{/each}
					{#each warnDrops as d (d.capability + d.detail)}
						<div class="flex items-start gap-2 text-xs">
							<Badge variant="outline" class="border-amber-500/50 text-amber-600 dark:text-amber-400"
								>warn · {d.capability}</Badge
							>
							<span class="text-muted-foreground">{d.detail}</span>
						</div>
					{/each}
				</div>
			{:else}
				<div class="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
					<CircleCheck class="h-3.5 w-3.5 text-emerald-500" />
					No capability drops — the runtime satisfies the agent's declared capabilities.
				</div>
			{/if}
		</div>

		<!-- MCP servers -->
		<div class="rounded-md border p-3">
			<div class="mb-2 flex items-center gap-1.5 text-sm font-medium">
				<Server class="h-4 w-4 text-muted-foreground" />
				MCP servers
				<Badge variant="secondary">{data.mcpServerCount}</Badge>
			</div>
			{#if data.mcpServers.length === 0}
				<p class="text-xs text-muted-foreground">No MCP servers resolved.</p>
			{:else}
				<ul class="space-y-2">
					{#each data.mcpServers as s, i (i)}
						<li class="rounded border bg-muted/30 p-2">
							<div class="flex flex-wrap items-center gap-2 text-sm">
								<span class="font-medium">{mcpLabel(s)}</span>
								{#if s.transport}
									<Badge variant="outline" class="font-mono text-[10px]">{s.transport}</Badge>
								{/if}
								{#if s.sourceType}
									<Badge variant="secondary" class="text-[10px]">{s.sourceType}</Badge>
								{/if}
								{#if s.allowedTools && s.allowedTools.length > 0}
									<span class="text-xs text-muted-foreground"
										>{s.allowedTools.length} tools</span
									>
								{/if}
							</div>
							{#if mcpUrl(s)}
								<div class="mt-1 truncate font-mono text-[11px] text-muted-foreground">
									{mcpUrl(s)}
								</div>
							{/if}
							{#if s.headers && Object.keys(s.headers).length > 0}
								<div class="mt-1 flex flex-wrap gap-1">
									{#each Object.entries(s.headers) as [k, v] (k)}
										<span class="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
											>{k}: {v}</span
										>
									{/each}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<!-- Skills + tools -->
		{#if data.skills.length > 0 || data.tools.length > 0 || data.builtinTools.length > 0}
			<div class="rounded-md border p-3">
				<div class="mb-2 flex items-center gap-1.5 text-sm font-medium">
					<Wrench class="h-4 w-4 text-muted-foreground" />
					Skills & tools
				</div>
				<div class="space-y-2 text-xs">
					{#if data.skills.length > 0}
						<div class="flex flex-wrap items-center gap-1">
							<span class="text-muted-foreground">skills</span>
							{#each data.skills as s, i (i)}
								<Badge variant="outline">{skillLabel(s)}</Badge>
							{/each}
						</div>
					{/if}
					{#if data.tools.length > 0}
						<div class="flex flex-wrap items-center gap-1">
							<span class="text-muted-foreground">tools</span>
							{#each data.tools as t (t)}<Badge variant="outline">{t}</Badge>{/each}
						</div>
					{/if}
					{#if data.builtinTools.length > 0}
						<div class="flex flex-wrap items-center gap-1">
							<span class="text-muted-foreground">builtin</span>
							{#each data.builtinTools as t (t)}<Badge variant="secondary">{t}</Badge>{/each}
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Bundle provenance -->
		{#if data.bundleProvenance.length > 0}
			<div class="rounded-md border p-3">
				<div class="mb-2 flex items-center gap-1.5 text-sm font-medium">
					<Boxes class="h-4 w-4 text-muted-foreground" />
					Capability bundles
				</div>
				<ul class="space-y-2">
					{#each data.bundleProvenance as b (b.id)}
						<li class="text-xs">
							<div class="flex items-center gap-2">
								<span class="font-medium">{b.name}</span>
								<Badge variant="outline" class="text-[10px]">v{b.version}</Badge>
							</div>
							<div class="mt-1 flex flex-wrap gap-1 text-muted-foreground">
								{#each b.mcpServers as m (m)}<span class="rounded bg-muted px-1 py-0.5"
										><Sparkles class="mr-0.5 inline h-2.5 w-2.5" />{m}</span
									>{/each}
								{#each b.skills as sk (sk)}<span class="rounded bg-muted px-1 py-0.5">{sk}</span
									>{/each}
								{#each b.tools as t (t)}<span class="rounded bg-muted px-1 py-0.5">{t}</span>{/each}
							</div>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<!-- Warnings -->
		{#if data.warnings.length > 0}
			<div class="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
				<div class="mb-1 flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
					<AlertTriangle class="h-3.5 w-3.5" /> Resolution warnings
				</div>
				<ul class="list-disc space-y-0.5 pl-4 text-muted-foreground">
					{#each data.warnings as w (w)}<li>{w}</li>{/each}
				</ul>
			</div>
		{/if}

		<!-- Raw resolved config -->
		<details class="rounded-md border p-3">
			<summary class="cursor-pointer text-sm font-medium">Raw compiled config (JSON)</summary>
			<div class="mt-2">
				<InspectablePayload value={data} maxHeight="max-h-[28rem]" />
			</div>
		</details>
	{/if}
</div>
