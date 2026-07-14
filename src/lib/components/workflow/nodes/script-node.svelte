<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import {
		Bot,
		GitFork,
		ArrowRight,
		Layers,
		Play,
		Square,
		Diamond,
		Repeat,
		CornerDownRight,
		Braces,
		Zap,
		Clock,
		Hand,
		Users,
		AtSign,
		Box,
		ShieldAlert
	} from '@lucide/svelte';
	import type { ScriptNodeVariant } from '$lib/utils/script-graph-adapter';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const variant = $derived((data.variant as ScriptNodeVariant) ?? 'agent');
	const label = $derived((data.label as string) ?? '');
	const inLoop = $derived(Boolean(data.inLoop));
	const callCount = $derived(data.callCount as number | undefined);
	const fanCount = $derived(data.fanCount as number | undefined);
	const width = $derived((data.width as number | undefined) ?? 264);
	const promptPreview = $derived(data.promptPreview as string | null);
	const hasSchema = $derived(Boolean(data.hasSchema));
	const schemaProps = $derived((data.schemaProps as string[] | undefined) ?? []);
	// Full-dialect call specifics (adapter v2).
	const actionSlug = $derived(data.actionSlug as string | null);
	const allowFailure = $derived(Boolean(data.allowFailure));
	const sleepSeconds = $derived(data.sleepSeconds as number | null);
	const eventName = $derived(data.eventName as string | null);
	const teamOp = $derived(data.teamOp as string | null);
	const agentRef = $derived(data.agentRef as string | null);
	const model = $derived(data.model as string | null);
	const hasSandbox = $derived(Boolean(data.hasSandbox));
	const inputProps = $derived((data.inputProps as string[] | undefined) ?? []);

	// One accent per construct so phases and call kinds read at a glance while
	// every card keeps the same footprint (uniform width + rhythm).
	const STYLE: Record<
		ScriptNodeVariant,
		{ accent: string; ring: string; glow: string; chip: string; Icon: typeof Bot; kind: string }
	> = {
		start: { accent: 'text-emerald-300', ring: 'border-emerald-400/40', glow: 'from-emerald-500/15', chip: 'bg-emerald-500/15 text-emerald-200', Icon: Play, kind: 'Start' },
		phase: { accent: 'text-fuchsia-300', ring: 'border-fuchsia-400/40', glow: 'from-fuchsia-500/15', chip: 'bg-fuchsia-500/15 text-fuchsia-200', Icon: Diamond, kind: 'Phase' },
		agent: { accent: 'text-teal-300', ring: 'border-teal-400/40', glow: 'from-teal-500/12', chip: 'bg-teal-500/15 text-teal-200', Icon: Bot, kind: 'agent' },
		parallel: { accent: 'text-amber-300', ring: 'border-amber-400/40', glow: 'from-amber-500/15', chip: 'bg-amber-500/15 text-amber-200', Icon: GitFork, kind: 'parallel' },
		pipeline: { accent: 'text-sky-300', ring: 'border-sky-400/40', glow: 'from-sky-500/15', chip: 'bg-sky-500/15 text-sky-200', Icon: ArrowRight, kind: 'pipeline' },
		workflow: { accent: 'text-indigo-300', ring: 'border-indigo-400/40', glow: 'from-indigo-500/15', chip: 'bg-indigo-500/15 text-indigo-200', Icon: Layers, kind: 'workflow' },
		action: { accent: 'text-violet-300', ring: 'border-violet-400/40', glow: 'from-violet-500/12', chip: 'bg-violet-500/15 text-violet-200', Icon: Zap, kind: 'action' },
		sleep: { accent: 'text-slate-300', ring: 'border-slate-400/40', glow: 'from-slate-500/10', chip: 'bg-slate-500/15 text-slate-300', Icon: Clock, kind: 'sleep' },
		event: { accent: 'text-rose-300', ring: 'border-rose-400/40', glow: 'from-rose-500/12', chip: 'bg-rose-500/15 text-rose-200', Icon: Hand, kind: 'gate' },
		team: { accent: 'text-cyan-300', ring: 'border-cyan-400/40', glow: 'from-cyan-500/12', chip: 'bg-cyan-500/15 text-cyan-200', Icon: Users, kind: 'team' },
		end: { accent: 'text-slate-300', ring: 'border-slate-400/40', glow: 'from-slate-500/15', chip: 'bg-slate-500/15 text-slate-200', Icon: Square, kind: 'End' }
	};
	const s = $derived(STYLE[variant]);

	const isPhase = $derived(variant === 'phase');
	const isEndpoint = $derived(variant === 'start' || variant === 'end');
	const isJunction = $derived(variant === 'parallel' || variant === 'pipeline');
	const isSleep = $derived(variant === 'sleep');
	const kindLabel = $derived(
		variant === 'team' && teamOp ? `team.${teamOp}()` : `${s.kind}()`
	);

	const visibleProps = $derived(schemaProps.slice(0, 3));
	const extraProps = $derived(Math.max(0, schemaProps.length - visibleProps.length));

	// Live overlay (cutover P2b): per-line journal aggregation joined by the
	// evaluator-captured call_site.line. Present only on the run page.
	type CallLineState = {
		total: number;
		running: number;
		done: number;
		error: number;
		skipped: number;
		runningSessionIds: string[];
		runningCallIds: string[];
	};
	const callState = $derived(data.callState as CallLineState | undefined);
	/** Code⇄canvas sync: the editor cursor is on this node's source line. */
	const codeActive = $derived(Boolean(data.codeActive));
	const onKillSession = $derived(data.onKillSession as ((sessionId: string) => void) | undefined);
	const onSkipCall = $derived(data.onSkipCall as ((callId: string) => void) | undefined);
	const onApproveCall = $derived(data.onApproveCall as ((callId: string) => void) | undefined);
	let approving = $state(false);
</script>

<div class="relative" style="width: {width}px">
	{#if !(variant === 'start')}
		<Handle
			type="target"
			position={Position.Top}
			class="!size-2 !border !border-background !bg-muted-foreground/50"
		/>
	{/if}

	{#if isEndpoint}
		<!-- Start / End: a centered capsule (Start also lists the run's inputs) -->
		<div class="flex flex-col items-center gap-1.5">
			<div
				class="inline-flex items-center gap-2 rounded-full border {s.ring} bg-gradient-to-b {s.glow} to-background/60 px-4 py-1.5 shadow-sm backdrop-blur"
			>
				<s.Icon class="size-3.5 {s.accent}" />
				<span class="max-w-[180px] truncate text-xs font-semibold text-foreground/90">{label}</span>
			</div>
			{#if variant === 'start' && inputProps.length > 0}
				<div class="flex max-w-[320px] flex-wrap items-center justify-center gap-1">
					<span class="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/70">args</span>
					{#each inputProps.slice(0, 5) as prop (prop)}
						<span class="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">{prop}</span>
					{/each}
					{#if inputProps.length > 5}
						<span class="text-[10px] text-muted-foreground/70">+{inputProps.length - 5}</span>
					{/if}
				</div>
			{/if}
		</div>
	{:else if isPhase}
		<!-- Phase: a full-width lane header band -->
		<div
			class="flex items-center gap-2 rounded-lg border {s.ring} bg-gradient-to-r {s.glow} to-background/40 px-3 py-2 shadow-sm backdrop-blur
				{selected ? 'ring-2 ring-primary/60' : ''}"
		>
			<div class="flex size-6 items-center justify-center rounded-md {s.chip}">
				<s.Icon class="size-3.5" />
			</div>
			<div class="min-w-0 flex-1">
				<div class="text-[9px] font-semibold uppercase tracking-[0.14em] {s.accent}">Phase</div>
				<div class="truncate text-[13px] font-semibold text-foreground/90" title={label}>{label}</div>
			</div>
			{#if callCount != null}
				<span class="shrink-0 rounded-full bg-background/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
					{callCount} step{callCount === 1 ? '' : 's'}
				</span>
			{/if}
		</div>
	{:else if isSleep}
		<!-- sleep(): a compact timer capsule -->
		<div class="flex justify-center">
			<div
				class="inline-flex items-center gap-1.5 rounded-full border {s.ring} bg-gradient-to-b {s.glow} to-background/60 px-3 py-1 shadow-sm backdrop-blur
					{selected ? 'ring-2 ring-primary/60' : ''}
					{codeActive ? 'ring-2 ring-fuchsia-400/70' : ''}"
			>
				<Clock class="size-3.5 {s.accent}" />
				<span class="text-[11px] font-semibold text-foreground/85">{label}</span>
				{#if inLoop}
					<Repeat class="size-3 text-muted-foreground" />
				{/if}
				{#if callState}
					{#if callState.running > 0}
						<span class="size-1.5 animate-pulse rounded-full bg-sky-300"></span>
					{:else if callState.done > 0}
						<span class="size-1.5 rounded-full bg-emerald-400"></span>
					{/if}
				{/if}
			</div>
		</div>
	{:else if isJunction}
		<!-- parallel() / pipeline(): a compact branch chip -->
		<div class="flex justify-center">
			<div
				class="inline-flex items-center gap-1.5 rounded-full border {s.ring} bg-gradient-to-b {s.glow} to-background/60 px-3 py-1 shadow-sm backdrop-blur
					{selected ? 'ring-2 ring-primary/60' : ''}"
			>
				<s.Icon class="size-3.5 {s.accent}" />
				<span class="text-[11px] font-semibold {s.accent}">{s.kind}</span>
				{#if fanCount}
					<span class="rounded-full {s.chip} px-1.5 text-[10px] font-bold tabular-nums">×{fanCount}</span>
				{/if}
				{#if inLoop}
					<Repeat class="size-3 text-muted-foreground" />
				{/if}
			</div>
		</div>
	{:else}
		<!-- agent() / workflow(): a uniform call card with IN (prompt) / OUT (schema) -->
		<div
			class="overflow-hidden rounded-xl border {s.ring} bg-gradient-to-b {s.glow} to-card/80 shadow-md backdrop-blur transition
				hover:-translate-y-0.5 hover:shadow-lg
				{selected ? 'ring-2 ring-primary/60' : ''}
				{codeActive ? 'ring-2 ring-fuchsia-400/70 shadow-fuchsia-500/20' : ''}"
		>
			<div class="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
				<div class="flex size-6 shrink-0 items-center justify-center rounded-md {s.chip}">
					<s.Icon class="size-3.5" />
				</div>
				<span class="text-[10px] font-semibold uppercase tracking-[0.12em] {s.accent}">{kindLabel}</span>
				<div class="ml-auto flex items-center gap-1">
					{#if allowFailure}
						<span class="inline-flex items-center gap-0.5 rounded bg-background/70 px-1 text-[9px] text-amber-300/90" title="allowFailure: an error journals an envelope instead of failing the run">
							<ShieldAlert class="size-2.5" /> soft-fail
						</span>
					{/if}
					{#if inLoop}
						<span class="inline-flex items-center gap-0.5 rounded bg-background/70 px-1 text-[9px] text-muted-foreground" title="Runs inside a loop">
							<Repeat class="size-2.5" /> loop
						</span>
					{/if}
					{#if hasSchema}
						<span class="inline-flex items-center gap-0.5 rounded {s.chip} px-1 text-[9px] font-medium" title="Structured (schema-typed) output">
							<Braces class="size-2.5" /> typed
						</span>
					{/if}
				</div>
			</div>

			<div class="px-3 py-2">
				<div class="truncate text-[13px] font-semibold text-foreground/90" title={label}>{label}</div>

				{#if actionSlug && actionSlug !== label}
					<div class="mt-1 flex items-center gap-1.5">
						<Zap class="size-2.5 shrink-0 {s.accent}" />
						<span class="truncate font-mono text-[10.5px] text-muted-foreground" title={actionSlug}>{actionSlug}</span>
					</div>
				{/if}

				{#if eventName}
					<div class="mt-1 flex items-center gap-1.5">
						<Hand class="size-2.5 shrink-0 {s.accent}" />
						<span class="truncate text-[10.5px] text-muted-foreground">
							{eventName === 'approval' ? 'waits for human approval' : `waits for “${eventName}”`}
						</span>
					</div>
				{/if}

				{#if agentRef || model || hasSandbox}
					<div class="mt-1 flex flex-wrap items-center gap-1">
						{#if agentRef}
							<span class="inline-flex items-center gap-0.5 rounded {s.chip} px-1.5 py-0.5 text-[9.5px] font-medium" title="Named agent — resolved fail-closed at dispatch">
								<AtSign class="size-2.5" />{agentRef}
							</span>
						{/if}
						{#if model}
							<span class="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[9.5px] text-foreground/60" title="Model override">{model}</span>
						{/if}
						{#if hasSandbox}
							<span class="inline-flex items-center gap-0.5 rounded bg-background/70 px-1.5 py-0.5 text-[9.5px] text-muted-foreground" title="Bound to a shared workspace/sandbox">
								<Box class="size-2.5" /> workspace
							</span>
						{/if}
					</div>
				{/if}

				{#if promptPreview}
					<div class="mt-1.5 flex items-start gap-1.5">
						<span class="mt-[1px] shrink-0 rounded bg-background/70 px-1 text-[8px] font-bold uppercase tracking-wide text-muted-foreground/80">in</span>
						<span class="line-clamp-1 text-[11px] leading-snug text-muted-foreground" title={promptPreview}>{promptPreview}</span>
					</div>
				{/if}

				{#if hasSchema}
					<div class="mt-1.5 flex items-start gap-1.5">
						<span class="mt-[1px] shrink-0 rounded {s.chip} px-1 text-[8px] font-bold uppercase tracking-wide">out</span>
						{#if visibleProps.length > 0}
							<div class="flex flex-wrap items-center gap-1">
								{#each visibleProps as p (p)}
									<span class="rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">{p}</span>
								{/each}
								{#if extraProps > 0}
									<span class="text-[10px] text-muted-foreground/70">+{extraProps}</span>
								{/if}
							</div>
						{:else}
							<span class="inline-flex items-center gap-1 text-[10px] text-muted-foreground/80">
								<CornerDownRight class="size-2.5" /> structured object
							</span>
						{/if}
					</div>
				{/if}

				{#if callState}
					<div class="mt-1.5 flex items-center gap-1.5 border-t border-border/40 pt-1.5 text-[10px]">
						{#if callState.running > 0}
							<span class="inline-flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 font-medium text-sky-200">
								<span class="size-1.5 animate-pulse rounded-full bg-sky-300"></span>
								{callState.running} running
							</span>
						{/if}
						{#if callState.done > 0}
							<span class="rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-200">{callState.done} done</span>
						{/if}
						{#if callState.error > 0}
							<span class="rounded bg-red-500/15 px-1.5 py-0.5 font-medium text-red-300">{callState.error} error</span>
						{/if}
						{#if callState.skipped > 0}
							<span class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{callState.skipped} skipped</span>
						{/if}
						{#if variant === 'event' && callState.running > 0 && onApproveCall && callState.runningCallIds[0]}
							<button
								class="ml-auto inline-flex items-center gap-1 rounded bg-emerald-500/90 px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-60"
								title="Approve this gate — the run continues immediately"
								disabled={approving}
								onclick={(e) => {
									e.stopPropagation();
									approving = true;
									onApproveCall(callState.runningCallIds[0]);
								}}
							>✓ Approve</button>
						{/if}
						{#if callState.running > 0 && (onKillSession || onSkipCall) && variant !== 'event'}
							<span class="ml-auto inline-flex items-center gap-1">
								{#if onSkipCall && callState.runningCallIds[0]}
									<button
										class="rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
										title="Skip this call (script sees null)"
										onclick={(e) => { e.stopPropagation(); onSkipCall(callState.runningCallIds[0]); }}
									>skip</button>
								{/if}
								{#if onKillSession && callState.runningSessionIds[0]}
									<button
										class="rounded border border-red-400/40 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10"
										title="Kill the running session"
										onclick={(e) => { e.stopPropagation(); onKillSession(callState.runningSessionIds[0]); }}
									>kill</button>
								{/if}
							</span>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	{#if !(variant === 'end')}
		<Handle
			type="source"
			position={Position.Bottom}
			class="!size-2 !border !border-background !bg-muted-foreground/50"
		/>
	{/if}
</div>
