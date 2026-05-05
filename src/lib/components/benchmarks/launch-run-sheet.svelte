<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Sheet from '$lib/components/ui/sheet';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Activity, Bot, Check, Loader2, Rocket, Search } from '@lucide/svelte';
	import type { RunnableAgent, SuiteFacet } from '$lib/types/benchmark-instance';

	type Props = {
		open: boolean;
		instanceIds: string[];
		suiteSlug: string;
		runnableAgents: RunnableAgent[];
		suiteFacets: SuiteFacet[];
		onOpenChange: (next: boolean) => void;
		/** Optional pre-fill (used by compare-page "Re-run" affordance). */
		defaults?: {
			agentId?: string;
			modelNameOrPath?: string;
			modelConfigLabel?: string;
			tags?: string[];
		} | null;
		requirePrevalidatedEnvironments?: boolean;
	};

	let {
		open = $bindable(false),
		instanceIds,
		suiteSlug,
		runnableAgents,
		suiteFacets,
		onOpenChange,
		defaults = null,
		requirePrevalidatedEnvironments = false
	}: Props = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');
	const DEFAULT_INFERENCE_CONCURRENCY = 10;
	const DEFAULT_EVALUATION_CONCURRENCY = 24;
	const MAX_INFERENCE_CONCURRENCY = 128;
	const MAX_EVALUATION_CONCURRENCY = 128;
	const DEFAULT_MAX_ACTIVE_INFERENCE = 56;

	let agentId = $state('');
	let modelNameOrPath = $state('');
	let modelConfigLabel = $state('');
	let concurrency = $state(DEFAULT_INFERENCE_CONCURRENCY);
	let evaluationConcurrency = $state(DEFAULT_EVALUATION_CONCURRENCY);
	let timeoutSeconds = $state(7200);
	let evaluatorResourceClass = $state<'standard' | 'large' | 'xlarge'>('standard');
	let tagsInput = $state('');
	let agentQuery = $state('');

	let submitting = $state(false);
	let errorMessage = $state<string | null>(null);

	const selectedAgent = $derived(runnableAgents.find((a) => a.id === agentId) ?? null);
	const visibleAgents = $derived.by(() => {
		const query = agentQuery.trim().toLowerCase();
		if (!query) return runnableAgents;
		return runnableAgents.filter((agent) =>
			[agent.name, agent.slug, agent.modelSpec ?? ''].some((value) =>
				value.toLowerCase().includes(query)
			)
		);
	});
	const selectedCapacity = $derived(selectedAgent?.benchmarkCapacity ?? null);
	const maxActiveInference = $derived(
		Math.max(1, selectedCapacity?.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_INFERENCE)
	);
	const effectiveInferenceConcurrency = $derived(
		Math.max(1, Math.min(instanceIds.length || 1, concurrency, maxActiveInference))
	);
	const inferenceConcurrencyCapped = $derived(
		instanceIds.length > 0 && effectiveInferenceConcurrency < instanceIds.length
	);

	// When the sheet opens with `defaults` (e.g. fork from compare page),
	// pre-fill the form. Reset whenever `defaults` changes between opens.
	$effect(() => {
		if (open && defaults) {
			if (defaults.agentId) agentId = defaults.agentId;
			if (defaults.modelNameOrPath) modelNameOrPath = defaults.modelNameOrPath;
			if (defaults.modelConfigLabel != null) modelConfigLabel = defaults.modelConfigLabel;
			if (Array.isArray(defaults.tags)) tagsInput = defaults.tags.join(', ');
		}
	});

	// When the sheet opens, default agent + model from the first runnable agent
	// (only if the user hasn't already chosen one).
	$effect(() => {
		if (open && !agentId && runnableAgents.length > 0) {
			selectAgent(runnableAgents[0]);
		}
	});

	$effect(() => {
		if (selectedAgent && !modelNameOrPath) {
			modelNameOrPath = parseModelDefault(selectedAgent.modelSpec);
		}
	});

	function parseModelDefault(modelSpec: string | null): string {
		if (!modelSpec) return '';
		// Common shapes: "anthropic:claude-opus-4-7", "claude-opus-4-7", "openai:gpt-4"
		const colonIdx = modelSpec.indexOf(':');
		return colonIdx >= 0 ? modelSpec.slice(colonIdx + 1) : modelSpec;
	}

	function selectAgent(agent: RunnableAgent) {
		agentId = agent.id;
		modelNameOrPath = parseModelDefault(agent.modelSpec);
	}

	function suiteName(slug: string): string {
		return suiteFacets.find((s) => s.slug === slug)?.name ?? slug;
	}

	const previewIds = $derived(instanceIds.slice(0, 3));
	const remainingCount = $derived(Math.max(0, instanceIds.length - previewIds.length));

	const estimatedMinutes = $derived(() => {
		// Rough wall-clock estimate. Assumes ~7 minutes per instance with bounded
		// concurrency. Real runs vary widely; this is a rough prior so the user
		// has a sense of magnitude before submitting.
		if (instanceIds.length === 0 || effectiveInferenceConcurrency <= 0) return 0;
		const perInstanceMinutes = 7;
		return Math.ceil((instanceIds.length / effectiveInferenceConcurrency) * perInstanceMinutes);
	});

	function formatEstimate(mins: number): string {
		if (mins <= 0) return '—';
		if (mins < 60) return `~${mins}m`;
		const hours = Math.floor(mins / 60);
		const remainingMin = mins % 60;
		return remainingMin === 0 ? `~${hours}h` : `~${hours}h ${remainingMin}m`;
	}


	function parseTags(input: string): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const raw of input.split(/[,\s]+/)) {
			const tag = raw.trim().toLowerCase();
			if (!tag || seen.has(tag)) continue;
			seen.add(tag);
			out.push(tag);
		}
		return out;
	}

	function reset() {
		errorMessage = null;
		modelConfigLabel = '';
		tagsInput = '';
		agentQuery = '';
		// keep agent + model for repeat launches
	}

	async function submit() {
		if (instanceIds.length === 0 || !agentId || submitting) return;
		submitting = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/benchmarks/runs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					suiteSlug,
					agentId,
					instanceIds,
					modelNameOrPath: modelNameOrPath.trim() || undefined,
					modelConfigLabel: modelConfigLabel.trim() || undefined,
					concurrency,
					evaluationConcurrency,
					timeoutSeconds,
					evaluatorResourceClass,
					tags: parseTags(tagsInput),
					requirePrevalidatedEnvironments
				})
			});
			const body = await res.json().catch(() => ({}) as Record<string, unknown>);
			if (!res.ok) {
				throw new Error(
					(body as { message?: string; error?: string }).message ??
						(body as { error?: string }).error ??
						`Failed to start run (${res.status})`
				);
			}
			const run = (body as { run?: { id: string } }).run;
			const coordinatorStartError = (body as { coordinatorStartError?: string | null })
				.coordinatorStartError;
			if (coordinatorStartError) {
				errorMessage = `Run was created but the coordinator failed to start: ${coordinatorStartError}`;
				return;
			}
			if (run?.id) {
				onOpenChange(false);
				reset();
				await goto(`/workspaces/${slug}/benchmarks/runs/${encodeURIComponent(run.id)}`);
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
	}
</script>

<Sheet.Root
	{open}
	onOpenChange={(next) => {
		onOpenChange(next);
		if (!next) reset();
	}}
>
	<Sheet.Content side="right" class="w-full sm:max-w-lg flex min-h-0 flex-col">
		<Sheet.Header class="space-y-1">
			<Sheet.Title class="flex items-center gap-2">
				<Rocket class="size-4" /> Launch benchmark run
			</Sheet.Title>
			<Sheet.Description>
				Dispatches one parallel <code class="text-[11px]">durable/run</code> child workflow per
				selected instance via the SWE-bench coordinator.
			</Sheet.Description>
		</Sheet.Header>

		<div class="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-3">
			<!-- Target summary -->
			<div class="rounded-md border border-border bg-muted/30 p-3 space-y-2">
				<div class="flex items-center justify-between gap-2">
					<div class="flex items-center gap-2">
						<Badge variant="default">{suiteName(suiteSlug)}</Badge>
						<span class="text-sm font-medium tabular-nums">
							{instanceIds.length} instances
						</span>
					</div>
					<span class="text-[11px] text-muted-foreground">
						est. wall-clock {formatEstimate(estimatedMinutes())}
					</span>
				</div>
				<div class="flex flex-wrap gap-1">
					{#each previewIds as id (id)}
						<Badge variant="outline" class="font-mono text-[10px]">{id}</Badge>
					{/each}
					{#if remainingCount > 0}
						<Badge variant="outline" class="text-[10px]">+{remainingCount} more</Badge>
					{/if}
				</div>
				{#if inferenceConcurrencyCapped}
					<div class="rounded border border-border bg-background/70 px-2 py-1 text-[11px] text-muted-foreground">
						Effective active inference concurrency:
						<span class="font-mono text-foreground">{effectiveInferenceConcurrency}</span>
						{#if selectedCapacity}
							<span>
								· active cap {selectedCapacity.maxActiveSessions}
								· {selectedCapacity.runtimeClass} pool
								({selectedCapacity.runtimeReplicas}×{selectedCapacity.perSidecarWorkflowLimit} per-sidecar Dapr workflow slots)
							</span>
							{#if selectedCapacity.maxActiveSandboxes}
								<span>· sandbox cap {selectedCapacity.maxActiveSandboxes}</span>
							{/if}
						{/if}
					</div>
				{/if}
			</div>

			<!-- Agent -->
			<div class="space-y-1.5">
				<Label for="launch-agent">Agent</Label>
				{#if runnableAgents.length === 0}
					<Alert variant="destructive">
						<AlertDescription>
							No registered <code class="text-[11px]">dapr-agent-py</code> agents in this workspace.
							Publish an agent first.
						</AlertDescription>
					</Alert>
				{:else}
					<div class="relative">
						<Search class="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
						<Input
							id="launch-agent"
							bind:value={agentQuery}
							placeholder="Search agents…"
							class="h-9 pl-8"
						/>
					</div>
					<div class="max-h-64 min-h-24 overflow-y-auto overscroll-contain rounded-md border border-border bg-background">
						{#if visibleAgents.length === 0}
							<div class="px-3 py-6 text-center text-xs text-muted-foreground">
								No matching agents
							</div>
						{:else}
							{#each visibleAgents as agent (agent.id)}
								<button
									type="button"
									class={[
										'flex w-full items-center gap-2 border-b border-border/70 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
										agent.id === agentId ? 'bg-primary/10' : ''
									].join(' ')}
									aria-pressed={agent.id === agentId}
									onclick={() => selectAgent(agent)}
								>
									<span class="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
										<Bot class="size-3.5" />
									</span>
									<span class="min-w-0 flex-1">
										<span class="block truncate font-medium">{agent.name}</span>
										<span class="block truncate text-[11px] text-muted-foreground">
											v{agent.currentVersion}{agent.modelSpec ? ` · ${agent.modelSpec}` : ''}
										</span>
									</span>
									{#if agent.id === agentId}
										<Check class="size-4 shrink-0 text-primary" />
									{/if}
								</button>
							{/each}
						{/if}
					</div>
				{/if}
			</div>

			<!-- Model name / path -->
			<div class="space-y-1.5">
				<Label for="launch-model">Model name or path</Label>
				<Input
					id="launch-model"
					bind:value={modelNameOrPath}
					placeholder={selectedAgent?.modelSpec ? parseModelDefault(selectedAgent.modelSpec) : 'auto'}
				/>
				<p class="text-[10px] text-muted-foreground">
					Surfaces in <code>predictions.jsonl</code> as <code>model_name_or_path</code>.
				</p>
			</div>

			<!-- Model config label -->
			<div class="space-y-1.5">
				<Label for="launch-label">Model config label <span class="text-muted-foreground text-[11px]">(optional)</span></Label>
				<Input
					id="launch-label"
					bind:value={modelConfigLabel}
					placeholder="e.g. v1-mcp-toggle, no-skills, baseline"
				/>
				<p class="text-[10px] text-muted-foreground">
					Used as the comparison axis label when diffing runs. Highly recommended for experiments.
				</p>
			</div>

			<!-- Tags -->
			<div class="space-y-1.5">
				<Label for="launch-tags">Tags <span class="text-muted-foreground text-[11px]">(optional)</span></Label>
				<Input
					id="launch-tags"
					bind:value={tagsInput}
					placeholder="experiment-2026-04, mcp-ablation, weekly"
				/>
				{#if parseTags(tagsInput).length > 0}
					<div class="flex flex-wrap gap-1">
						{#each parseTags(tagsInput) as tag (tag)}
							<Badge variant="secondary" class="font-mono text-[10px]">#{tag}</Badge>
						{/each}
					</div>
				{/if}
				<p class="text-[10px] text-muted-foreground">
					Comma- or space-separated. Group runs into experiments for one-click comparison via the
					<code class="rounded bg-muted px-1">?tag=</code> filter on the Runs and Compare pages.
				</p>
			</div>

			<!-- Inference concurrency -->
			<div class="space-y-1.5">
				<Label for="launch-concurrency">Inference concurrency</Label>
				<div class="flex items-center gap-3">
					<input
						id="launch-concurrency"
						type="range"
						min="1"
						max={MAX_INFERENCE_CONCURRENCY}
						bind:value={concurrency}
						class="flex-1 accent-primary"
					/>
					<span class="font-mono text-sm tabular-nums w-10 text-right">{concurrency}</span>
				</div>
				<p class="text-[10px] text-muted-foreground">
					Will dispatch up to {effectiveInferenceConcurrency} active
					<code>swebench_instance_workflow</code> children after runtime admission and per-sidecar Dapr workflow caps.
				</p>
			</div>

			<!-- Evaluation concurrency -->
			<div class="space-y-1.5">
				<Label for="launch-eval-concurrency">Evaluation concurrency</Label>
				<div class="flex items-center gap-3">
					<input
						id="launch-eval-concurrency"
						type="range"
						min="1"
						max={MAX_EVALUATION_CONCURRENCY}
						bind:value={evaluationConcurrency}
						class="flex-1 accent-primary"
					/>
					<span class="font-mono text-sm tabular-nums w-10 text-right">{evaluationConcurrency}</span>
				</div>
				<p class="text-[10px] text-muted-foreground">
					Will keep up to {evaluationConcurrency} Kubernetes-native SWE-bench run-instance TaskRuns active during official grading.
				</p>
			</div>

			<!-- Timeout & resource class -->
			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-1.5">
					<Label for="launch-timeout">Timeout (seconds)</Label>
					<Input
						id="launch-timeout"
						type="number"
						min="60"
						max="86400"
						bind:value={timeoutSeconds}
					/>
				</div>
				<div class="space-y-1.5">
					<Label for="launch-resource">Evaluator resource class</Label>
					<select
						id="launch-resource"
						bind:value={evaluatorResourceClass}
						class="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
					>
						<option value="standard">Standard</option>
						<option value="large">Large</option>
						<option value="xlarge">XLarge</option>
					</select>
				</div>
			</div>

			{#if errorMessage}
				<Alert variant="destructive">
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			{/if}
		</div>

		<Sheet.Footer class="border-t border-border px-4 py-3 flex flex-row justify-end gap-2">
			<Button variant="outline" onclick={() => onOpenChange(false)} disabled={submitting}>
				Cancel
			</Button>
			<Button
				onclick={submit}
				disabled={submitting || instanceIds.length === 0 || !agentId || runnableAgents.length === 0}
			>
				{#if submitting}
					<Loader2 class="mr-1.5 h-3.5 w-3.5 animate-spin" />
					Starting…
				{:else}
					<Activity class="mr-1.5 h-3.5 w-3.5" />
					Start run · {instanceIds.length} {instanceIds.length === 1 ? 'instance' : 'instances'}
				{/if}
			</Button>
		</Sheet.Footer>
	</Sheet.Content>
</Sheet.Root>
