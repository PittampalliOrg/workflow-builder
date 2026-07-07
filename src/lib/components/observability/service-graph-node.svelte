<script lang="ts" module>
	/** Stable phase → hue assignment (matches the dynamic-script phase-rail
	 * palette family). Hash keeps hues stable across reloads/orderings. */
	const PHASE_PALETTE = [
		{ h: 'oklch(0.72 0.18 320)', name: 'fuchsia' },
		{ h: 'oklch(0.75 0.14 195)', name: 'teal' },
		{ h: 'oklch(0.78 0.15 85)', name: 'amber' },
		{ h: 'oklch(0.72 0.13 240)', name: 'sky' },
		{ h: 'oklch(0.68 0.15 285)', name: 'indigo' },
		{ h: 'oklch(0.72 0.16 15)', name: 'rose' },
		{ h: 'oklch(0.76 0.16 130)', name: 'lime' }
	];

	export function phaseHue(group: string): string {
		let acc = 0;
		for (let i = 0; i < group.length; i++) acc = (acc * 31 + group.charCodeAt(i)) >>> 0;
		return PHASE_PALETTE[acc % PHASE_PALETTE.length].h;
	}
</script>

<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import {
		Server,
		Database,
		Cloud,
		User,
		Workflow,
		Coins,
		RefreshCcw,
		Snowflake,
		Bot,
		GitFork,
		ArrowRight,
		Layers
	} from '@lucide/svelte';
	import type { ServiceGraphNode, NodeInsight } from '$lib/types/service-graph';

	let { data, selected = false }: NodeProps = $props();
	let node = $derived(data.node as ServiceGraphNode);
	let insight = $derived((data.insight as NodeInsight | null) ?? null);
	let onCritical = $derived(Boolean(data.onCritical));

	const KIND_ICONS = {
		service: Server,
		db: Database,
		external: Cloud,
		user: User,
		step: Workflow
	} as const;
	// Dynamic-script call kinds reuse the run-panel iconography for continuity.
	const DETAIL_ICONS: Record<string, typeof Bot> = {
		agent: Bot,
		parallel: GitFork,
		pipeline: ArrowRight,
		workflow: Layers
	};
	let Icon = $derived(
		(node.detail ? DETAIL_ICONS[node.detail] : undefined) ?? KIND_ICONS[node.kind] ?? Server
	);

	let phaseColor = $derived(node.group ? phaseHue(node.group) : null);

	let ring = $derived.by(() => {
		if (node.status === 'error') return 'var(--destructive)';
		if (node.live) return phaseColor ?? 'var(--primary)';
		if (node.status === 'idle') return 'var(--border)';
		if (phaseColor) return `color-mix(in oklch, ${phaseColor} 65%, var(--border))`;
		return 'color-mix(in oklch, var(--primary) 60%, var(--border))';
	});

	let errorPct = $derived(Math.round(node.red.errorRate * 100));
	let rateLabel = $derived(
		node.red.rate >= 1 || node.red.rate === 0
			? `${Math.round(node.red.rate)}`
			: node.red.rate.toFixed(2)
	);
	let latency = $derived(node.red.selfMs ?? node.red.p95);

	function fmtMs(ms: number): string {
		if (!ms) return '0ms';
		return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
	}
	function fmtTokens(n: number): string {
		if (!n) return '0';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
		return `${n}`;
	}
	function fmtCost(n: number): string {
		if (n > 0 && n < 0.01) return '<$0.01';
		return `$${n.toFixed(2)}`;
	}

	let tooltip = $derived.by(() => {
		const lines = [
			node.label,
			...(node.group ? [`phase: ${node.group}`] : []),
			`requests: ${node.red.total} (${rateLabel}/s)`,
			`errors: ${node.red.errors} (${errorPct}%)`,
			`latency: ${fmtMs(latency)}`
		];
		if (insight?.tokens) lines.push(`tokens: ${fmtTokens(insight.tokens.total)}`);
		if (insight?.costUsd != null) lines.push(`cost: ${fmtCost(insight.costUsd)}`);
		if (insight?.timing) {
			const t = insight.timing;
			lines.push(
				`timing: cold ${fmtMs(t.coldStartMs)} · cred ${fmtMs(t.credentialFetchMs)} · route ${fmtMs(t.routingMs)} · exec ${fmtMs(t.executionMs)}`
			);
		}
		if ((insight?.retries ?? 0) > 0) lines.push(`retries: ${insight?.retries}`);
		if (onCritical) lines.push('on critical path');
		return lines.join('\n');
	});

	let hasInsightRow = $derived(
		Boolean(insight?.tokens || insight?.costUsd != null || (insight?.retries ?? 0) > 0 || insight?.timing?.wasColdStart)
	);
</script>

<div
	class="wb-sg-node"
	style="border-color: {ring}; --sg-ring: {ring}; --sg-phase: {phaseColor ?? 'var(--primary)'};"
	class:wb-sg-node--idle={node.status === 'idle' && !node.live}
	class:wb-sg-node--selected={selected}
	class:wb-sg-node--critical={onCritical}
	class:wb-sg-node--live={node.live}
	class:wb-sg-node--error={node.status === 'error'}
	title={tooltip}
>
	<Handle type="target" position={Position.Left} />
	{#if node.group || node.detail}
		<div class="wb-sg-node__phase">
			{#if node.detail}<span class="wb-sg-node__kind">{node.detail}</span>{/if}
			{#if node.group}<span class="wb-sg-node__group" title="phase">{node.group}</span>{/if}
			{#if node.live}<span class="wb-sg-node__pulse" title="running"></span>{/if}
		</div>
	{/if}
	<div class="wb-sg-node__head">
		<span class="wb-sg-node__icon"><Icon size={13} /></span>
		<span class="wb-sg-node__label">{node.label}</span>
		{#if onCritical}<span class="wb-sg-node__crit" title="critical path">★</span>{/if}
	</div>
	<div class="wb-sg-node__metrics">
		<span class="wb-sg-node__metric" title="request rate">⇢ {rateLabel}/s</span>
		<span class="wb-sg-node__metric" class:wb-sg-node__metric--err={errorPct > 0} title="error rate">
			⚠ {errorPct}%
		</span>
		<span class="wb-sg-node__metric" title="latency">⏱ {fmtMs(latency)}</span>
	</div>
	{#if hasInsightRow}
		<div class="wb-sg-node__insights">
			{#if insight?.tokens}
				<span class="wb-sg-node__metric" title="LLM tokens"><Coins size={10} /> {fmtTokens(insight.tokens.total)}</span>
			{/if}
			{#if insight?.costUsd != null}
				<span class="wb-sg-node__metric" title="LLM cost">{fmtCost(insight.costUsd)}</span>
			{/if}
			{#if (insight?.retries ?? 0) > 0}
				<span class="wb-sg-node__metric" title="retries"><RefreshCcw size={10} /> {insight?.retries}</span>
			{/if}
			{#if insight?.timing?.wasColdStart}
				<span class="wb-sg-node__metric" title="cold start"><Snowflake size={10} /></span>
			{/if}
		</div>
	{/if}
	<Handle type="source" position={Position.Right} />
</div>

<style>
	.wb-sg-node {
		min-width: 168px;
		max-width: 224px;
		border: 1.5px solid var(--border);
		border-radius: calc(var(--radius) + 2px);
		background: color-mix(in oklch, var(--card) 88%, var(--sg-phase) 4%);
		color: var(--card-foreground);
		padding: 8px 10px;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.18),
			0 4px 14px -6px rgba(0, 0, 0, 0.35);
		font-size: 12px;
		cursor: pointer;
		backdrop-filter: blur(6px);
		transition:
			box-shadow 160ms ease,
			transform 160ms ease,
			border-color 160ms ease;
	}
	.wb-sg-node:hover {
		transform: translateY(-1px);
		box-shadow:
			0 2px 4px rgba(0, 0, 0, 0.22),
			0 10px 24px -8px color-mix(in oklch, var(--sg-ring) 35%, transparent);
	}
	.wb-sg-node--idle {
		opacity: 0.5;
	}
	.wb-sg-node--selected {
		box-shadow:
			0 0 0 2px var(--primary),
			0 2px 10px rgba(0, 0, 0, 0.25);
	}
	.wb-sg-node--critical {
		box-shadow:
			0 0 0 1px color-mix(in oklch, var(--primary) 55%, transparent),
			0 0 16px color-mix(in oklch, var(--primary) 40%, transparent);
	}
	.wb-sg-node--live {
		border-color: var(--sg-phase);
		box-shadow:
			0 0 0 1px color-mix(in oklch, var(--sg-phase) 40%, transparent),
			0 0 18px color-mix(in oklch, var(--sg-phase) 35%, transparent);
		animation: wb-sg-breathe 2.2s ease-in-out infinite;
	}
	.wb-sg-node--error {
		background: color-mix(in oklch, var(--card) 90%, var(--destructive) 6%);
	}
	@keyframes wb-sg-breathe {
		0%,
		100% {
			box-shadow:
				0 0 0 1px color-mix(in oklch, var(--sg-phase) 40%, transparent),
				0 0 10px color-mix(in oklch, var(--sg-phase) 25%, transparent);
		}
		50% {
			box-shadow:
				0 0 0 1px color-mix(in oklch, var(--sg-phase) 55%, transparent),
				0 0 24px color-mix(in oklch, var(--sg-phase) 45%, transparent);
		}
	}
	.wb-sg-node__phase {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-bottom: 5px;
	}
	.wb-sg-node__kind {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sg-phase);
	}
	.wb-sg-node__group {
		font-size: 9px;
		color: color-mix(in oklch, var(--sg-phase) 70%, var(--muted-foreground));
		background: color-mix(in oklch, var(--sg-phase) 12%, transparent);
		border: 1px solid color-mix(in oklch, var(--sg-phase) 25%, transparent);
		border-radius: 999px;
		padding: 0 6px;
		max-width: 120px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.wb-sg-node__pulse {
		margin-left: auto;
		width: 7px;
		height: 7px;
		border-radius: 999px;
		background: var(--sg-phase);
		animation: wb-sg-dot 1.1s ease-in-out infinite;
	}
	@keyframes wb-sg-dot {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.45;
			transform: scale(0.75);
		}
	}
	.wb-sg-node__head {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 600;
	}
	.wb-sg-node__icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border-radius: 7px;
		flex-shrink: 0;
		color: var(--sg-ring);
		background: color-mix(in oklch, var(--sg-ring) 14%, transparent);
		border: 1px solid color-mix(in oklch, var(--sg-ring) 28%, transparent);
	}
	.wb-sg-node__label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--card-foreground);
	}
	.wb-sg-node__crit {
		margin-left: auto;
		color: var(--primary);
		font-size: 11px;
	}
	.wb-sg-node__metrics,
	.wb-sg-node__insights {
		display: flex;
		gap: 8px;
		margin-top: 6px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
		font-size: 11px;
		align-items: center;
	}
	.wb-sg-node__insights {
		margin-top: 3px;
		border-top: 1px dashed var(--border);
		padding-top: 3px;
	}
	.wb-sg-node__metric {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}
	.wb-sg-node__metric--err {
		color: var(--destructive);
		font-weight: 600;
	}
	:global(.wb-sg-node .svelte-flow__handle) {
		width: 7px;
		height: 7px;
		background: var(--muted-foreground);
		border: none;
	}
</style>
