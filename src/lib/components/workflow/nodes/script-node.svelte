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

	const variant = $derived((data.variant as string) ?? 'agent');
	const isContainer = $derived(
		variant === 'loopGroup' || variant === 'parallelGroup' || variant === 'pipelineGroup'
	);
	const containerW = $derived((data.w as number) ?? 320);
	const containerH = $derived((data.h as number) ?? 200);
	const caption = $derived(data.caption as string | undefined);
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

	// shadcn-style: NEUTRAL card surfaces (bg-card/border-border) with ONE
	// restrained accent per kind — a left stripe + a tinted icon chip. Hues are
	// theme-adaptive (600 in light, 300 in dark) so both modes read cleanly.
	const STYLE: Record<
		ScriptNodeVariant,
		{ accent: string; stripe: string; chip: string; Icon: typeof Bot; kind: string }
	> = {
		start: { accent: 'text-emerald-600 dark:text-emerald-300', stripe: 'bg-emerald-500', chip: 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300', Icon: Play, kind: 'Start' },
		phase: { accent: 'text-fuchsia-600 dark:text-fuchsia-300', stripe: 'bg-fuchsia-500', chip: 'bg-fuchsia-500/10 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-300', Icon: Diamond, kind: 'Phase' },
		agent: { accent: 'text-teal-600 dark:text-teal-300', stripe: 'bg-teal-500', chip: 'bg-teal-500/10 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300', Icon: Bot, kind: 'agent' },
		parallel: { accent: 'text-amber-600 dark:text-amber-300', stripe: 'bg-amber-500', chip: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300', Icon: GitFork, kind: 'parallel' },
		pipeline: { accent: 'text-sky-600 dark:text-sky-300', stripe: 'bg-sky-500', chip: 'bg-sky-500/10 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300', Icon: ArrowRight, kind: 'pipeline' },
		workflow: { accent: 'text-indigo-600 dark:text-indigo-300', stripe: 'bg-indigo-500', chip: 'bg-indigo-500/10 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300', Icon: Layers, kind: 'workflow' },
		action: { accent: 'text-violet-600 dark:text-violet-300', stripe: 'bg-violet-500', chip: 'bg-violet-500/10 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300', Icon: Zap, kind: 'action' },
		sleep: { accent: 'text-slate-600 dark:text-slate-300', stripe: 'bg-slate-400', chip: 'bg-slate-500/10 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300', Icon: Clock, kind: 'sleep' },
		event: { accent: 'text-rose-600 dark:text-rose-300', stripe: 'bg-rose-500', chip: 'bg-rose-500/10 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300', Icon: Hand, kind: 'gate' },
		team: { accent: 'text-cyan-600 dark:text-cyan-300', stripe: 'bg-cyan-500', chip: 'bg-cyan-500/10 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300', Icon: Users, kind: 'team' },
		end: { accent: 'text-slate-600 dark:text-slate-300', stripe: 'bg-slate-400', chip: 'bg-slate-500/10 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300', Icon: Square, kind: 'End' }
	};
	const s = $derived(STYLE[(isContainer ? 'agent' : variant) as ScriptNodeVariant]);

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

{#if isContainer}
	<div
		class="pointer-events-none rounded-2xl border-2 border-dashed
			{variant === 'loopGroup' ? 'border-rose-400/45 bg-rose-500/[0.045]' : ''}
			{variant === 'parallelGroup' ? 'border-amber-400/45 bg-amber-500/[0.045]' : ''}
			{variant === 'pipelineGroup' ? 'border-sky-400/45 bg-sky-500/[0.045]' : ''}"
		style="width: {containerW}px; height: {containerH}px"
	>
		<div class="flex items-center gap-1.5 px-3 pt-2">
			{#if variant === 'loopGroup'}
				<Repeat class="size-3.5 text-rose-500 dark:text-rose-300" />
				<span class="text-[11px] font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-300">{label}</span>
			{:else if variant === 'pipelineGroup'}
				<ArrowRight class="size-3.5 text-sky-500 dark:text-sky-300" />
				<span class="text-[11px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-300">{label}</span>
			{:else}
				<GitFork class="size-3.5 text-amber-500 dark:text-amber-300" />
				<span class="text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300">{label}</span>
			{/if}
		</div>
		{#if caption}
			<div class="px-3 pt-0.5 text-[10px] italic text-muted-foreground/80">{caption}</div>
		{/if}
	</div>
{:else}
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
				class="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 shadow-sm"
			>
				<span class="flex size-4.5 items-center justify-center rounded-full {s.chip}">
					<s.Icon class="size-2.5" />
				</span>
				<span class="max-w-[180px] truncate text-xs font-semibold text-card-foreground">{label}</span>
			</div>
			{#if variant === 'start' && inputProps.length > 0}
				<div class="flex max-w-[320px] flex-wrap items-center justify-center gap-1">
					<span class="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/70">args</span>
					{#each inputProps.slice(0, 5) as prop (prop)}
						<span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">{prop}</span>
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
			class="relative flex items-center gap-2 overflow-hidden rounded-lg border border-border bg-card py-2 pl-4 pr-3 shadow-sm
				{selected ? 'ring-2 ring-ring' : ''}"
		>
			<span class="absolute inset-y-0 left-0 w-1 {s.stripe}"></span>
			<div class="flex size-6 items-center justify-center rounded-md {s.chip}">
				<s.Icon class="size-3.5" />
			</div>
			<div class="min-w-0 flex-1">
				<div class="text-[9px] font-semibold uppercase tracking-[0.14em] {s.accent}">Phase</div>
				<div class="truncate text-[13px] font-semibold text-card-foreground" title={label}>{label}</div>
			</div>
			{#if callCount != null}
				<span class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
					{callCount} step{callCount === 1 ? '' : 's'}
				</span>
			{/if}
		</div>
	{:else if isSleep}
		<!-- sleep(): a compact timer capsule -->
		<div class="flex justify-center">
			<div
				class="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 shadow-sm
					{selected ? 'ring-2 ring-ring' : ''}
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
				class="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 shadow-sm
					{selected ? 'ring-2 ring-ring' : ''}"
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
			class="wfb-node-card relative overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-[box-shadow,transform] duration-200
				hover:-translate-y-0.5 hover:shadow-md
				{selected ? 'ring-2 ring-ring' : ''}
				{codeActive ? 'ring-2 ring-fuchsia-400/70' : ''}
				{callState && callState.running > 0 ? 'wfb-node-running' : ''}"
		>
			<span class="absolute inset-y-0 left-0 w-1 {s.stripe}"></span>
			<div class="flex items-center gap-2 border-b border-border/60 py-1.5 pl-4 pr-3">
				<div class="flex size-6 shrink-0 items-center justify-center rounded-md {s.chip}">
					<s.Icon class="size-3.5" />
				</div>
				<span class="text-[10px] font-semibold uppercase tracking-[0.12em] {s.accent}">{kindLabel}</span>
				<div class="ml-auto flex items-center gap-1">
					{#if allowFailure}
						<span class="inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[9px] text-amber-300/90" title="allowFailure: an error journals an envelope instead of failing the run">
							<ShieldAlert class="size-2.5" /> soft-fail
						</span>
					{/if}
					{#if inLoop}
						<span class="inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[9px] text-muted-foreground" title="Runs inside a loop">
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

			<div class="py-2 pl-4 pr-3">
				<div class="truncate text-[13px] font-semibold text-card-foreground" title={label}>{label}</div>

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
							<span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[9.5px] text-foreground/60" title="Model override">{model}</span>
						{/if}
						{#if hasSandbox}
							<span class="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[9.5px] text-muted-foreground" title="Bound to a shared workspace/sandbox">
								<Box class="size-2.5" /> workspace
							</span>
						{/if}
					</div>
				{/if}

				{#if promptPreview}
					<div class="mt-1.5 flex items-start gap-1.5">
						<span class="mt-[1px] shrink-0 rounded bg-muted px-1 text-[8px] font-bold uppercase tracking-wide text-muted-foreground/80">in</span>
						<span class="line-clamp-1 text-[11px] leading-snug text-muted-foreground" title={promptPreview}>{promptPreview}</span>
					</div>
				{/if}

				{#if hasSchema}
					<div class="mt-1.5 flex items-start gap-1.5">
						<span class="mt-[1px] shrink-0 rounded {s.chip} px-1 text-[8px] font-bold uppercase tracking-wide">out</span>
						{#if visibleProps.length > 0}
							<div class="flex flex-wrap items-center gap-1">
								{#each visibleProps as p (p)}
									<span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/70">{p}</span>
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
{/if}
