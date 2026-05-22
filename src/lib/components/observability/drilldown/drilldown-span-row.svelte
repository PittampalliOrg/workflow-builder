<script lang="ts">
	import { ChevronRight, ChevronDown, AlertTriangle } from '@lucide/svelte';
	import type { ObservabilityTraceSpan } from '$lib/types/observability';
	import {
		presentSpan,
		serviceColor,
		collapseServiceNameClient,
		httpSummary,
		statusTone,
		fmtMs
	} from '$lib/utils/span-presentation';
	import DrilldownIo from './drilldown-io.svelte';
	import type { DrilldownIoFallback } from './io-fallback';

	let {
		span,
		depth,
		hasChildren,
		expanded,
		selected,
		globalMaxMs,
		ioFallback,
		onToggle,
		onSelect
	}: {
		span: ObservabilityTraceSpan;
		depth: number;
		hasChildren: boolean;
		expanded: boolean;
		selected: boolean;
		globalMaxMs: number;
		ioFallback?: DrilldownIoFallback | null;
		onToggle: () => void;
		onSelect: () => void;
	} = $props();

	let present = $derived(presentSpan(span));
	let errored = $derived(span.status === 'error');
	let svc = $derived(collapseServiceNameClient(span.serviceName));
	let svcColor = $derived(serviceColor(span.serviceName));
	let http = $derived(httpSummary(span.attributes));
	let widthPct = $derived(Math.max(1.5, (span.duration / Math.max(globalMaxMs, 1)) * 100));

	// Curated detail rows (no leading raw IDs).
	let detailRows = $derived.by(() => {
		const rows: { label: string; value: string; tone?: string }[] = [];
		rows.push({ label: 'Category', value: present.label });
		rows.push({ label: 'Service', value: svc });
		if (span.spanKind) rows.push({ label: 'Kind', value: span.spanKind });
		if (http.method || http.path) {
			rows.push({
				label: 'Request',
				value: `${http.method ?? ''} ${http.path ?? ''}`.trim(),
				tone: http.status != null ? statusTone(http.status) : undefined
			});
		}
		if (http.status != null)
			rows.push({ label: 'Status', value: String(http.status), tone: statusTone(http.status) });
		const a = span.attributes ?? {};
		if (typeof a['db.system'] === 'string') rows.push({ label: 'DB', value: String(a['db.system']) });
		if (typeof a['gen_ai.request.model'] === 'string')
			rows.push({ label: 'Model', value: String(a['gen_ai.request.model']) });
		if (errored && span.statusMessage)
			rows.push({ label: 'Error', value: span.statusMessage, tone: 'text-destructive' });
		return rows;
	});

	const Icon = $derived(present.icon);

	let inputVal = $derived(span.attributes?.['input.value']);
	let outputVal = $derived(span.attributes?.['output.value']);
	let fallbackInput = $derived(inputVal == null ? ioFallback?.input?.value : undefined);
	let fallbackOutput = $derived(outputVal == null ? ioFallback?.output?.value : undefined);
	let fallbackInputSource = $derived(
		ioFallback?.input?.sourceRelation === 'ancestor'
			? `ancestor ${ioFallback.input.sourceLabel}`
			: `descendant ${ioFallback?.input?.sourceLabel ?? 'span'}`
	);
	let fallbackOutputSource = $derived(
		ioFallback?.output?.sourceRelation === 'ancestor'
			? `ancestor ${ioFallback.output.sourceLabel}`
			: `descendant ${ioFallback?.output?.sourceLabel ?? 'span'}`
	);
	let attrEntries = $derived(
		Object.entries(span.attributes ?? {})
			.filter(([k]) => k !== 'input.value' && k !== 'output.value')
			.map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string])
			.sort((a, b) => a[0].localeCompare(b[0]))
	);
</script>

<div class="wb-row" class:wb-row--sel={selected} class:wb-row--err={errored}>
	<div class="wb-row__main" style="padding-left: {depth * 14}px">
		{#if hasChildren}
			<button class="wb-chev" onclick={onToggle} aria-label={expanded ? 'Collapse' : 'Expand'}>
				{#if expanded}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
			</button>
		{:else}
			<span class="wb-chev wb-chev--leaf"></span>
		{/if}
		<button class="wb-row__body" onclick={onSelect} title={span.operationName}>
			<Icon size={13} class={errored ? 'text-destructive shrink-0' : `${present.textClass} shrink-0`} />
			<span class="wb-row__name">{span.operationName}</span>
			{#if errored}<AlertTriangle size={11} class="shrink-0 text-destructive" />{/if}
			<span class="wb-row__dur">{fmtMs(span.duration)}</span>
		</button>
	</div>
	<div class="wb-row__bartrack" style="margin-left: {depth * 14 + 19}px">
		<div
			class="wb-row__barfill {errored ? 'bg-destructive' : present.barClass}"
			style="width: {widthPct}%"
		></div>
	</div>

	{#if selected}
		<div class="wb-row__detail" style="margin-left: {depth * 14 + 19}px">
			{#if inputVal != null}<DrilldownIo label="Input" value={inputVal} />{/if}
			{#if outputVal != null}<DrilldownIo label="Output" value={outputVal} />{/if}
			{#if fallbackInput !== undefined}<DrilldownIo label={`Input from ${fallbackInputSource}`} value={fallbackInput} />{/if}
			{#if fallbackOutput !== undefined}<DrilldownIo label={`Output from ${fallbackOutputSource}`} value={fallbackOutput} />{/if}
			<dl class="wb-detail-grid">
				{#each detailRows as row}
					<dt>{row.label}</dt>
					<dd class={row.tone ?? ''}>{row.value}</dd>
				{/each}
			</dl>
			{#if attrEntries.length}
				<details class="wb-attrs">
					<summary>All attributes ({attrEntries.length})</summary>
					<dl class="wb-attr-grid">
						{#each attrEntries as [k, v] (k)}
							<dt title={k}>{k}</dt>
							<dd>{v.length > 300 ? v.slice(0, 300) + '…' : v}</dd>
						{/each}
					</dl>
				</details>
			{/if}
			<div class="wb-row__ids">
				<span title="trace id">trace {span.traceId.slice(0, 12)}…</span>
				<span title="span id">span {span.spanId.slice(0, 12)}…</span>
			</div>
		</div>
	{/if}
</div>

<style>
	.wb-row {
		border-radius: calc(var(--radius) - 4px);
	}
	.wb-row--sel {
		background: color-mix(in oklch, var(--primary) 7%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary) 25%, transparent);
	}
	.wb-row__main {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	.wb-chev {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		color: var(--muted-foreground);
		border-radius: 4px;
		flex-shrink: 0;
	}
	.wb-chev:hover {
		background: var(--muted);
		color: var(--foreground);
	}
	.wb-chev--leaf {
		width: 15px;
	}
	.wb-row__body {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		flex: 1;
		padding: 3px 4px;
		text-align: left;
	}
	.wb-row__name {
		font-size: 12px;
		font-weight: 500;
		color: var(--foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
	.wb-row__dur {
		margin-left: auto;
		font-size: 11px;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
		padding-left: 8px;
	}
	.wb-row__bartrack {
		height: 5px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--muted) 70%, transparent);
		overflow: hidden;
		margin-top: 1px;
		margin-bottom: 3px;
		margin-right: 4px;
	}
	.wb-row__barfill {
		height: 100%;
		border-radius: 999px;
		opacity: 0.85;
		transition: width 0.3s ease;
	}
	.wb-row__detail {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-right: 4px;
		margin-bottom: 6px;
		padding: 8px 10px;
		border-radius: calc(var(--radius) - 4px);
		background: color-mix(in oklch, var(--muted) 50%, transparent);
		border: 1px solid var(--border);
	}
	.wb-attrs > summary {
		cursor: pointer;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted-foreground);
		list-style: none;
	}
	.wb-attrs > summary::-webkit-details-marker {
		display: none;
	}
	.wb-attrs > summary::before {
		content: '▸ ';
	}
	.wb-attrs[open] > summary::before {
		content: '▾ ';
	}
	.wb-attr-grid {
		display: grid;
		grid-template-columns: minmax(120px, 40%) 1fr;
		gap: 1px 10px;
		margin-top: 6px;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 10px;
	}
	.wb-attr-grid dt {
		color: var(--muted-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.wb-attr-grid dd {
		color: var(--foreground);
		overflow-wrap: anywhere;
	}
	.wb-detail-grid {
		display: grid;
		grid-template-columns: 70px 1fr;
		gap: 2px 10px;
		font-size: 11px;
	}
	.wb-detail-grid dt {
		color: var(--muted-foreground);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: 10px;
		padding-top: 1px;
	}
	.wb-detail-grid dd {
		color: var(--foreground);
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}
	.wb-row__ids {
		display: flex;
		gap: 12px;
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px dashed var(--border);
		font-size: 10px;
		color: var(--muted-foreground);
		font-family: var(--font-mono, ui-monospace, monospace);
	}
</style>
