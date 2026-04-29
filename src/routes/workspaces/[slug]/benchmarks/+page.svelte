<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Tabs, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import {
		Activity,
		Bot,
		CheckCircle2,
		Clock3,
		Download,
		ExternalLink,
		FileDiff,
		FlaskConical,
		Hammer,
		RefreshCw,
		StopCircle,
		XCircle,
	} from 'lucide-svelte';

	type Suite = {
		id: string;
		slug: 'SWE-bench_Verified' | 'SWE-bench_Lite';
		name: string;
		description: string | null;
		datasetName: string;
		defaultInstanceLimit: number | null;
		instanceCount: number;
		runCount: number;
	};

	type Agent = {
		id: string;
		name: string;
		slug: string;
		runtime: string;
		currentVersion: number | null;
		modelSpec: { provider?: string; model?: string } | null;
		registryStatus: string;
	};

	type RunSummary = {
		id: string;
		suiteSlug: string;
		suiteName: string;
		agentName: string;
		agentSlug: string | null;
		agentVersion: number;
		status: RunStatus;
		modelNameOrPath: string;
		selectedInstanceIds: string[];
		concurrency: number;
		timeoutSeconds: number;
		evaluatorResourceClass: string;
		coordinatorExecutionId: string | null;
		evaluatorJobName: string | null;
		predictionsPath: string | null;
		summary: Record<string, number>;
		error: string | null;
		createdAt: string;
		updatedAt: string;
	};

	type RunInstance = {
		id: string;
		instanceId: string;
		status: string;
		inferenceStatus: string;
		evaluationStatus: string;
		repo: string | null;
		baseCommit: string | null;
		problemStatement: string | null;
		sessionId: string | null;
		workflowExecutionId: string | null;
		daprInstanceId: string | null;
		sandboxName: string | null;
		workspaceRef: string | null;
		modelPatch: string | null;
		patchBytes: number | null;
		error: string | null;
		inferenceError: string | null;
		evaluationError: string | null;
		logsPath: string | null;
		testOutputSummary: string | null;
		harnessResult: Record<string, unknown> | null;
		inferenceEnvironment: Record<string, unknown> | null;
		traceIds: string[];
		inferenceCompletedAt: string | null;
		evaluatedAt: string | null;
	};

	type RunDetail = RunSummary & {
		instances: RunInstance[];
		artifacts: Array<{ id: string; kind: string; path: string; createdAt: string }>;
	};

	type RunStatus = 'queued' | 'inferencing' | 'evaluating' | 'completed' | 'failed' | 'cancelled';

	type EnvironmentBuildSnapshot = {
		id: string;
		environmentKey: string;
		envSpecHash: string;
		buildStrategy: string;
		workspaceRoot: string | null;
		condaEnvironment: string | null;
		swebenchSpec: Record<string, unknown> | null;
		status: string;
		pipelineRunName: string | null;
		pipelineRunNamespace: string | null;
		pipelineRunUrl: string | null;
		buildLogRef: string | null;
		validationLogRef: string | null;
		validationCommand: string | null;
		digest: string | null;
		sandboxImage: string | null;
		error: string | null;
		startedAt: string | null;
		completedAt: string | null;
		builtAt: string | null;
	};

	type BuildActivityEvent = {
		id: string;
		buildId: string;
		eventType: string;
		taskRunName: string | null;
		phase: string | null;
		reason: string | null;
		message: string | null;
		timestamp: string;
	};

	type BuildActivityGroup = {
		runInstanceId: string;
		instanceId: string;
		build: EnvironmentBuildSnapshot | null;
		events: BuildActivityEvent[];
		latestEvent: BuildActivityEvent | null;
	};

	const slug = $derived((page.params.slug as string) ?? 'default');

	function selectOptimizeTab(tab: string) {
		if (tab === 'evals') {
			goto(`/workspaces/${slug}/evaluations?tab=evals`, { keepFocus: true, noScroll: true });
		} else if (tab === 'datasets') {
			goto(`/workspaces/${slug}/evaluations?tab=datasets`, { keepFocus: true, noScroll: true });
		}
	}

	let suites = $state<Suite[]>([]);
	let agents = $state<Agent[]>([]);
	let runs = $state<RunSummary[]>([]);
	let selectedRun = $state<RunDetail | null>(null);
	let selectedInstanceId = $state('');
	let loading = $state(true);
	let creating = $state(false);
	let errorMessage = $state<string | null>(null);
	let buildActivityByInstance = $state<Record<string, BuildActivityGroup>>({});

	let suiteSlug = $state<'SWE-bench_Verified' | 'SWE-bench_Lite'>('SWE-bench_Lite');
	let agentId = $state('');
	let instanceIdsText = $state('sympy__sympy-20590');
	let modelConfigLabel = $state('');
	let concurrency = $state(1);
	let timeoutSeconds = $state(7200);
	let maxTurns = $state(80);
	let evaluatorResourceClass = $state('standard');

	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let buildStream: EventSource | null = null;
	let buildStreamBuildId: string | null = null;
	let deepLinkConsumed = false;

	const runnableAgents = $derived(
		agents.filter((a) => a.runtime === 'dapr-agent-py' && a.registryStatus === 'registered' && a.currentVersion)
	);
	const selectedInstance = $derived(
		selectedRun?.instances.find((item) => item.instanceId === selectedInstanceId) ?? selectedRun?.instances[0] ?? null
	);
	const selectedBuildActivity = $derived(
		selectedInstance ? (buildActivityByInstance[selectedInstance.instanceId] ?? null) : null
	);
	const selectedBuildId = $derived(selectedBuildActivity?.build?.id ?? null);
	const activeRun = $derived(
		selectedRun?.status === 'queued' ||
			selectedRun?.status === 'inferencing' ||
			selectedRun?.status === 'evaluating'
	);
	const resolvedRate = $derived.by(() => {
		const summary = selectedRun?.summary;
		if (!summary || typeof summary.total !== 'number' || summary.total === 0) return 0;
		return Math.round(((summary.resolved ?? 0) / summary.total) * 100);
	});
	const inferenceCounts = $derived.by(() => countByStatus(selectedRun?.instances ?? [], 'inferenceStatus'));
	const evaluationCounts = $derived.by(() => countByStatus(selectedRun?.instances ?? [], 'evaluationStatus'));
	const inferenceDone = $derived.by(() =>
		(inferenceCounts.inferred ?? 0) +
		(inferenceCounts.error ?? 0) +
		(inferenceCounts.timeout ?? 0) +
		(inferenceCounts.cancelled ?? 0)
	);
	const evaluationDone = $derived.by(() =>
		(evaluationCounts.resolved ?? 0) +
		(evaluationCounts.unresolved ?? 0) +
		(evaluationCounts.empty_patch ?? 0) +
		(evaluationCounts.error ?? 0) +
		(evaluationCounts.timeout ?? 0) +
		(evaluationCounts.cancelled ?? 0)
	);
	const progressRate = $derived.by(() => {
		if (!selectedRun) return 0;
		const summary = selectedRun.summary ?? {};
		const total = selectedRun.instances.length || summary.total || 0;
		if (!total) return 0;
		const done =
			(summary.inferred ?? 0) +
			(summary.resolved ?? 0) +
			(summary.failed ?? 0) +
			(summary.error ?? 0) +
			(summary.timeout ?? 0) +
			(summary.cancelled ?? 0);
		return Math.round((done / total) * 100);
	});

	async function loadAll(opts: { silent?: boolean } = {}) {
		if (!opts.silent) {
			loading = true;
			errorMessage = null;
		}
		try {
			const [suitesRes, agentsRes, runsRes] = await Promise.all([
				fetch('/api/benchmarks/suites'),
				fetch('/api/agents'),
				fetch('/api/benchmarks/runs'),
			]);
			if (!suitesRes.ok) throw new Error(`Failed to load suites (${suitesRes.status})`);
			if (!agentsRes.ok) throw new Error(`Failed to load agents (${agentsRes.status})`);
			if (!runsRes.ok) throw new Error(`Failed to load runs (${runsRes.status})`);
			suites = ((await suitesRes.json()) as { suites: Suite[] }).suites ?? [];
			agents = ((await agentsRes.json()) as { agents: Agent[] }).agents ?? [];
			runs = ((await runsRes.json()) as { runs: RunSummary[] }).runs ?? [];
			if (!agentId && runnableAgents.length > 0) agentId = runnableAgents[0].id;
			const requestedRunId = deepLinkConsumed ? null : page.url.searchParams.get('run');
			if (requestedRunId) {
				deepLinkConsumed = true;
				await loadRun(requestedRunId, { silent: true });
			}
			else if (!selectedRun && runs.length > 0) await loadRun(runs[0].id, { silent: true });
			else if (selectedRun) await loadRun(selectedRun.id, { silent: true });
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			if (!opts.silent) loading = false;
		}
	}

	async function loadRun(runId: string, opts: { silent?: boolean } = {}) {
		try {
			const [runRes, activityRes] = await Promise.all([
				fetch(`/api/benchmarks/runs/${runId}`),
				fetch(`/api/benchmarks/runs/${runId}/activity?sync=0`),
			]);
			if (!runRes.ok) throw new Error(`Failed to load run (${runRes.status})`);
			selectedRun = ((await runRes.json()) as { run: RunDetail }).run;
			if (activityRes.ok) {
				const activity = (await activityRes.json()) as { instances: BuildActivityGroup[] };
				buildActivityByInstance = Object.fromEntries(
					(activity.instances ?? []).map((group) => [group.instanceId, group])
				);
			}
			const requestedInstanceId = page.url.searchParams.get('instance');
			if (requestedInstanceId && selectedRun.instances.find((i) => i.instanceId === requestedInstanceId)) {
				selectedInstanceId = requestedInstanceId;
			} else if (!selectedInstanceId || !selectedRun.instances.find((i) => i.instanceId === selectedInstanceId)) {
				selectedInstanceId = selectedRun.instances[0]?.instanceId ?? '';
			}
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		}
	}

	async function createRun() {
		creating = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/benchmarks/runs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					suiteSlug,
					agentId,
					instanceIds: instanceIdsText,
					modelConfigLabel: modelConfigLabel.trim() || undefined,
					concurrency,
					timeoutSeconds,
					maxTurns,
					evaluatorResourceClass,
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message ?? body.error ?? `Create failed (${res.status})`);
			selectedRun = body.run;
			selectedInstanceId = selectedRun?.instances[0]?.instanceId ?? '';
			buildActivityByInstance = {};
			await loadAll({ silent: true });
			if (body.coordinatorStartError) errorMessage = body.coordinatorStartError;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			creating = false;
		}
	}

	async function cancelRun() {
		if (!selectedRun) return;
		const res = await fetch(`/api/benchmarks/runs/${selectedRun.id}/cancel`, { method: 'POST' });
		if (!res.ok) {
			errorMessage = `Cancel failed (${res.status})`;
			return;
		}
		const body = (await res.json()) as { run: RunDetail };
		selectedRun = body.run;
		await loadAll({ silent: true });
	}

	function schedulePoll() {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = setTimeout(async () => {
			if (typeof document === 'undefined' || document.visibilityState === 'visible') {
				await loadAll({ silent: true });
			}
			schedulePoll();
		}, activeRun ? 4000 : 30000);
	}

	function statusColor(status: string): string {
		switch (status) {
			case 'completed':
			case 'resolved':
			case 'validated':
				return 'bg-emerald-500/15 text-emerald-600';
			case 'inferencing':
			case 'evaluating':
			case 'building':
				return 'bg-blue-500/15 text-blue-600';
			case 'queued':
			case 'inferred':
			case 'pending':
			case 'fallback':
				return 'bg-amber-500/15 text-amber-600';
			case 'unresolved':
			case 'empty_patch':
			case 'failed':
			case 'error':
			case 'timeout':
				return 'bg-red-500/15 text-red-600';
			case 'cancelled':
				return 'bg-gray-400/15 text-gray-600';
			default:
				return 'bg-muted text-muted-foreground';
		}
	}

	function countByStatus(items: RunInstance[], key: 'inferenceStatus' | 'evaluationStatus') {
		const counts: Record<string, number> = {};
		for (const item of items) {
			const status = item[key] || 'pending';
			counts[status] = (counts[status] ?? 0) + 1;
		}
		return counts;
	}

	function envField(env: Record<string, unknown> | null | undefined, key: string) {
		const value = env?.[key];
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}

	function envNestedField(env: Record<string, unknown> | null | undefined, parent: string, key: string) {
		return nestedStringField(env, parent, key);
	}

	function nestedStringField(record: unknown, parent: string, key: string) {
		if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
		const value = (record as Record<string, unknown>)[parent];
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		const child = (value as Record<string, unknown>)[key];
		return typeof child === 'string' && child.trim() ? child.trim() : null;
	}

	function envStringList(env: Record<string, unknown> | null | undefined, key: string) {
		const value = env?.[key];
		if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
		if (typeof value === 'string' && value.trim()) return [value.trim()];
		return [];
	}

	function inferenceEnvironmentStatus(env: Record<string, unknown> | null | undefined) {
		return envField(env, 'environmentStatus') ?? 'fallback';
	}

	function inferenceEnvironmentLabel(env: Record<string, unknown> | null | undefined) {
		const status = inferenceEnvironmentStatus(env);
		if (status === 'validated') return envField(env, 'environmentKey') ?? 'validated image';
		if (status === 'building' || status === 'queued') return envField(env, 'environmentKey') ?? 'building image';
		if (status === 'failed') return envField(env, 'environmentKey') ?? 'image build failed';
		return 'dapr-agent fallback';
	}

	function formatStatus(status: string | null | undefined): string {
		return (status || 'pending').replaceAll('_', ' ');
	}

	function formatBuildStrategy(strategy: string | null | undefined): string {
		if (strategy === 'swebench-harness') return 'SWE-bench harness spec';
		if (strategy === 'buildpacks') return 'Buildpacks fallback';
		return formatStatus(strategy);
	}

	function formatRelative(iso: string | null | undefined): string {
		if (!iso) return 'never';
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}

	function eventLabel(event: BuildActivityEvent | null | undefined): string {
		if (!event) return 'waiting for activity';
		const labels: Record<string, string> = {
			build_queued: 'Build queued',
			pipelinerun_created: 'PipelineRun created',
			task_started: 'Task started',
			task_succeeded: 'Task succeeded',
			task_failed: 'Task failed',
			validation_started: 'Validation started',
			validation_succeeded: 'Validation passed',
			validation_failed: 'Validation failed',
			image_pushed: 'Image pushed',
			digest_captured: 'Digest captured',
			build_succeeded: 'Build succeeded',
			build_failed: 'Build failed',
		};
		return labels[event.eventType] ?? formatStatus(event.eventType);
	}

	function activityStatus(group: BuildActivityGroup | null | undefined, env: Record<string, unknown> | null | undefined) {
		return group?.build?.status ?? inferenceEnvironmentStatus(env);
	}

	function shortDigest(value: string | null | undefined) {
		if (!value) return null;
		return value.length > 22 ? `${value.slice(0, 19)}...` : value;
	}

	function latestFailure(group: BuildActivityGroup | null | undefined): BuildActivityEvent | null {
		if (!group) return null;
		for (let index = group.events.length - 1; index >= 0; index -= 1) {
			const event = group.events[index];
			if (event.eventType.endsWith('_failed') || event.eventType === 'build_failed') return event;
		}
		return null;
	}

	function mergeBuildActivitySnapshot(snapshot: {
		build: EnvironmentBuildSnapshot;
		events: BuildActivityEvent[];
		latestEvent: BuildActivityEvent | null;
	}) {
		if (!selectedInstance) return;
		const existing = buildActivityByInstance[selectedInstance.instanceId];
		if (!existing) return;
		buildActivityByInstance = {
			...buildActivityByInstance,
			[selectedInstance.instanceId]: {
				...existing,
				build: snapshot.build,
				events: snapshot.events,
				latestEvent: snapshot.latestEvent,
			},
		};
	}

	function upsertBuildActivityEvent(event: BuildActivityEvent) {
		const entries = Object.entries(buildActivityByInstance);
		const match = entries.find(([, group]) => group.build?.id === event.buildId);
		if (!match) return;
		const [instanceId, group] = match;
		const events = group.events.some((item) => item.id === event.id)
			? group.events.map((item) => (item.id === event.id ? event : item))
			: [...group.events, event];
		buildActivityByInstance = {
			...buildActivityByInstance,
			[instanceId]: {
				...group,
				events,
				latestEvent: event,
			},
		};
	}

	$effect(() => {
		const buildId = selectedBuildId;
		if (typeof EventSource === 'undefined' || !buildId) {
			buildStream?.close();
			buildStream = null;
			buildStreamBuildId = null;
			return;
		}
		if (buildStreamBuildId === buildId) return;
		buildStream?.close();
		buildStreamBuildId = buildId;
		const stream = new EventSource(`/api/environment-builds/${encodeURIComponent(buildId)}/stream`);
		buildStream = stream;
		stream.addEventListener('snapshot', (event) => {
			try {
				mergeBuildActivitySnapshot(JSON.parse((event as MessageEvent).data));
			} catch {
				/* ignore malformed stream payloads */
			}
		});
		stream.addEventListener('activity_event', (event) => {
			try {
				upsertBuildActivityEvent(JSON.parse((event as MessageEvent).data));
			} catch {
				/* ignore malformed stream payloads */
			}
		});
		stream.addEventListener('terminal', () => {
			stream.close();
			if (buildStream === stream) {
				buildStream = null;
				buildStreamBuildId = null;
			}
		});
		stream.onerror = () => {
			stream.close();
			if (buildStream === stream) {
				buildStream = null;
				buildStreamBuildId = null;
			}
		};
		return () => {
			stream.close();
			if (buildStream === stream) {
				buildStream = null;
				buildStreamBuildId = null;
			}
		};
	});

	onMount(async () => {
		await loadAll();
		schedulePoll();
	});

	onDestroy(() => {
		if (pollTimer) clearTimeout(pollTimer);
		buildStream?.close();
	});
</script>

<svelte:head><title>Benchmarks</title></svelte:head>

<div class="h-full min-h-0 overflow-y-auto">
<div class="p-6 pb-10 space-y-5 max-w-7xl mx-auto w-full">
	<AppBreadcrumb
		items={[
			{ label: 'Workspace', href: `/workspaces/${slug}` },
			{ label: 'Benchmarks' }
		]}
	/>

	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold flex items-center gap-2">
				<FlaskConical class="size-6" /> Benchmarks
			</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Run SWE-bench Verified and Lite through published dapr-agent-py agents.
			</p>
		</div>
		<Button variant="outline" onclick={() => loadAll()}>
			<RefreshCw class="size-4" /> Refresh
		</Button>
	</header>

	<Tabs value="benchmarks" onValueChange={selectOptimizeTab}>
		<TabsList class="h-9">
			<TabsTrigger value="datasets" class="text-xs">Datasets</TabsTrigger>
			<TabsTrigger value="evals" class="text-xs">Evals</TabsTrigger>
			<TabsTrigger value="benchmarks" class="text-xs">Benchmarks</TabsTrigger>
		</TabsList>
	</Tabs>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<div class="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
		<section class="border rounded-lg p-4 space-y-4 bg-background">
			<div>
				<h2 class="text-base font-medium">New Run</h2>
				<p class="text-xs text-muted-foreground mt-1">
					Inference uses durable/run and the selected agent runtime pod.
				</p>
			</div>

			<div class="space-y-2">
				<Label for="suite">Suite</Label>
				<select id="suite" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={suiteSlug}>
					{#each suites as suite}
						<option value={suite.slug}>{suite.name}</option>
					{/each}
				</select>
			</div>

			<div class="space-y-2">
				<Label for="agent">Agent</Label>
				<select id="agent" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={agentId}>
					{#each runnableAgents as agent}
						<option value={agent.id}>
							{agent.name} v{agent.currentVersion} ({agent.slug})
						</option>
					{/each}
				</select>
				{#if runnableAgents.length === 0}
					<p class="text-xs text-red-600">No registered dapr-agent-py agents are available.</p>
				{/if}
			</div>

			<div class="space-y-2">
				<Label for="instances">Instance IDs</Label>
				<Textarea
					id="instances"
					class="min-h-28 font-mono text-xs"
					bind:value={instanceIdsText}
				/>
			</div>

			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-2">
					<Label for="concurrency">Concurrency</Label>
					<Input id="concurrency" type="number" min="1" max="32" bind:value={concurrency} />
				</div>
				<div class="space-y-2">
					<Label for="max-turns">Max Turns</Label>
					<Input id="max-turns" type="number" min="1" bind:value={maxTurns} />
				</div>
			</div>

			<div class="grid grid-cols-2 gap-3">
				<div class="space-y-2">
					<Label for="timeout">Timeout Seconds</Label>
					<Input id="timeout" type="number" min="60" bind:value={timeoutSeconds} />
				</div>
				<div class="space-y-2">
					<Label for="resource">Evaluator</Label>
					<select id="resource" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={evaluatorResourceClass}>
						<option value="standard">Standard</option>
						<option value="large">Large</option>
						<option value="xlarge">XLarge</option>
					</select>
				</div>
			</div>

			<div class="space-y-2">
				<Label for="label">Model Label</Label>
				<Input id="label" placeholder="agent label for predictions.jsonl" bind:value={modelConfigLabel} />
			</div>

			<Button class="w-full" onclick={createRun} disabled={creating || !agentId || runnableAgents.length === 0}>
				<Activity class="size-4" /> {creating ? 'Creating...' : 'Start benchmark'}
			</Button>
		</section>

		<section class="space-y-5 min-w-0">
			<div class="border rounded-lg bg-background overflow-hidden">
				<div class="px-4 py-3 border-b flex items-center justify-between gap-3">
					<div>
						<h2 class="text-base font-medium">Runs</h2>
						<p class="text-xs text-muted-foreground">{runs.length} recent benchmark runs</p>
					</div>
				</div>
				<div class="divide-y max-h-72 overflow-auto">
					{#if loading}
						<div class="p-4 text-sm text-muted-foreground">Loading benchmarks...</div>
					{:else if runs.length === 0}
						<div class="p-4 text-sm text-muted-foreground">No benchmark runs yet.</div>
					{:else}
						{#each runs as run}
							<button
								type="button"
								class="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors {selectedRun?.id === run.id ? 'bg-muted/60' : ''}"
								onclick={() => loadRun(run.id)}
							>
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0">
										<div class="flex items-center gap-2 min-w-0">
											<span class="font-medium truncate">{run.suiteName}</span>
											<Badge class={statusColor(run.status)}>{run.status}</Badge>
										</div>
										<div class="text-xs text-muted-foreground mt-1 truncate">
											{run.agentName} · {run.selectedInstanceIds.length} instances · {formatRelative(run.createdAt)}
										</div>
									</div>
									<div class="text-xs text-muted-foreground shrink-0">{Math.round(((run.summary?.resolved ?? 0) / Math.max(run.summary?.total ?? run.selectedInstanceIds.length, 1)) * 100)}%</div>
								</div>
							</button>
						{/each}
					{/if}
				</div>
			</div>

			{#if selectedRun}
				<div class="border rounded-lg bg-background overflow-hidden">
					<div class="px-4 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
						<div>
							<div class="flex items-center gap-2">
								<h2 class="text-base font-medium">{selectedRun.suiteName}</h2>
								<Badge class={statusColor(selectedRun.status)}>{selectedRun.status}</Badge>
							</div>
							<p class="text-xs text-muted-foreground mt-1">
								{selectedRun.modelNameOrPath} · concurrency {selectedRun.concurrency} · {formatRelative(selectedRun.createdAt)}
							</p>
						</div>
						<div class="flex items-center gap-2">
							<a href={`/api/benchmarks/runs/${selectedRun.id}/predictions.jsonl`}>
								<Button variant="outline" size="sm">
									<Download class="size-4" /> Predictions
								</Button>
							</a>
							{#if activeRun}
								<Button variant="destructive" size="sm" onclick={cancelRun}>
									<StopCircle class="size-4" /> Cancel
								</Button>
							{/if}
						</div>
					</div>

					<div class="p-4 grid gap-4 md:grid-cols-5">
						<div class="space-y-1">
							<div class="text-xs text-muted-foreground">Progress</div>
							<div class="text-2xl font-semibold">{progressRate}%</div>
							<div class="h-1.5 rounded-full bg-muted overflow-hidden">
								<div class="h-full bg-blue-500" style={`width: ${progressRate}%`}></div>
							</div>
						</div>
						<div class="space-y-1">
							<div class="text-xs text-muted-foreground">Resolved</div>
							<div class="text-2xl font-semibold">{resolvedRate}%</div>
							<div class="text-xs text-muted-foreground">{selectedRun.summary?.resolved ?? 0} of {selectedRun.summary?.total ?? selectedRun.instances.length}</div>
						</div>
						<div class="space-y-1">
							<div class="text-xs text-muted-foreground">Inference</div>
							<div class="text-2xl font-semibold">{inferenceDone}</div>
							<div class="text-xs text-muted-foreground">of {selectedRun.instances.length} finished</div>
						</div>
						<div class="space-y-1">
							<div class="text-xs text-muted-foreground">Official Harness</div>
							<div class="text-2xl font-semibold">{evaluationDone}</div>
							<div class="text-xs text-muted-foreground">of {selectedRun.instances.length} graded</div>
						</div>
						<div class="space-y-1">
							<div class="text-xs text-muted-foreground">Evaluator Job</div>
							<div class="text-sm font-mono truncate">{selectedRun.evaluatorJobName ?? 'pending'}</div>
						</div>
					</div>

					<div class="px-4 pb-4 grid gap-3 md:grid-cols-2 text-xs text-muted-foreground">
						<div>
							<div class="mb-1">Predictions Artifact</div>
							<div class="font-mono break-all text-foreground">{selectedRun.predictionsPath ?? 'pending'}</div>
						</div>
						<div class="space-y-1">
							<div class="text-xs text-muted-foreground">Coordinator</div>
							<div class="text-sm font-mono truncate">{selectedRun.coordinatorExecutionId ?? 'not started'}</div>
						</div>
					</div>

					{#if selectedRun.error}
						<div class="px-4 pb-4">
							<Alert variant="destructive">
								<AlertDescription>{selectedRun.error}</AlertDescription>
							</Alert>
						</div>
					{/if}

					{#if selectedRun.artifacts.length > 0}
						<div class="px-4 pb-4 text-xs">
							<div class="text-muted-foreground mb-2">Artifacts</div>
							<div class="rounded-md border divide-y">
								{#each selectedRun.artifacts as artifact}
									<div class="px-3 py-2 grid grid-cols-[120px_minmax(0,1fr)] gap-3">
										<span class="text-muted-foreground">{artifact.kind}</span>
										<span class="font-mono break-all">{artifact.path}</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>

				<div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
					<div class="border rounded-lg bg-background overflow-hidden min-w-0">
						<div class="px-4 py-3 border-b">
							<h2 class="text-base font-medium">Instances</h2>
						</div>
						<div class="overflow-auto">
							<table class="w-full text-sm">
								<thead class="bg-muted/50 text-xs text-muted-foreground">
									<tr>
										<th class="text-left font-medium px-4 py-2">Instance</th>
										<th class="text-left font-medium px-4 py-2">Repo</th>
										<th class="text-left font-medium px-4 py-2">Env</th>
										<th class="text-left font-medium px-4 py-2">Inference</th>
										<th class="text-left font-medium px-4 py-2">Official Harness</th>
										<th class="text-left font-medium px-4 py-2">Final</th>
										<th class="text-right font-medium px-4 py-2">Patch</th>
									</tr>
								</thead>
								<tbody class="divide-y">
									{#each selectedRun.instances as instance}
										<tr
											class="cursor-pointer hover:bg-muted/40 {selectedInstanceId === instance.instanceId ? 'bg-muted/60' : ''}"
											onclick={() => (selectedInstanceId = instance.instanceId)}
										>
											<td class="px-4 py-2 font-mono text-xs">{instance.instanceId}</td>
											<td class="px-4 py-2">{instance.repo ?? 'pending import'}</td>
											<td class="px-4 py-2"><Badge class={statusColor(inferenceEnvironmentStatus(instance.inferenceEnvironment))}>{inferenceEnvironmentLabel(instance.inferenceEnvironment)}</Badge></td>
											<td class="px-4 py-2"><Badge class={statusColor(instance.inferenceStatus)}>{formatStatus(instance.inferenceStatus)}</Badge></td>
											<td class="px-4 py-2"><Badge class={statusColor(instance.evaluationStatus)}>{formatStatus(instance.evaluationStatus)}</Badge></td>
											<td class="px-4 py-2"><Badge class={statusColor(instance.status)}>{formatStatus(instance.status)}</Badge></td>
											<td class="px-4 py-2 text-right text-xs text-muted-foreground">
												{instance.patchBytes ? `${instance.patchBytes} B` : '—'}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>

					<aside class="border rounded-lg bg-background overflow-hidden min-w-0">
						<div class="px-4 py-3 border-b">
							<h2 class="text-base font-medium">Instance Detail</h2>
						</div>
						{#if selectedInstance}
							<div class="p-4 space-y-4">
								<div>
									<div class="font-mono text-xs break-all">{selectedInstance.instanceId}</div>
									<div class="flex items-center gap-2 mt-2 flex-wrap">
										<Badge class={statusColor(selectedInstance.status)}>{formatStatus(selectedInstance.status)}</Badge>
										{#if selectedInstance.sessionId}
											<a class="text-xs text-blue-600 inline-flex items-center gap-1" href={`/workspaces/${slug}/sessions/${selectedInstance.sessionId}`}>
												<Bot class="size-3" /> Session <ExternalLink class="size-3" />
											</a>
										{/if}
									</div>
								</div>

								<div class="grid grid-cols-2 gap-3 text-xs">
									<div class="rounded-md border p-3">
										<div class="text-muted-foreground mb-1">Inference</div>
										<Badge class={statusColor(selectedInstance.inferenceStatus)}>{formatStatus(selectedInstance.inferenceStatus)}</Badge>
										<div class="text-muted-foreground mt-2">{selectedInstance.inferenceCompletedAt ? formatRelative(selectedInstance.inferenceCompletedAt) : 'not finished'}</div>
									</div>
									<div class="rounded-md border p-3">
										<div class="text-muted-foreground mb-1">Official Harness</div>
										<Badge class={statusColor(selectedInstance.evaluationStatus)}>{formatStatus(selectedInstance.evaluationStatus)}</Badge>
										<div class="text-muted-foreground mt-2">{selectedInstance.evaluatedAt ? formatRelative(selectedInstance.evaluatedAt) : 'not graded'}</div>
									</div>
								</div>

								<div class="rounded-md border p-3 text-xs space-y-2">
									<div class="flex items-center justify-between gap-2">
										<div class="text-muted-foreground">Inference Environment</div>
										<Badge class={statusColor(inferenceEnvironmentStatus(selectedInstance.inferenceEnvironment))}>{formatStatus(inferenceEnvironmentStatus(selectedInstance.inferenceEnvironment))}</Badge>
									</div>
									<div class="space-y-1 text-muted-foreground">
										<div>Template: <span class="font-mono">{envField(selectedInstance.inferenceEnvironment, 'sandboxTemplate') ?? 'dapr-agent'}</span></div>
										{#if envField(selectedInstance.inferenceEnvironment, 'buildStrategy')}
											<div>Build strategy: <span class="font-mono">{formatBuildStrategy(envField(selectedInstance.inferenceEnvironment, 'buildStrategy'))}</span></div>
										{/if}
										{#if envField(selectedInstance.inferenceEnvironment, 'workspaceRoot')}
											<div>Workspace root: <span class="font-mono">{envField(selectedInstance.inferenceEnvironment, 'workspaceRoot')}</span></div>
										{/if}
										{#if envField(selectedInstance.inferenceEnvironment, 'pipelineRunName')}
											<div>PipelineRun: <span class="font-mono break-all">{envField(selectedInstance.inferenceEnvironment, 'pipelineRunName')}</span></div>
										{/if}
										{#if envField(selectedInstance.inferenceEnvironment, 'envSpecHash')}
											<div>Spec hash: <span class="font-mono break-all">{envField(selectedInstance.inferenceEnvironment, 'envSpecHash')}</span></div>
										{/if}
										{#if envNestedField(selectedInstance.inferenceEnvironment, 'swebenchSpec', 'instanceImageKey')}
											<div>Harness image key: <span class="font-mono break-all">{envNestedField(selectedInstance.inferenceEnvironment, 'swebenchSpec', 'instanceImageKey')}</span></div>
										{/if}
										{#if envField(selectedInstance.inferenceEnvironment, 'sandboxImage')}
											<div>Image: <span class="font-mono break-all">{envField(selectedInstance.inferenceEnvironment, 'sandboxImage')}</span></div>
										{/if}
										{#if envField(selectedInstance.inferenceEnvironment, 'digest')}
											<div>Digest: <span class="font-mono break-all">{envField(selectedInstance.inferenceEnvironment, 'digest')}</span></div>
										{/if}
										{#if envField(selectedInstance.inferenceEnvironment, 'buildLogRef')}
											<div>Build log: <span class="font-mono break-all">{envField(selectedInstance.inferenceEnvironment, 'buildLogRef')}</span></div>
										{/if}
										{#if envField(selectedInstance.inferenceEnvironment, 'validationLogRef')}
											<div>Validation: <span class="font-mono break-all">{envField(selectedInstance.inferenceEnvironment, 'validationLogRef')}</span></div>
										{/if}
										{#if envField(selectedInstance.inferenceEnvironment, 'validationCommand')}
											<div>Validation command: <span class="font-mono break-all">{envField(selectedInstance.inferenceEnvironment, 'validationCommand')}</span></div>
										{/if}
										{#each envStringList(selectedInstance.inferenceEnvironment, 'environmentNotes') as note}
											<div>Note: <span>{note}</span></div>
										{/each}
										{#if envField(selectedInstance.inferenceEnvironment, 'reason')}
											<div>Reason: <span class="font-mono">{envField(selectedInstance.inferenceEnvironment, 'reason')}</span></div>
										{/if}
									</div>
								</div>

								<div class="rounded-md border p-3 text-xs space-y-3">
									<div class="flex items-center justify-between gap-2">
										<div class="flex items-center gap-1.5 text-muted-foreground">
											<Hammer class="size-3" /> Environment Activity
										</div>
										<Badge class={statusColor(activityStatus(selectedBuildActivity, selectedInstance.inferenceEnvironment))}>
											{formatStatus(activityStatus(selectedBuildActivity, selectedInstance.inferenceEnvironment))}
										</Badge>
									</div>

									{#if selectedBuildActivity?.build}
										<div class="space-y-1 text-muted-foreground">
											<div>Key: <span class="font-mono text-foreground">{selectedBuildActivity.build.environmentKey}</span></div>
											{#if selectedBuildActivity.build.buildStrategy}
												<div>Build strategy: <span class="font-mono text-foreground">{formatBuildStrategy(selectedBuildActivity.build.buildStrategy)}</span></div>
											{/if}
											{#if selectedBuildActivity.build.workspaceRoot}
												<div>Workspace root: <span class="font-mono text-foreground">{selectedBuildActivity.build.workspaceRoot}</span></div>
											{/if}
											{#if selectedBuildActivity.build.envSpecHash}
												<div>Spec hash: <span class="font-mono break-all text-foreground">{selectedBuildActivity.build.envSpecHash}</span></div>
											{/if}
											{#if nestedStringField(selectedBuildActivity.build, 'swebenchSpec', 'instanceImageKey')}
												<div>Harness image key: <span class="font-mono break-all text-foreground">{nestedStringField(selectedBuildActivity.build, 'swebenchSpec', 'instanceImageKey')}</span></div>
											{/if}
											{#if selectedBuildActivity.build.pipelineRunName}
												<div class="flex items-center gap-1 min-w-0">
													<span>PipelineRun:</span>
													{#if selectedBuildActivity.build.pipelineRunUrl}
														<a
															class="font-mono text-blue-600 hover:underline truncate inline-flex items-center gap-1 min-w-0"
															href={selectedBuildActivity.build.pipelineRunUrl}
															target="_blank"
															rel="noreferrer"
														>
															<span class="truncate">{selectedBuildActivity.build.pipelineRunName}</span>
															<ExternalLink class="size-3 shrink-0" />
														</a>
													{:else}
														<span class="font-mono break-all text-foreground">{selectedBuildActivity.build.pipelineRunName}</span>
													{/if}
												</div>
											{/if}
											{#if selectedBuildActivity.build.digest}
												<div>Digest: <span class="font-mono text-foreground">{shortDigest(selectedBuildActivity.build.digest)}</span></div>
											{/if}
											{#if selectedBuildActivity.build.validationLogRef}
												<div>Validation log: <span class="font-mono break-all text-foreground">{selectedBuildActivity.build.validationLogRef}</span></div>
											{/if}
										</div>

										{@const failure = latestFailure(selectedBuildActivity)}
										{#if failure}
											<Alert variant="destructive">
												<AlertDescription>
													{eventLabel(failure)}{failure.taskRunName ? ` in ${failure.taskRunName}` : ''}: {failure.message ?? failure.reason ?? 'build failed'}
												</AlertDescription>
											</Alert>
										{/if}

										<div class="space-y-2">
											{#if selectedBuildActivity.events.length === 0}
												<div class="text-muted-foreground">Waiting for Tekton activity.</div>
											{:else}
												{#each selectedBuildActivity.events as event}
													{@const isFailure = event.eventType.endsWith('_failed') || event.eventType === 'build_failed'}
													{@const isSuccess = event.eventType.endsWith('_succeeded') || event.eventType === 'image_pushed' || event.eventType === 'digest_captured'}
													<div class="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
														<div class="pt-0.5">
															{#if isFailure}
																<XCircle class="size-3.5 text-red-600" />
															{:else if isSuccess}
																<CheckCircle2 class="size-3.5 text-emerald-600" />
															{:else}
																<Clock3 class="size-3.5 text-blue-600" />
															{/if}
														</div>
														<div class="min-w-0">
															<div class="flex items-center justify-between gap-2">
																<span class="font-medium">{eventLabel(event)}</span>
																<span class="text-muted-foreground shrink-0">{formatRelative(event.timestamp)}</span>
															</div>
															<div class="text-muted-foreground break-words">
																{event.phase ?? event.taskRunName ?? event.reason ?? ''}
																{#if event.message}
																	<span class="font-mono"> {event.message}</span>
																{/if}
															</div>
														</div>
													</div>
												{/each}
											{/if}
										</div>
									{:else}
										<div class="text-muted-foreground">
											No build activity has been recorded for this instance yet.
										</div>
									{/if}
								</div>

								{#if selectedInstance.problemStatement}
									<div>
										<div class="text-xs text-muted-foreground mb-1">Problem</div>
										<p class="text-sm max-h-32 overflow-auto whitespace-pre-wrap">{selectedInstance.problemStatement}</p>
									</div>
								{/if}

								{#if selectedInstance.inferenceError}
									<Alert variant="destructive">
										<AlertDescription>Inference: {selectedInstance.inferenceError}</AlertDescription>
									</Alert>
								{/if}

								{#if selectedInstance.evaluationError}
									<Alert variant="destructive">
										<AlertDescription>Official harness: {selectedInstance.evaluationError}</AlertDescription>
									</Alert>
								{:else if selectedInstance.error}
									<Alert variant="destructive">
										<AlertDescription>{selectedInstance.error}</AlertDescription>
									</Alert>
								{/if}

								<div>
									<div class="flex items-center gap-2 text-xs text-muted-foreground mb-2">
										<FileDiff class="size-3" /> Patch Diff
									</div>
									<pre class="text-xs rounded-md bg-muted p-3 max-h-80 overflow-auto whitespace-pre-wrap">{selectedInstance.modelPatch || 'No patch captured yet.'}</pre>
								</div>

								{#if selectedInstance.testOutputSummary}
									<div>
										<div class="text-xs text-muted-foreground mb-1">Test Output</div>
										<pre class="text-xs rounded-md bg-muted p-3 max-h-40 overflow-auto whitespace-pre-wrap">{selectedInstance.testOutputSummary}</pre>
									</div>
								{/if}

								<div class="text-xs text-muted-foreground space-y-1">
									<div>Workflow: <span class="font-mono">{selectedInstance.workflowExecutionId ?? 'pending'}</span></div>
									<div>Dapr: <span class="font-mono">{selectedInstance.daprInstanceId ?? 'pending'}</span></div>
									<div>Sandbox: <span class="font-mono">{selectedInstance.sandboxName ?? 'pending'}</span></div>
									<div>Logs: <span class="font-mono break-all">{selectedInstance.logsPath ?? 'pending'}</span></div>
									{#if selectedInstance.traceIds?.length}
										<div>Trace: <span class="font-mono break-all">{selectedInstance.traceIds.join(', ')}</span></div>
									{/if}
								</div>
							</div>
						{:else}
							<div class="p-4 text-sm text-muted-foreground">Select an instance.</div>
						{/if}
					</aside>
				</div>
			{/if}
		</section>
	</div>
</div>
</div>
