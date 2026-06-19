<!--
  Discriminated-union renderer for workflow_artifacts rows. The orchestrator
  (or any internal-token writer) populates a row with `kind` + `inline_payload`
  shaped per the table below; this component dispatches to the matching
  underlying renderer.

  Standard shapes:
    kind: 'markdown'  payload: { markdown: string }
    kind: 'json'      payload: { value: any }
    kind: 'text'      payload: { text: string }
    kind: 'table'     payload: { columns: string[], rows: any[][] }
    kind: 'link'      payload: { url: string, openIn?: 'new' | 'inline' }
    kind: 'card'      payload: { body: string, footer?: string }
    kind: 'image'     payload: { alt?: string }    (blob via fileId — TODO when blob endpoint lands)
    kind: 'html'      payload: { html: string }    (rendered live in a sandboxed iframe — see below)
    kind: 'goal_spec' payload: { objective, acceptanceCriteria[], evidence:{commands[]}, maxIterations?, tokenBudget?, rationale, lint:{warnings[]} }

  Anything unknown falls back to a JSON dump so the data is still visible.
-->
<script lang="ts">
	import Response from "$lib/components/ui/ai-elements/response/Response.svelte";
	import JsonViewer from "$lib/components/workflow/execution/json-viewer.svelte";
	import * as Card from "$lib/components/ui/card";
	import { ExternalLink, Target, ShieldCheck, TriangleAlert } from "@lucide/svelte";

	interface Props {
		kind: string;
		title?: string;
		description?: string | null;
		inlinePayload?: unknown;
		fileId?: string | null;
		contentType?: string | null;
		metadata?: Record<string, unknown> | null;
	}

	let { kind, inlinePayload, fileId, ...rest }: Props = $props();

	// Narrowing helpers — payloads come from JSONB so we treat them as unknown.
	function asString(v: unknown): string {
		if (typeof v === "string") return v;
		if (v == null) return "";
		try {
			return JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	}

	function payloadField(field: string): unknown {
		if (inlinePayload && typeof inlinePayload === "object") {
			return (inlinePayload as Record<string, unknown>)[field];
		}
		return undefined;
	}

	const tableData = $derived.by(() => {
		const p = inlinePayload as { columns?: unknown; rows?: unknown } | null;
		if (!p) return null;
		const cols = Array.isArray(p.columns) ? (p.columns as unknown[]).map(String) : null;
		const rows = Array.isArray(p.rows) ? (p.rows as unknown[][]) : null;
		if (!cols || !rows) return null;
		return { cols, rows };
	});

	// goal_spec: the authored sprint-contract (objective + acceptance criteria +
	// ground-truth evidence + planner rationale + static lint warnings).
	const goalSpec = $derived.by(() => {
		const p = inlinePayload as Record<string, unknown> | null;
		if (!p || typeof p !== "object") return null;
		const objective = typeof p.objective === "string" ? p.objective : "";
		const acceptanceCriteria = Array.isArray(p.acceptanceCriteria)
			? (p.acceptanceCriteria as unknown[]).map(String)
			: [];
		const evidence = (p.evidence ?? {}) as { commands?: unknown };
		const commands = Array.isArray(evidence.commands)
			? (evidence.commands as unknown[]).map(String)
			: [];
		const rationale = typeof p.rationale === "string" ? p.rationale : "";
		const lint = (p.lint ?? {}) as { warnings?: unknown };
		const warnings = Array.isArray(lint.warnings)
			? (lint.warnings as unknown[]).map(String)
			: [];
		const maxIterations = typeof p.maxIterations === "number" ? p.maxIterations : null;
		const tokenBudget = typeof p.tokenBudget === "number" ? p.tokenBudget : null;
		return { objective, acceptanceCriteria, commands, rationale, warnings, maxIterations, tokenBudget };
	});
</script>

{#if kind === "markdown"}
	<div class="prose prose-sm dark:prose-invert max-w-none">
		<Response content={asString(payloadField("markdown"))} />
	</div>
{:else if kind === "json"}
	<JsonViewer data={payloadField("value") ?? inlinePayload} label={rest.title ?? "JSON"} collapsed={false} />
{:else if kind === "text"}
	<pre class="whitespace-pre-wrap text-sm leading-relaxed font-mono p-2">{asString(payloadField("text"))}</pre>
{:else if kind === "table" && tableData}
	<div class="overflow-x-auto">
		<table class="w-full text-sm border-collapse">
			<thead>
				<tr class="border-b">
					{#each tableData.cols as col (col)}
						<th class="px-3 py-2 text-left font-medium">{col}</th>
					{/each}
				</tr>
			</thead>
			<tbody>
				{#each tableData.rows as row, ri (ri)}
					<tr class="border-b last:border-0">
						{#each row as cell, ci (ci)}
							<td class="px-3 py-1.5 align-top font-mono text-xs">
								{typeof cell === "object" ? JSON.stringify(cell) : String(cell ?? "")}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{:else if kind === "link"}
	{@const url = asString(payloadField("url"))}
	<a
		href={url}
		target="_blank"
		rel="noopener noreferrer"
		class="inline-flex items-center gap-2 text-sm text-primary underline-offset-4 hover:underline"
	>
		<ExternalLink class="h-3.5 w-3.5" />
		<span class="break-all">{rest.title || url}</span>
	</a>
{:else if kind === "card"}
	<Card.Root>
		{#if rest.title}
			<Card.Header><Card.Title>{rest.title}</Card.Title>
				{#if rest.description}<Card.Description>{rest.description}</Card.Description>{/if}
			</Card.Header>
		{/if}
		<Card.Content>
			<div class="prose prose-sm dark:prose-invert max-w-none">
				<Response content={asString(payloadField("body"))} />
			</div>
		</Card.Content>
		{#if payloadField("footer")}
			<Card.Footer><span class="text-xs text-muted-foreground">{asString(payloadField("footer"))}</span></Card.Footer>
		{/if}
	</Card.Root>
{:else if kind === "image" && fileId}
	<img
		src={`/api/v1/files/${fileId}/content`}
		alt={asString(payloadField("alt")) || rest.title || "image artifact"}
		class="max-w-full rounded border"
	/>
{:else if kind === "html"}
	<!--
		Rendered HTML artifact (e.g. a self-contained single-file web app a workflow
		built). Isolated in a sandboxed iframe: `allow-scripts` lets the artifact's
		own JS run (canvas, handlers) while the ABSENCE of `allow-same-origin` keeps
		it walled off from the app origin (no cookies / storage / parent access) —
		the standard safe pattern for rendering agent-produced markup.
	-->
	<iframe
		title={rest.title || "rendered HTML artifact"}
		srcdoc={asString(payloadField("html"))}
		sandbox="allow-scripts"
		class="w-full rounded border bg-white"
		style="height: 70vh; min-height: 420px;"
		loading="lazy"
	></iframe>
{:else if kind === "goal_spec" && goalSpec}
	<div class="space-y-3 text-sm">
		<div class="flex items-start gap-2">
			<Target class="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" />
			<div>
				<div class="text-xs font-medium text-muted-foreground">Objective</div>
				<p class="whitespace-pre-wrap">{goalSpec.objective}</p>
			</div>
		</div>
		{#if goalSpec.acceptanceCriteria.length}
			<div>
				<div class="mb-1 text-xs font-medium text-muted-foreground">Acceptance criteria</div>
				<ul class="space-y-1">
					{#each goalSpec.acceptanceCriteria as crit (crit)}
						<li class="flex items-start gap-1.5">
							<ShieldCheck class="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
							<span>{crit}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		{#if goalSpec.commands.length}
			<div>
				<div class="mb-1 text-xs font-medium text-muted-foreground">Evidence commands (ground-truth)</div>
				<div class="space-y-1">
					{#each goalSpec.commands as cmd (cmd)}
						<code class="block rounded bg-muted px-2 py-1 font-mono text-xs">{cmd}</code>
					{/each}
				</div>
			</div>
		{/if}
		<div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
			{#if goalSpec.maxIterations !== null}<span>Max iterations: {goalSpec.maxIterations}</span>{/if}
			{#if goalSpec.tokenBudget !== null}<span>Token budget: {goalSpec.tokenBudget.toLocaleString()}</span>{/if}
		</div>
		{#if goalSpec.rationale}
			<p class="rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
				<span class="font-medium text-foreground">Rationale:</span>
				{goalSpec.rationale}
			</p>
		{/if}
		{#if goalSpec.warnings.length}
			<ul class="space-y-1">
				{#each goalSpec.warnings as warning (warning)}
					<li class="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300">
						<TriangleAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span>{warning}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{:else}
	<!-- Unknown kind — surface the raw payload so the data isn't lost. -->
	<JsonViewer data={inlinePayload} label={`${kind} (raw)`} collapsed={false} />
{/if}
