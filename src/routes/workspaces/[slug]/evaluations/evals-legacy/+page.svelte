<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import {
		Activity,
		Database,
		Download,
		FileJson,
		FlaskConical,
		Play,
		RefreshCw,
		Save,
		StopCircle,
	} from '@lucide/svelte';

	type Dataset = {
		id: string;
		name: string;
		description: string | null;
		sourceType: string;
		rowCount: number;
		createdAt: string;
		updatedAt: string;
	};

	type DatasetRow = {
		id: string;
		externalId: string | null;
		input: Record<string, unknown>;
		expectedOutput: unknown;
		generatedOutput: unknown;
		annotations: Record<string, unknown>;
		rating: number | null;
		feedback: string | null;
		createdAt: string;
		updatedAt: string;
	};

	type DatasetDetail = Dataset & { rows: DatasetRow[] };

	type Agent = {
		id: string;
		name: string;
		slug: string;
		runtime: string;
		currentVersion: number | null;
		registryStatus: string;
	};

	type WorkflowOption = {
		id: string;
		name: string;
		engineType: string | null;
		createdAt: string;
		updatedAt: string;
	};

	type Grader = {
		id: string;
		name: string;
		type: GraderType;
		config: Record<string, unknown>;
		enabled: boolean;
	};

	type Evaluation = {
		id: string;
		name: string;
		description: string | null;
		datasetId: string | null;
		datasetName: string | null;
		taskConfig: Record<string, unknown>;
		latestRun: RunSummary | null;
		createdAt: string;
	};

	type EvaluationDetail = Evaluation & {
		graders: Grader[];
		runs: RunSummary[];
	};

	type RunStatus = 'queued' | 'running' | 'grading' | 'completed' | 'failed' | 'cancelled';
	type ItemStatus = 'queued' | 'running' | 'grading' | 'passed' | 'failed' | 'error' | 'cancelled' | 'skipped';
	type GraderType =
		| 'string_check'
		| 'text_similarity'
		| 'score_model'
		| 'python'
		| 'multi'
		| 'external_harness';

	type RunSummary = {
		id: string;
		evaluationId: string;
		evaluationName: string | null;
		datasetName: string | null;
		status: RunStatus;
		subjectType: string;
		subjectId: string | null;
		summary: Record<string, number | string | null | Record<string, unknown>>;
		error: string | null;
		createdAt: string;
		updatedAt: string;
	};

	type RunItem = {
		id: string;
		rowIndex: number;
		status: ItemStatus;
		input: Record<string, unknown>;
		expectedOutput: unknown;
		generatedOutput: unknown;
		graderResults: Record<string, unknown>;
		scores: Record<string, unknown>;
		error: string | null;
	};

	type RunDetail = RunSummary & {
		items: RunItem[];
		artifacts: Array<{ id: string; kind: string; path: string | null; createdAt: string }>;
	};

	const slug = $derived((page.params.slug as string) ?? 'default');
	const graderTypes: GraderType[] = [
		'string_check',
		'text_similarity',
		'score_model',
		'python',
		'multi',
		'external_harness',
	];

	let activeTab = $state('datasets');
	let datasets = $state<Dataset[]>([]);
	let evaluations = $state<Evaluation[]>([]);
	let runs = $state<RunSummary[]>([]);
	let agents = $state<Agent[]>([]);
	let workflows = $state<WorkflowOption[]>([]);
	let selectedDataset = $state<DatasetDetail | null>(null);
	let selectedEvaluation = $state<EvaluationDetail | null>(null);
	let selectedRun = $state<RunDetail | null>(null);
	let selectedRowId = $state('');
	let selectedRunItemId = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let errorMessage = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	let newDatasetName = $state('');
	let newDatasetDescription = $state('');
	let importFormat = $state<'jsonl' | 'json' | 'csv'>('jsonl');
	let importContent = $state('');
	let swebenchSuiteSlug = $state('SWE-bench_Lite');
	let swebenchName = $state('SWE-bench Lite');
	let swebenchFormat = $state<'jsonl' | 'json' | 'csv'>('jsonl');
	let swebenchContent = $state('');
	let swebenchInstanceIds = $state('');

	let rowExternalId = $state('');
	let rowInputText = $state('{\n  "prompt": ""\n}');
	let rowExpectedText = $state('""');
	let rowGeneratedText = $state('');
	let rowFeedback = $state('');
	let rowRating = $state<number | null>(null);

	let newEvalName = $state('');
	let newEvalDescription = $state('');
	let newEvalDatasetId = $state('');
	let graderType = $state<GraderType>('string_check');
	let graderName = $state('Expected output match');
	let stringOperation = $state('equals');
	let similarityThreshold = $state(0.8);

	let runEvaluationId = $state('');
	let runImportedOutputs = $state('');
	let runSubjectType = $state<'imported_outputs' | 'agent' | 'workflow'>('imported_outputs');
	let runAgentId = $state('');
	let runWorkflowId = $state('');
	let runConcurrency = $state(1);
	let runTimeoutSeconds = $state(7200);

	const runnableAgents = $derived(
		agents.filter((agent) => agent.registryStatus === 'registered' && agent.currentVersion)
	);
	const selectedRow = $derived(
		selectedDataset?.rows.find((row) => row.id === selectedRowId) ?? selectedDataset?.rows[0] ?? null
	);
	const selectedRunItem = $derived(
		selectedRun?.items.find((item) => item.id === selectedRunItemId) ?? selectedRun?.items[0] ?? null
	);
	const activeRun = $derived(
		selectedRun?.status === 'queued' || selectedRun?.status === 'running' || selectedRun?.status === 'grading'
	);

	async function loadAll(opts: { silent?: boolean } = {}) {
		if (!opts.silent) {
			loading = true;
			errorMessage = null;
		}
		try {
			const [datasetsRes, evalsRes, runsRes, agentsRes, workflowsRes] = await Promise.all([
				fetch('/api/evaluations/datasets'),
				fetch('/api/evaluations/evals'),
				fetch('/api/evaluations/runs'),
				fetch('/api/agents'),
				fetch('/api/workflows?projectOnly=1'),
			]);
			if (!datasetsRes.ok) throw new Error(`Failed to load datasets (${datasetsRes.status})`);
			if (!evalsRes.ok) throw new Error(`Failed to load evals (${evalsRes.status})`);
			if (!runsRes.ok) throw new Error(`Failed to load runs (${runsRes.status})`);
			if (!agentsRes.ok) throw new Error(`Failed to load agents (${agentsRes.status})`);
			if (!workflowsRes.ok) throw new Error(`Failed to load workflows (${workflowsRes.status})`);
			datasets = ((await datasetsRes.json()) as { datasets: Dataset[] }).datasets ?? [];
			evaluations = ((await evalsRes.json()) as { evaluations: Evaluation[] }).evaluations ?? [];
			runs = ((await runsRes.json()) as { runs: RunSummary[] }).runs ?? [];
			const loadedAgents = ((await agentsRes.json()) as { agents: Agent[] }).agents ?? [];
			agents = loadedAgents;
			workflows = ((await workflowsRes.json()) as WorkflowOption[]) ?? [];
			if (!newEvalDatasetId && datasets[0]) newEvalDatasetId = datasets[0].id;
			if (!runEvaluationId && evaluations[0]) runEvaluationId = evaluations[0].id;
			const firstRunnableAgent = loadedAgents.find((agent) => agent.registryStatus === 'registered' && agent.currentVersion);
			if (!runAgentId && firstRunnableAgent) runAgentId = firstRunnableAgent.id;
			if (!runWorkflowId && workflows[0]) runWorkflowId = workflows[0].id;
			if (!selectedDataset && datasets[0]) await loadDataset(datasets[0].id, { silent: true });
			else if (selectedDataset) await loadDataset(selectedDataset.id, { silent: true });
			if (!selectedEvaluation && evaluations[0]) await loadEvaluation(evaluations[0].id, { silent: true });
			else if (selectedEvaluation) await loadEvaluation(selectedEvaluation.id, { silent: true });
			if (!selectedRun && runs[0]) await loadRun(runs[0].id, { silent: true });
			else if (selectedRun) await loadRun(selectedRun.id, { silent: true });
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			if (!opts.silent) loading = false;
		}
	}

	async function loadDataset(datasetId: string, opts: { silent?: boolean } = {}) {
		try {
			const res = await fetch(`/api/evaluations/datasets/${datasetId}`);
			if (!res.ok) throw new Error(`Failed to load dataset (${res.status})`);
			selectedDataset = ((await res.json()) as { dataset: DatasetDetail }).dataset;
			if (!selectedRowId || !selectedDataset.rows.find((row) => row.id === selectedRowId)) {
				selectRow(selectedDataset.rows[0] ?? null);
			}
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		}
	}

	async function loadEvaluation(evaluationId: string, opts: { silent?: boolean } = {}) {
		try {
			const res = await fetch(`/api/evaluations/evals/${evaluationId}`);
			if (!res.ok) throw new Error(`Failed to load evaluation (${res.status})`);
			selectedEvaluation = ((await res.json()) as { evaluation: EvaluationDetail }).evaluation;
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		}
	}

	async function loadRun(runId: string, opts: { silent?: boolean } = {}) {
		try {
			const res = await fetch(`/api/evaluations/runs/${runId}`);
			if (!res.ok) throw new Error(`Failed to load run (${res.status})`);
			selectedRun = ((await res.json()) as { run: RunDetail }).run;
			if (!selectedRunItemId || !selectedRun.items.find((item) => item.id === selectedRunItemId)) {
				selectedRunItemId = selectedRun.items[0]?.id ?? '';
			}
		} catch (err) {
			if (!opts.silent) errorMessage = err instanceof Error ? err.message : String(err);
		}
	}

	function selectRow(row: DatasetRow | null) {
		selectedRowId = row?.id ?? '';
		rowExternalId = row?.externalId ?? '';
		rowInputText = stringify(row?.input ?? { prompt: '' });
		rowExpectedText = stringify(row?.expectedOutput ?? '');
		rowGeneratedText = row?.generatedOutput === null || row?.generatedOutput === undefined ? '' : stringify(row.generatedOutput);
		rowFeedback = row?.feedback ?? '';
		rowRating = row?.rating ?? null;
	}

	async function createDataset() {
		saving = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/evaluations/datasets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: newDatasetName,
					description: newDatasetDescription || null,
					rows: [{ input: { prompt: '' }, expectedOutput: '', generatedOutput: '' }],
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message ?? body.error ?? `Create failed (${res.status})`);
			newDatasetName = '';
			newDatasetDescription = '';
			await loadAll({ silent: true });
			selectedDataset = body.dataset;
			selectRow(selectedDataset?.rows[0] ?? null);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function importRows() {
		if (!selectedDataset) return;
		saving = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/evaluations/datasets/${selectedDataset.id}/import`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ format: importFormat, content: importContent }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message ?? body.error ?? `Import failed (${res.status})`);
			importContent = '';
			await loadDataset(selectedDataset.id);
			await loadAll({ silent: true });
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function addRow() {
		if (!selectedDataset) return;
		const res = await fetch(`/api/evaluations/datasets/${selectedDataset.id}/rows`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				externalId: 'row-' + (selectedDataset.rows.length + 1),
				input: { prompt: '' },
				expectedOutput: '',
				generatedOutput: '',
			}),
		});
		if (!res.ok) {
			errorMessage = `Add row failed (${res.status})`;
			return;
		}
		await loadDataset(selectedDataset.id);
		await loadAll({ silent: true });
	}

	async function saveSelectedRow() {
		if (!selectedDataset || !selectedRow) return;
		saving = true;
		errorMessage = null;
		try {
			const input = parseJsonValue(rowInputText, 'row input');
			if (!isRecord(input)) throw new Error('row input must be a JSON object');
			const expectedOutput = parseJsonValue(rowExpectedText, 'expected output');
			const generatedOutput = rowGeneratedText.trim() ? parseJsonValue(rowGeneratedText, 'generated output') : null;
			const res = await fetch(`/api/evaluations/datasets/${selectedDataset.id}/rows/${selectedRow.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					externalId: rowExternalId || null,
					input,
					expectedOutput,
					generatedOutput,
					feedback: rowFeedback || null,
					rating: rowRating,
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message ?? body.error ?? `Save failed (${res.status})`);
			await loadDataset(selectedDataset.id);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function createEvaluation() {
		saving = true;
		errorMessage = null;
		try {
			const config =
				graderType === 'text_similarity'
					? { threshold: similarityThreshold }
					: graderType === 'string_check'
						? { operation: stringOperation }
						: graderType === 'external_harness'
							? { resultPath: 'generatedOutput', passPath: 'resolved' }
							: {};
			const res = await fetch('/api/evaluations/evals', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: newEvalName,
					description: newEvalDescription || null,
					datasetId: newEvalDatasetId || null,
					graders: [{ name: graderName || graderType, type: graderType, config }],
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message ?? body.error ?? `Create failed (${res.status})`);
			newEvalName = '';
			newEvalDescription = '';
			await loadAll({ silent: true });
			selectedEvaluation = body.evaluation;
			runEvaluationId = selectedEvaluation?.id ?? runEvaluationId;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function createSwebenchTemplate() {
		saving = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/evaluations/templates/swebench', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					suiteSlug: swebenchSuiteSlug,
					name: swebenchName || swebenchSuiteSlug,
					format: swebenchFormat,
					content: swebenchContent,
					instanceIds: swebenchInstanceIds,
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message ?? body.error ?? `Template failed (${res.status})`);
			swebenchContent = '';
			swebenchInstanceIds = '';
			await loadAll({ silent: true });
			selectedDataset = body.dataset ?? selectedDataset;
			selectedEvaluation = body.evaluation ?? selectedEvaluation;
			runEvaluationId = selectedEvaluation?.id ?? runEvaluationId;
			activeTab = 'evals';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function createRun() {
		const evaluationId = runEvaluationId || selectedEvaluation?.id;
		if (!evaluationId) return;
		if (runSubjectType === 'agent' && !runAgentId) {
			errorMessage = 'Select a registered agent for agent evaluation runs.';
			return;
		}
		if (runSubjectType === 'workflow' && !runWorkflowId) {
			errorMessage = 'Select a workflow for workflow evaluation runs.';
			return;
		}
		saving = true;
		errorMessage = null;
		try {
			const importedOutputs = runSubjectType === 'imported_outputs' && runImportedOutputs.trim()
				? parseJsonValue(runImportedOutputs, 'imported outputs')
				: undefined;
			const res = await fetch('/api/evaluations/runs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					evaluationId,
					subjectType: runSubjectType,
					subjectId:
						runSubjectType === 'agent'
							? runAgentId
							: runSubjectType === 'workflow'
								? runWorkflowId
								: undefined,
					importedOutputs,
					executionConfig: {
						concurrency: runConcurrency,
						timeoutSeconds: runTimeoutSeconds,
					},
				}),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.message ?? body.error ?? `Run failed (${res.status})`);
			selectedRun = body.run;
			selectedRunItemId = selectedRun?.items[0]?.id ?? '';
			activeTab = 'runs';
			runImportedOutputs = '';
			await loadAll({ silent: true });
			if (body.coordinatorStartError) errorMessage = body.coordinatorStartError;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function gradeRun() {
		if (!selectedRun) return;
		const res = await fetch(`/api/evaluations/runs/${selectedRun.id}/grade`, { method: 'POST' });
		if (!res.ok) {
			errorMessage = `Grade failed (${res.status})`;
			return;
		}
		selectedRun = ((await res.json()) as { run: RunDetail }).run;
		await loadAll({ silent: true });
	}

	async function cancelRun() {
		if (!selectedRun) return;
		const res = await fetch(`/api/evaluations/runs/${selectedRun.id}/cancel`, { method: 'POST' });
		if (!res.ok) {
			errorMessage = `Cancel failed (${res.status})`;
			return;
		}
		selectedRun = ((await res.json()) as { run: RunDetail }).run;
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
			case 'passed':
				return 'bg-emerald-500/15 text-emerald-600';
			case 'running':
			case 'grading':
				return 'bg-blue-500/15 text-blue-600';
			case 'queued':
				return 'bg-amber-500/15 text-amber-600';
			case 'failed':
			case 'error':
				return 'bg-red-500/15 text-red-600';
			case 'cancelled':
			case 'skipped':
				return 'bg-gray-400/15 text-gray-600';
			default:
				return 'bg-muted text-muted-foreground';
		}
	}

	function formatRelative(iso: string | null | undefined): string {
		if (!iso) return 'never';
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}

	function percentage(value: unknown): number {
		return typeof value === 'number' ? Math.round(value * 100) : 0;
	}

	function stringify(value: unknown): string {
		return JSON.stringify(value, null, 2);
	}

	function parseJsonValue(value: string, label: string): unknown {
		try {
			return JSON.parse(value);
		} catch (err) {
			throw new Error(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	onMount(async () => {
		await loadAll();
		schedulePoll();
	});

	onDestroy(() => {
		if (pollTimer) clearTimeout(pollTimer);
	});
</script>

<svelte:head><title>Evaluations</title></svelte:head>

<div class="h-full min-h-0 overflow-y-auto">
	<div class="p-6 pb-10 space-y-5 max-w-7xl mx-auto w-full">
		<AppBreadcrumb
			items={[
				{ label: 'Workspace', href: `/workspaces/${slug}` },
				{ label: 'Evaluations' }
			]}
		/>

		<header class="flex items-start justify-between gap-4 flex-wrap">
			<div>
				<h1 class="text-2xl font-semibold flex items-center gap-2">
					<FlaskConical class="size-6" /> Evaluations
				</h1>
				<p class="text-sm text-muted-foreground mt-1">
					Datasets, eval definitions, and async run results.
				</p>
			</div>
			<Button variant="outline" onclick={() => loadAll()}>
				<RefreshCw class="size-4" /> Refresh
			</Button>
		</header>

		{#if errorMessage}
			<Alert variant="destructive">
				<AlertDescription>{errorMessage}</AlertDescription>
			</Alert>
		{/if}

		<Tabs bind:value={activeTab} class="space-y-5">
			<TabsList>
				<TabsTrigger value="datasets">Datasets</TabsTrigger>
				<TabsTrigger value="evals">Evals</TabsTrigger>
				<TabsTrigger value="runs">Runs</TabsTrigger>
			</TabsList>

			<TabsContent value="datasets" class="space-y-5">
				<div class="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
					<section class="border rounded-lg bg-background overflow-hidden">
						<div class="px-4 py-3 border-b flex items-center gap-2">
							<Database class="size-4" />
							<h2 class="text-base font-medium">Datasets</h2>
						</div>
						<div class="p-4 space-y-4">
							<div class="space-y-2">
								<Label for="dataset-name">Name</Label>
								<Input id="dataset-name" bind:value={newDatasetName} placeholder="Support QA regression" />
							</div>
							<div class="space-y-2">
								<Label for="dataset-description">Description</Label>
								<Textarea id="dataset-description" class="min-h-20" bind:value={newDatasetDescription} />
							</div>
							<Button class="w-full" onclick={createDataset} disabled={saving || !newDatasetName.trim()}>
								<Database class="size-4" /> Create Dataset
							</Button>
						</div>
						<div class="border-t p-4 space-y-4">
							<h2 class="text-base font-medium">SWE-bench Patch Smoke</h2>
							<div class="grid grid-cols-2 gap-3">
								<div class="space-y-2">
									<Label for="swebench-suite">Suite</Label>
									<select id="swebench-suite" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={swebenchSuiteSlug}>
										<option value="SWE-bench_Lite">Lite</option>
										<option value="SWE-bench_Verified">Verified</option>
									</select>
								</div>
								<div class="space-y-2">
									<Label for="swebench-name">Name</Label>
									<Input id="swebench-name" bind:value={swebenchName} />
								</div>
							</div>
							<div class="space-y-2">
								<Label for="swebench-ids">Instance IDs</Label>
								<Textarea id="swebench-ids" class="min-h-20 font-mono text-xs" bind:value={swebenchInstanceIds} />
							</div>
							<div class="space-y-2">
								<Label for="swebench-format">Import Format</Label>
								<select id="swebench-format" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={swebenchFormat}>
									<option value="jsonl">JSONL</option>
									<option value="json">JSON</option>
									<option value="csv">CSV</option>
								</select>
							</div>
							<div class="space-y-2">
								<Label for="swebench-content">Rows</Label>
								<Textarea id="swebench-content" class="min-h-28 font-mono text-xs" bind:value={swebenchContent} />
							</div>
							<Button class="w-full" variant="outline" onclick={createSwebenchTemplate} disabled={saving || (!swebenchContent.trim() && !swebenchInstanceIds.trim())}>
								<FlaskConical class="size-4" /> Create Patch Smoke
							</Button>
						</div>
						<div class="border-t divide-y max-h-80 overflow-auto">
							{#if loading}
								<div class="p-4 text-sm text-muted-foreground">Loading datasets...</div>
							{:else if datasets.length === 0}
								<div class="p-4 text-sm text-muted-foreground">No datasets yet.</div>
							{:else}
								{#each datasets as dataset}
									<button
										type="button"
										class="w-full text-left px-4 py-3 hover:bg-muted/50 {selectedDataset?.id === dataset.id ? 'bg-muted/60' : ''}"
										onclick={() => loadDataset(dataset.id)}
									>
										<div class="font-medium truncate">{dataset.name}</div>
										<div class="text-xs text-muted-foreground mt-1">
											{dataset.rowCount} rows - {formatRelative(dataset.createdAt)}
										</div>
									</button>
								{/each}
							{/if}
						</div>
					</section>

					<section class="space-y-5 min-w-0">
						<div class="border rounded-lg bg-background overflow-hidden">
							<div class="px-4 py-3 border-b flex items-center justify-between gap-3">
								<div>
									<h2 class="text-base font-medium">{selectedDataset?.name ?? 'Rows'}</h2>
									<p class="text-xs text-muted-foreground">{selectedDataset?.rows.length ?? 0} loaded rows</p>
								</div>
								<Button variant="outline" size="sm" onclick={addRow} disabled={!selectedDataset}>
									<FileJson class="size-4" /> Add Row
								</Button>
							</div>
							<div class="overflow-auto max-h-80">
								<table class="w-full text-sm">
									<thead class="bg-muted/50 text-xs text-muted-foreground">
										<tr>
											<th class="text-left font-medium px-4 py-2">Row</th>
											<th class="text-left font-medium px-4 py-2">Expected</th>
											<th class="text-left font-medium px-4 py-2">Generated</th>
											<th class="text-right font-medium px-4 py-2">Rating</th>
										</tr>
									</thead>
									<tbody class="divide-y">
										{#each selectedDataset?.rows ?? [] as row}
											<tr
												class="cursor-pointer hover:bg-muted/40 {selectedRowId === row.id ? 'bg-muted/60' : ''}"
												onclick={() => selectRow(row)}
											>
												<td class="px-4 py-2 font-mono text-xs">{row.externalId ?? row.id}</td>
												<td class="px-4 py-2 truncate max-w-56">{stringify(row.expectedOutput)}</td>
												<td class="px-4 py-2 truncate max-w-56">{row.generatedOutput === null || row.generatedOutput === undefined ? 'empty' : stringify(row.generatedOutput)}</td>
												<td class="px-4 py-2 text-right text-xs text-muted-foreground">{row.rating ?? 'none'}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>

						<div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
							<div class="border rounded-lg bg-background p-4 space-y-4 min-w-0">
								<div class="flex items-center justify-between gap-3">
									<h2 class="text-base font-medium">Row Editor</h2>
									<Button size="sm" onclick={saveSelectedRow} disabled={!selectedRow || saving}>
										<Save class="size-4" /> Save
									</Button>
								</div>
								<div class="grid gap-4 md:grid-cols-2">
									<div class="space-y-2">
										<Label for="row-external">External ID</Label>
										<Input id="row-external" bind:value={rowExternalId} />
									</div>
									<div class="space-y-2">
										<Label for="row-rating">Rating</Label>
										<Input id="row-rating" type="number" bind:value={rowRating} />
									</div>
								</div>
								<div class="grid gap-4 xl:grid-cols-3">
									<div class="space-y-2">
										<Label for="row-input">Input</Label>
										<Textarea id="row-input" class="min-h-64 font-mono text-xs" bind:value={rowInputText} />
									</div>
									<div class="space-y-2">
										<Label for="row-expected">Expected Output</Label>
										<Textarea id="row-expected" class="min-h-64 font-mono text-xs" bind:value={rowExpectedText} />
									</div>
									<div class="space-y-2">
										<Label for="row-generated">Generated Output</Label>
										<Textarea id="row-generated" class="min-h-64 font-mono text-xs" bind:value={rowGeneratedText} />
									</div>
								</div>
								<div class="space-y-2">
									<Label for="row-feedback">Feedback</Label>
									<Textarea id="row-feedback" class="min-h-20" bind:value={rowFeedback} />
								</div>
							</div>

							<div class="border rounded-lg bg-background p-4 space-y-4">
								<h2 class="text-base font-medium">Import</h2>
								<div class="space-y-2">
									<Label for="import-format">Format</Label>
									<select id="import-format" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={importFormat}>
										<option value="jsonl">JSONL</option>
										<option value="json">JSON</option>
										<option value="csv">CSV</option>
									</select>
								</div>
								<div class="space-y-2">
									<Label for="import-content">Rows</Label>
									<Textarea id="import-content" class="min-h-64 font-mono text-xs" bind:value={importContent} />
								</div>
								<Button class="w-full" onclick={importRows} disabled={!selectedDataset || saving || !importContent.trim()}>
									<FileJson class="size-4" /> Import Rows
								</Button>
							</div>
						</div>
					</section>
				</div>
			</TabsContent>

			<TabsContent value="evals" class="space-y-5">
				<div class="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
					<section class="border rounded-lg bg-background p-4 space-y-4">
						<h2 class="text-base font-medium">New Eval</h2>
						<div class="space-y-2">
							<Label for="eval-name">Name</Label>
							<Input id="eval-name" bind:value={newEvalName} placeholder="Answer quality" />
						</div>
						<div class="space-y-2">
							<Label for="eval-dataset">Dataset</Label>
							<select id="eval-dataset" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={newEvalDatasetId}>
								<option value="">No dataset</option>
								{#each datasets as dataset}
									<option value={dataset.id}>{dataset.name}</option>
								{/each}
							</select>
						</div>
						<div class="space-y-2">
							<Label for="eval-description">Description</Label>
							<Textarea id="eval-description" class="min-h-20" bind:value={newEvalDescription} />
						</div>
						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-2">
								<Label for="grader-type">Grader</Label>
								<select id="grader-type" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={graderType}>
									{#each graderTypes as type}
										<option value={type}>{type}</option>
									{/each}
								</select>
							</div>
							<div class="space-y-2">
								<Label for="grader-name">Name</Label>
								<Input id="grader-name" bind:value={graderName} />
							</div>
						</div>
						{#if graderType === 'string_check'}
							<div class="space-y-2">
								<Label for="string-operation">Operation</Label>
								<select id="string-operation" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={stringOperation}>
									<option value="equals">equals</option>
									<option value="contains">contains</option>
									<option value="not_contains">not contains</option>
									<option value="starts_with">starts with</option>
									<option value="ends_with">ends with</option>
									<option value="regex">regex</option>
								</select>
							</div>
						{:else if graderType === 'text_similarity'}
							<div class="space-y-2">
								<Label for="similarity-threshold">Threshold</Label>
								<Input id="similarity-threshold" type="number" min="0" max="1" step="0.05" bind:value={similarityThreshold} />
							</div>
						{/if}
						<Button class="w-full" onclick={createEvaluation} disabled={saving || !newEvalName.trim()}>
							<FlaskConical class="size-4" /> Create Eval
						</Button>
					</section>

					<section class="space-y-5 min-w-0">
						<div class="border rounded-lg bg-background overflow-hidden">
							<div class="px-4 py-3 border-b">
								<h2 class="text-base font-medium">Evals</h2>
							</div>
							<div class="divide-y max-h-80 overflow-auto">
								{#if evaluations.length === 0}
									<div class="p-4 text-sm text-muted-foreground">No evals yet.</div>
								{:else}
									{#each evaluations as evaluation}
										<button
											type="button"
											class="w-full text-left px-4 py-3 hover:bg-muted/50 {selectedEvaluation?.id === evaluation.id ? 'bg-muted/60' : ''}"
											onclick={() => loadEvaluation(evaluation.id)}
										>
											<div class="flex items-center justify-between gap-3">
												<div class="min-w-0">
													<div class="font-medium truncate">{evaluation.name}</div>
													<div class="text-xs text-muted-foreground mt-1 truncate">
														{evaluation.datasetName ?? 'no dataset'} - {formatRelative(evaluation.createdAt)}
													</div>
												</div>
												{#if evaluation.latestRun}
													<Badge class={statusColor(evaluation.latestRun.status)}>{evaluation.latestRun.status}</Badge>
												{/if}
											</div>
										</button>
									{/each}
								{/if}
							</div>
						</div>

						{#if selectedEvaluation}
							<div class="border rounded-lg bg-background p-4 space-y-5">
								<div class="flex items-start justify-between gap-3 flex-wrap">
									<div>
										<h2 class="text-base font-medium">{selectedEvaluation.name}</h2>
										<p class="text-xs text-muted-foreground mt-1">{selectedEvaluation.datasetName ?? 'No dataset attached'}</p>
									</div>
									<Button size="sm" onclick={() => { runEvaluationId = selectedEvaluation?.id ?? ''; activeTab = 'runs'; }}>
										<Play class="size-4" /> New Run
									</Button>
								</div>

								<div>
									<div class="text-xs text-muted-foreground mb-2">Graders</div>
									<div class="grid gap-3 md:grid-cols-2">
										{#each selectedEvaluation.graders as grader}
											<div class="border rounded-md p-3">
												<div class="flex items-center justify-between gap-2">
													<div class="font-medium text-sm">{grader.name}</div>
													<Badge>{grader.type}</Badge>
												</div>
												<pre class="mt-3 text-xs bg-muted rounded-md p-3 overflow-auto">{stringify(grader.config)}</pre>
											</div>
										{/each}
									</div>
								</div>

								<div>
									<div class="text-xs text-muted-foreground mb-2">Latest Runs</div>
									<div class="divide-y border rounded-md overflow-hidden">
										{#each selectedEvaluation.runs as run}
											<button
												type="button"
												class="w-full text-left px-3 py-2 hover:bg-muted/50"
												onclick={() => { activeTab = 'runs'; loadRun(run.id); }}
											>
												<div class="flex items-center justify-between gap-3">
													<span class="font-mono text-xs">{run.id}</span>
													<Badge class={statusColor(run.status)}>{run.status}</Badge>
												</div>
											</button>
										{/each}
									</div>
								</div>
							</div>
						{/if}
					</section>
				</div>
			</TabsContent>

			<TabsContent value="runs" class="space-y-5">
				<div class="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
					<section class="border rounded-lg bg-background p-4 space-y-4">
						<h2 class="text-base font-medium">New Run</h2>
						<div class="space-y-2">
							<Label for="run-eval">Eval</Label>
							<select id="run-eval" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={runEvaluationId}>
								{#each evaluations as evaluation}
									<option value={evaluation.id}>{evaluation.name}</option>
								{/each}
							</select>
						</div>
						<div class="space-y-2">
							<Label for="run-subject">Subject</Label>
							<select id="run-subject" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={runSubjectType}>
								<option value="imported_outputs">Imported outputs</option>
								<option value="agent">Published agent</option>
								<option value="workflow">Workflow</option>
							</select>
						</div>
						{#if runSubjectType === 'agent'}
							<div class="space-y-2">
								<Label for="run-agent">Agent</Label>
								<select id="run-agent" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={runAgentId}>
									{#each runnableAgents as agent}
										<option value={agent.id}>{agent.name} v{agent.currentVersion} ({agent.slug})</option>
									{/each}
								</select>
								{#if runnableAgents.length === 0}
									<p class="text-xs text-red-600">No registered agents are available.</p>
								{/if}
							</div>
						{:else if runSubjectType === 'workflow'}
							<div class="space-y-2">
								<Label for="run-workflow">Workflow</Label>
								<select id="run-workflow" class="w-full h-9 rounded-md border bg-background px-3 text-sm" bind:value={runWorkflowId}>
									{#each workflows as workflow}
										<option value={workflow.id}>{workflow.name}</option>
									{/each}
								</select>
								{#if workflows.length === 0}
									<p class="text-xs text-red-600">No workflows are available.</p>
								{/if}
							</div>
						{/if}
						{#if runSubjectType !== 'imported_outputs'}
							<div class="grid grid-cols-2 gap-3">
								<div class="space-y-2">
									<Label for="run-concurrency">Concurrency</Label>
									<Input id="run-concurrency" type="number" min="1" max="32" bind:value={runConcurrency} />
								</div>
								<div class="space-y-2">
									<Label for="run-timeout">Timeout</Label>
									<Input id="run-timeout" type="number" min="60" bind:value={runTimeoutSeconds} />
								</div>
							</div>
						{/if}
						{#if runSubjectType === 'imported_outputs'}
							<div class="space-y-2">
								<Label for="run-imports">Imported Outputs</Label>
								<Textarea id="run-imports" class="min-h-44 font-mono text-xs" bind:value={runImportedOutputs} />
							</div>
						{/if}
						<Button class="w-full" onclick={createRun} disabled={saving || !runEvaluationId || (runSubjectType === 'agent' && !runAgentId) || (runSubjectType === 'workflow' && !runWorkflowId)}>
							<Activity class="size-4" /> Start Run
						</Button>
					</section>

					<section class="space-y-5 min-w-0">
						<div class="border rounded-lg bg-background overflow-hidden">
							<div class="px-4 py-3 border-b">
								<h2 class="text-base font-medium">Runs</h2>
							</div>
							<div class="divide-y max-h-80 overflow-auto">
								{#if runs.length === 0}
									<div class="p-4 text-sm text-muted-foreground">No runs yet.</div>
								{:else}
									{#each runs as run}
										<button
											type="button"
											class="w-full text-left px-4 py-3 hover:bg-muted/50 {selectedRun?.id === run.id ? 'bg-muted/60' : ''}"
											onclick={() => loadRun(run.id)}
										>
											<div class="flex items-center justify-between gap-3">
												<div class="min-w-0">
													<div class="font-medium truncate">{run.evaluationName ?? run.evaluationId}</div>
													<div class="text-xs text-muted-foreground mt-1">
														{run.datasetName ?? 'dataset'} - {formatRelative(run.createdAt)}
													</div>
												</div>
												<Badge class={statusColor(run.status)}>{run.status}</Badge>
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
											<h2 class="text-base font-medium">{selectedRun.evaluationName ?? 'Evaluation Run'}</h2>
											<Badge class={statusColor(selectedRun.status)}>{selectedRun.status}</Badge>
										</div>
										<p class="text-xs text-muted-foreground mt-1">
											{selectedRun.subjectType} - {formatRelative(selectedRun.createdAt)}
										</p>
									</div>
									<div class="flex items-center gap-2">
										<Button variant="outline" size="sm" onclick={gradeRun}>
											<FlaskConical class="size-4" /> Grade
										</Button>
										<Button variant="outline" size="sm" href={`/api/evaluations/runs/${selectedRun.id}/predictions.jsonl`}>
											<Download class="size-4" /> Predictions
										</Button>
										{#if activeRun}
											<Button variant="destructive" size="sm" onclick={cancelRun}>
												<StopCircle class="size-4" /> Cancel
											</Button>
										{/if}
									</div>
								</div>
								<div class="p-4 grid gap-4 md:grid-cols-4">
									<div>
										<div class="text-xs text-muted-foreground">Items</div>
										<div class="text-2xl font-semibold">{selectedRun.summary?.total ?? selectedRun.items.length}</div>
									</div>
									<div>
										<div class="text-xs text-muted-foreground">Passed</div>
										<div class="text-2xl font-semibold">{selectedRun.summary?.passed ?? 0}</div>
									</div>
									<div>
										<div class="text-xs text-muted-foreground">Failed</div>
										<div class="text-2xl font-semibold">{selectedRun.summary?.failed ?? 0}</div>
									</div>
									<div>
										<div class="text-xs text-muted-foreground">Pass Rate</div>
										<div class="text-2xl font-semibold">{percentage(selectedRun.summary?.passRate)}%</div>
									</div>
								</div>
								{#if selectedRun.error}
									<div class="px-4 pb-4">
										<Alert variant="destructive">
											<AlertDescription>{selectedRun.error}</AlertDescription>
										</Alert>
									</div>
								{/if}
							</div>

							<div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
								<div class="border rounded-lg bg-background overflow-hidden min-w-0">
									<div class="px-4 py-3 border-b">
										<h2 class="text-base font-medium">Run Items</h2>
									</div>
									<div class="overflow-auto max-h-[560px]">
										<table class="w-full text-sm">
											<thead class="bg-muted/50 text-xs text-muted-foreground">
												<tr>
													<th class="text-left font-medium px-4 py-2">#</th>
													<th class="text-left font-medium px-4 py-2">Status</th>
													<th class="text-left font-medium px-4 py-2">Score</th>
													<th class="text-left font-medium px-4 py-2">Error</th>
												</tr>
											</thead>
											<tbody class="divide-y">
												{#each selectedRun.items as item}
													<tr
														class="cursor-pointer hover:bg-muted/40 {selectedRunItemId === item.id ? 'bg-muted/60' : ''}"
														onclick={() => (selectedRunItemId = item.id)}
													>
														<td class="px-4 py-2 font-mono text-xs">{item.rowIndex + 1}</td>
														<td class="px-4 py-2"><Badge class={statusColor(item.status)}>{item.status}</Badge></td>
														<td class="px-4 py-2 text-xs">{typeof item.scores?.score === 'number' ? item.scores.score.toFixed(2) : 'none'}</td>
														<td class="px-4 py-2 text-xs text-muted-foreground truncate max-w-72">{item.error ?? ''}</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								</div>

								<aside class="border rounded-lg bg-background overflow-hidden min-w-0">
									<div class="px-4 py-3 border-b">
										<h2 class="text-base font-medium">Item Detail</h2>
									</div>
									{#if selectedRunItem}
										<div class="p-4 space-y-4">
											<div class="flex items-center justify-between gap-2">
												<div class="font-mono text-xs">#{selectedRunItem.rowIndex + 1}</div>
												<Badge class={statusColor(selectedRunItem.status)}>{selectedRunItem.status}</Badge>
											</div>
											<div>
												<div class="text-xs text-muted-foreground mb-1">Input</div>
												<pre class="text-xs rounded-md bg-muted p-3 max-h-40 overflow-auto whitespace-pre-wrap">{stringify(selectedRunItem.input)}</pre>
											</div>
											<div>
												<div class="text-xs text-muted-foreground mb-1">Generated</div>
												<pre class="text-xs rounded-md bg-muted p-3 max-h-40 overflow-auto whitespace-pre-wrap">{stringify(selectedRunItem.generatedOutput)}</pre>
											</div>
											<div>
												<div class="text-xs text-muted-foreground mb-1">Graders</div>
												<pre class="text-xs rounded-md bg-muted p-3 max-h-64 overflow-auto whitespace-pre-wrap">{stringify(selectedRunItem.graderResults)}</pre>
											</div>
										</div>
									{:else}
										<div class="p-4 text-sm text-muted-foreground">Select a run item.</div>
									{/if}
								</aside>
							</div>
						{/if}
					</section>
				</div>
			</TabsContent>
		</Tabs>
	</div>
</div>
