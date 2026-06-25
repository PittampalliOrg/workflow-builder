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
	import DiffArtifact from "$lib/components/workflow/execution/diff-artifact.svelte";
	import * as Card from "$lib/components/ui/card";
	import {
		ExternalLink,
		Target,
		ShieldCheck,
		TriangleAlert,
		Download,
		GitPullRequest,
		Package,
	} from "@lucide/svelte";

	interface Props {
		kind: string;
		/** Artifact row id — used to lazily resolve offloaded `diff` patches. */
		id?: string | null;
		/** Parent execution id — used to lazily resolve offloaded `diff` patches. */
		executionId?: string | null;
		title?: string;
		description?: string | null;
		inlinePayload?: unknown;
		fileId?: string | null;
		contentType?: string | null;
		metadata?: Record<string, unknown> | null;
	}

	let { kind, id = null, executionId = null, inlinePayload, fileId, ...rest }: Props = $props();

	// Promote → PR for a `source-bundle` version (durable, applyable code version).
	let promoting = $state(false);
	let promoteResult = $state<{
		ok: boolean;
		prUrl?: string | null;
		branch?: string | null;
		prError?: string | null;
		error?: string;
	} | null>(null);
	async function promoteVersion(mode: "pr" | "branch") {
		if (!executionId || !id) return;
		promoting = true;
		promoteResult = null;
		try {
			const res = await fetch(
				`/api/workflows/executions/${executionId}/versions/${id}/promote`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ mode }),
				},
			);
			promoteResult = await res.json();
			if (!res.ok && promoteResult && !promoteResult.error) {
				promoteResult.error = `HTTP ${res.status}`;
			}
		} catch (e) {
			promoteResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
		} finally {
			promoting = false;
		}
	}

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
{:else if kind === "diff"}
	<DiffArtifact {executionId} artifactId={id} {inlinePayload} {fileId} />
{:else if kind === "source-bundle" && fileId}
	<!--
		A durable, applyable code VERSION (git bundle in the Files API). Preview is the
		paired `diff` artifact for the same node; here we offer Download (recover the
		exact source via `git clone <bundle>`) + Promote → PR (apply on accept — opens
		a PR only for this chosen version). See docs/code-version-persistence.md.
	-->
	<div class="space-y-2 rounded border p-3 text-sm">
		<div class="flex items-center gap-2">
			<Package class="h-4 w-4 shrink-0 text-muted-foreground" />
			<span class="font-medium">{rest.title || "Source bundle"}</span>
			{#if payloadField("tier")}
				<span class="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
					>{asString(payloadField("tier"))}</span
				>
			{/if}
			{#if payloadField("fileCount")}
				<span class="text-xs text-muted-foreground"
					>{asString(payloadField("fileCount"))} files</span
				>
			{/if}
		</div>
		<p class="text-xs text-muted-foreground">
			Recover this exact source with <code>git clone &lt;bundle&gt;</code>, or apply it as a PR.
		</p>
		<div class="flex flex-wrap items-center gap-2">
			<a
				href={`/api/v1/files/${fileId}/content`}
				class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
				download
			>
				<Download class="h-3.5 w-3.5" /> Download bundle
			</a>
			<button
				type="button"
				class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-progress disabled:opacity-60"
				disabled={promoting || !executionId}
				onclick={() => promoteVersion("pr")}
			>
				<GitPullRequest class="h-3.5 w-3.5" />
				{promoting ? "Promoting…" : "Promote → PR"}
			</button>
		</div>
		{#if promoteResult}
			{#if promoteResult.prUrl}
				<p class="text-xs text-green-600 dark:text-green-400">
					PR opened: <a class="underline" href={promoteResult.prUrl} target="_blank" rel="noreferrer"
						>{promoteResult.prUrl}</a
					>
				</p>
			{:else if promoteResult.branch}
				<p class="text-xs text-green-600 dark:text-green-400">
					Branch pushed: <code>{promoteResult.branch}</code>{#if promoteResult.prError}
						<span class="text-amber-600"> (PR not opened: {promoteResult.prError})</span>{/if}
				</p>
			{:else}
				<p class="text-xs text-red-600 dark:text-red-400">
					Promote failed: {promoteResult.error ?? promoteResult.prError ?? "unknown error"}
				</p>
			{/if}
		{/if}
	</div>
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
