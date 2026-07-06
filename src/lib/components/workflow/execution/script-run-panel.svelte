<!--
  Run-detail surface for a dynamic-script (engineType `dynamic-script`) execution.
  Replaces the SW canvas: renders the script meta, the declared phases (current
  highlighted), the per-call journal (label/callId, phase, status, tokens, session
  link, Kill/Skip controls), and a budget bar (Σ tokensUsed vs budgetTotal).

  Polls /api/workflows/executions/[id]/script-calls (~3s) while the run is active.
-->
<script lang="ts">
	import { Loader2, ExternalLink, Ban, SkipForward } from "@lucide/svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";

	type ScriptCall = {
		callId: string;
		seq: number;
		kind: string;
		label: string | null;
		phase: string | null;
		status: string;
		sessionId: string | null;
		tokensUsed: number;
		errorCode: string | null;
		retries: number;
	};

	type Phase = { title: string };

	interface Props {
		executionId: string;
		slug: string;
		/** executionIr: { engine, script, meta:{name,description,phases,...}, args, budgetTotal } */
		executionIr: Record<string, unknown> | null;
		/** Current phase from the live custom status / execution.phase column. */
		currentPhase?: string | null;
		isRunning?: boolean;
	}

	let {
		executionId,
		slug,
		executionIr,
		currentPhase = null,
		isRunning = false,
	}: Props = $props();

	const meta = $derived.by(() => {
		const m = (executionIr?.meta ?? {}) as Record<string, unknown>;
		return {
			name: typeof m.name === "string" ? m.name : "Dynamic script",
			description: typeof m.description === "string" ? m.description : null,
			phases: normalizePhases(m.phases),
		};
	});

	function normalizePhases(raw: unknown): Phase[] {
		if (!Array.isArray(raw)) return [];
		const out: Phase[] = [];
		for (const p of raw) {
			if (typeof p === "string") out.push({ title: p });
			else if (p && typeof p === "object") {
				const t = (p as Record<string, unknown>).title;
				if (typeof t === "string") out.push({ title: t });
			}
		}
		return out;
	}

	const budgetTotal = $derived(
		typeof executionIr?.budgetTotal === "number" ? (executionIr.budgetTotal as number) : null,
	);

	let calls = $state<ScriptCall[]>([]);
	let loaded = $state(false);
	let error = $state<string | null>(null);
	let pending = $state<Record<string, boolean>>({});

	const spentTokens = $derived(calls.reduce((sum, c) => sum + (c.tokensUsed || 0), 0));
	const budgetPct = $derived(
		budgetTotal && budgetTotal > 0
			? Math.min(100, Math.round((spentTokens / budgetTotal) * 100))
			: null,
	);

	async function fetchCalls() {
		try {
			const res = await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/script-calls`,
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { scriptCalls?: ScriptCall[] };
			calls = Array.isArray(data.scriptCalls) ? data.scriptCalls : [];
			error = null;
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to load script calls";
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		// Track executionId so a navigation re-fetches.
		void executionId;
		fetchCalls();
		if (!isRunning) return;
		const t = setInterval(fetchCalls, 3000);
		return () => clearInterval(t);
	});

	function callLabel(call: ScriptCall): string {
		if (call.label) return call.label;
		return `${call.kind}·${call.callId.slice(0, 8)}`;
	}

	function statusVariant(
		status: string,
	): "default" | "secondary" | "destructive" | "outline" {
		switch (status) {
			case "done":
				return "default";
			case "running":
				return "secondary";
			case "error":
				return "destructive";
			default:
				return "outline";
		}
	}

	async function killSession(call: ScriptCall) {
		if (!call.sessionId) return;
		if (!confirm(`Kill the session for "${callLabel(call)}"? The call resolves to null.`)) return;
		pending = { ...pending, [call.callId]: true };
		try {
			await fetch(`/api/v1/sessions/${encodeURIComponent(call.sessionId)}/stop`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode: "interrupt" }),
			});
			await fetchCalls();
		} finally {
			pending = { ...pending, [call.callId]: false };
		}
	}

	async function skipCall(call: ScriptCall) {
		if (!confirm(`Skip "${callLabel(call)}"? The script sees null for this call.`)) return;
		pending = { ...pending, [call.callId]: true };
		try {
			await fetch(
				`/api/workflows/executions/${encodeURIComponent(executionId)}/script-calls/${encodeURIComponent(call.callId)}/skip`,
				{ method: "POST" },
			);
			await fetchCalls();
		} finally {
			pending = { ...pending, [call.callId]: false };
		}
	}

	function sessionHref(sessionId: string): string {
		return `/workspaces/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`;
	}
</script>

<div class="flex h-full flex-col gap-4 overflow-y-auto p-4">
	<!-- Meta header -->
	<div class="space-y-1">
		<h2 class="text-lg font-semibold">{meta.name}</h2>
		{#if meta.description}
			<p class="text-sm text-muted-foreground">{meta.description}</p>
		{/if}
	</div>

	<!-- Phases -->
	{#if meta.phases.length}
		<div class="flex flex-wrap gap-1.5">
			{#each meta.phases as phase (phase.title)}
				{@const isCurrent = currentPhase != null && phase.title === currentPhase}
				<Badge variant={isCurrent ? "default" : "outline"}>
					{#if isCurrent}
						<Loader2 class="mr-1 size-3 animate-spin" />
					{/if}
					{phase.title}
				</Badge>
			{/each}
		</div>
	{/if}

	<!-- Budget bar -->
	{#if budgetTotal != null}
		<div class="space-y-1">
			<div class="flex items-center justify-between text-xs text-muted-foreground">
				<span>Budget</span>
				<span>{spentTokens.toLocaleString()} / {budgetTotal.toLocaleString()} tokens</span>
			</div>
			<div class="h-2 w-full overflow-hidden rounded-full bg-muted">
				<div
					class="h-full rounded-full transition-all {budgetPct != null && budgetPct >= 100
						? 'bg-destructive'
						: 'bg-primary'}"
					style="width: {budgetPct ?? 0}%"
				></div>
			</div>
		</div>
	{:else}
		<div class="text-xs text-muted-foreground">
			{spentTokens.toLocaleString()} tokens used (no budget cap)
		</div>
	{/if}

	<!-- Per-call journal -->
	<div class="rounded-md border">
		<div
			class="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground"
		>
			<span>Call</span>
			<span>Phase</span>
			<span>Status</span>
			<span class="text-right">Tokens</span>
			<span></span>
		</div>

		{#if !loaded}
			<div class="flex items-center justify-center py-8">
				<Loader2 class="size-5 animate-spin text-muted-foreground" />
			</div>
		{:else if error}
			<div class="px-3 py-6 text-sm text-destructive">{error}</div>
		{:else if calls.length === 0}
			<div class="px-3 py-6 text-sm text-muted-foreground">
				No agent calls issued yet.
			</div>
		{:else}
			{#each calls as call (call.callId)}
				<div
					class="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0"
				>
					<div class="min-w-0">
						<div class="truncate font-medium">{callLabel(call)}</div>
						{#if call.errorCode}
							<div class="truncate text-xs text-destructive">{call.errorCode}</div>
						{:else if call.retries > 0}
							<div class="text-xs text-muted-foreground">retries: {call.retries}</div>
						{/if}
					</div>
					<span class="text-xs text-muted-foreground">{call.phase ?? "—"}</span>
					<Badge variant={statusVariant(call.status)}>{call.status}</Badge>
					<span class="text-right text-xs tabular-nums">
						{(call.tokensUsed || 0).toLocaleString()}
					</span>
					<div class="flex items-center justify-end gap-1">
						{#if call.sessionId}
							<Button
								variant="ghost"
								size="icon"
								href={sessionHref(call.sessionId)}
								title="Open session"
							>
								<ExternalLink class="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								disabled={pending[call.callId]}
								onclick={() => killSession(call)}
								title="Kill session"
							>
								<Ban class="size-3.5" />
							</Button>
						{/if}
						{#if call.status === "running"}
							<Button
								variant="ghost"
								size="icon"
								disabled={pending[call.callId]}
								onclick={() => skipCall(call)}
								title="Skip call"
							>
								<SkipForward class="size-3.5" />
							</Button>
						{/if}
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>
