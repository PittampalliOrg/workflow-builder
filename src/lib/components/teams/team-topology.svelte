<!--
  The TeamPulse topology: a hub node (the script/lead coordinator) wired to
  member nodes, with live message pulses.

  Mechanics: member nodes are plain DOM (robust layout); an absolutely
  positioned SVG overlay draws hub→member connector lines from measured node
  centers. Message pulses are 8px dots in the SENDER's color, CSS-transitioned
  from source node center to recipient node center when a new recentMessages
  entry appears between polls (diffed by ts+from+toSessionId key).
-->
<script lang="ts">
	import { Megaphone, ScrollText } from '@lucide/svelte';
	import TeamMemberNode from './team-member-node.svelte';
	import { memberColor } from './member-color';

	type Member = {
		name: string;
		role: string;
		status: string;
		sessionId: string;
		currentTaskId: string | null;
	};
	type Msg = {
		ts: string;
		from: string | null;
		to: string | null;
		toSessionId: string;
		kind: string;
		preview: string | null;
	};

	interface Props {
		members: Member[];
		recentMessages?: Msg[];
		taskTitleById?: Map<string, string>;
		/** Hub caption: 'script' for dynamic-script runs, 'lead' elsewhere. */
		hubKind?: 'script' | 'lead';
		selectedSessionId?: string | null;
		onSelectMember?: (m: { name: string; sessionId: string }) => void;
		hrefForSession?: (sessionId: string) => string;
	}
	let {
		members,
		recentMessages = [],
		taskTitleById = new Map(),
		hubKind = 'lead',
		selectedSessionId = null,
		onSelectMember,
		hrefForSession
	}: Props = $props();

	const lead = $derived(members.find((m) => m.role === 'lead') ?? null);
	const workers = $derived(members.filter((m) => m.role !== 'lead'));

	// ── message pulses ────────────────────────────────────────────────────
	type Pulse = {
		id: string;
		fromName: string;
		toName: string;
		dotClass: string;
		broadcast: boolean;
	};
	let container = $state<HTMLElement | null>(null);
	let pulses = $state<Pulse[]>([]);
	let seenKeys = new Set<string>();
	let primed = false;
	let pulseSeq = 0;

	function msgKey(m: Msg): string {
		return `${m.ts}|${m.from ?? ''}|${m.toSessionId}`;
	}

	$effect(() => {
		const msgs = recentMessages;
		if (!primed) {
			// First load: prime the seen-set without animating history.
			for (const m of msgs) seenKeys.add(msgKey(m));
			primed = true;
			return;
		}
		const fresh = msgs.filter((m) => !seenKeys.has(msgKey(m)));
		if (fresh.length === 0) return;
		for (const m of fresh) seenKeys.add(msgKey(m));
		// Animate oldest-first so overlapping sends read in order; cap the burst.
		for (const m of fresh.slice(-6).reverse()) {
			if (m.kind === 'team-idle') continue; // internal nudges don't pulse
			pulseSeq += 1;
			pulses = [
				...pulses,
				{
					id: `p${pulseSeq}`,
					fromName: m.from ?? 'lead',
					toName: m.to ?? '',
					dotClass: memberColor(m.from).dot,
					broadcast: m.kind === 'team-broadcast'
				}
			];
		}
		// Prune the seen-set occasionally (recentMessages is capped at 30 anyway).
		if (seenKeys.size > 400) seenKeys = new Set(msgs.map(msgKey));
	});

	/** Center of a node (by member name; 'lead'/'script' = hub) relative to the container. */
	function nodeCenter(name: string): { x: number; y: number } | null {
		if (!container) return null;
		const key = name === 'script' ? 'lead' : name;
		const el = container.querySelector<HTMLElement>(`[data-member="${CSS.escape(key)}"]`)
			?? container.querySelector<HTMLElement>('[data-hub]');
		if (!el) return null;
		const c = container.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 };
	}

	function pulseStyle(p: Pulse, phase: 'start' | 'end'): string {
		const from = nodeCenter(p.fromName);
		const to = p.toName ? nodeCenter(p.toName) : null;
		if (!from || !to) return 'display:none';
		const at = phase === 'start' ? from : to;
		return `left:${at.x - 4}px; top:${at.y - 4}px;`;
	}

	function removePulse(id: string) {
		pulses = pulses.filter((p) => p.id !== id);
	}

	// Connector geometry (recomputed when members change or on resize via bind).
	let connectorTick = $state(0);
	$effect(() => {
		void members.length;
		void container;
		// next frame so DOM has laid out
		const t = setTimeout(() => (connectorTick += 1), 50);
		return () => clearTimeout(t);
	});
	function connectors(): Array<{ x1: number; y1: number; x2: number; y2: number; stroke: string }> {
		void connectorTick;
		if (!container) return [];
		const hub = nodeCenter('lead');
		if (!hub) return [];
		const out: Array<{ x1: number; y1: number; x2: number; y2: number; stroke: string }> = [];
		for (const w of workers) {
			const c = nodeCenter(w.name);
			if (!c) continue;
			out.push({ x1: hub.x, y1: hub.y, x2: c.x, y2: c.y, stroke: memberColor(w.name).stroke });
		}
		return out;
	}
</script>

<div bind:this={container} class="relative flex items-center gap-4 rounded-lg border border-border/60 bg-muted/10 p-3">
	<!-- connector overlay -->
	<svg class="pointer-events-none absolute inset-0 h-full w-full">
		{#each connectors() as c, i (i)}
			<line
				x1={c.x1}
				y1={c.y1}
				x2={c.x2}
				y2={c.y2}
				class="{c.stroke} opacity-20"
				stroke-width="1.5"
				stroke-dasharray="3 4"
			/>
		{/each}
	</svg>

	<!-- hub -->
	{#if lead}
		<div data-hub class="shrink-0">
			<TeamMemberNode
				name={hubKind === 'script' ? 'script' : lead.name}
				role="lead"
				status={lead.status}
				sessionId={lead.sessionId}
				currentTaskTitle={hubKind === 'script' ? 'orchestrating' : null}
				selected={selectedSessionId === lead.sessionId}
				onSelect={onSelectMember}
				href={hrefForSession ? hrefForSession(lead.sessionId) : null}
			/>
		</div>
	{:else}
		<div data-hub class="flex w-24 shrink-0 flex-col items-center gap-1 p-1.5 text-center">
			<span class="flex size-10 items-center justify-center rounded-full border border-amber-400/50 bg-amber-500/10">
				<ScrollText class="size-4 text-amber-300" />
			</span>
			<span class="text-[11px] font-medium">script</span>
		</div>
	{/if}

	<!-- members -->
	<div class="flex min-w-0 flex-1 flex-wrap gap-1.5">
		{#each workers as m (m.sessionId)}
			<TeamMemberNode
				name={m.name}
				role={m.role}
				status={m.status}
				sessionId={m.sessionId}
				currentTaskTitle={m.currentTaskId ? taskTitleById.get(m.currentTaskId) ?? null : null}
				selected={selectedSessionId === m.sessionId}
				onSelect={onSelectMember}
				href={hrefForSession ? hrefForSession(m.sessionId) : null}
			/>
		{:else}
			<div class="px-2 py-4 text-xs italic text-muted-foreground/70">no teammates yet</div>
		{/each}
	</div>

	<!-- message pulses -->
	{#each pulses as p (p.id)}
		<span
			class="team-pulse-dot pointer-events-none absolute z-10 size-2 rounded-full {p.dotClass} {p.broadcast ? 'team-pulse-broadcast' : ''}"
			style={pulseStyle(p, 'start')}
			ontransitionend={() => removePulse(p.id)}
			use:travel={p}
		></span>
	{/each}
	{#if pulses.some((p) => p.broadcast)}
		<span class="absolute right-2 top-2"><Megaphone class="size-3.5 animate-pulse text-amber-300" /></span>
	{/if}
</div>

<style>
	.team-pulse-dot {
		transition:
			left 0.9s cubic-bezier(0.4, 0, 0.2, 1),
			top 0.9s cubic-bezier(0.4, 0, 0.2, 1);
		box-shadow: 0 0 6px 1px currentColor;
	}
	.team-pulse-broadcast {
		box-shadow: 0 0 10px 3px rgb(251 191 36 / 0.5);
	}
</style>

<script lang="ts" module>
	/** Svelte action: on mount, flip the dot to its destination next frame so
	 * the CSS transition carries it from source to recipient. */
	export function travel(node: HTMLElement, pulse: { toName: string }) {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const container = node.parentElement;
				if (!container) return;
				const key = pulse.toName === 'script' ? 'lead' : pulse.toName;
				const el =
					container.querySelector<HTMLElement>(`[data-member="${CSS.escape(key)}"]`) ??
					container.querySelector<HTMLElement>('[data-hub]');
				if (!el) {
					node.style.display = 'none';
					return;
				}
				const c = container.getBoundingClientRect();
				const r = el.getBoundingClientRect();
				node.style.left = `${r.left - c.left + r.width / 2 - 4}px`;
				node.style.top = `${r.top - c.top + r.height / 2 - 4}px`;
			});
		});
	}
</script>
