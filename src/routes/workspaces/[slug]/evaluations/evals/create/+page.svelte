<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import AppBreadcrumb from '$lib/components/console/app-breadcrumb.svelte';
	import Step1DataSource from '$lib/components/evaluations/wizard/step-1-data-source.svelte';
	import Step2Criteria from '$lib/components/evaluations/wizard/step-2-criteria.svelte';
	import Step3Review from '$lib/components/evaluations/wizard/step-3-review.svelte';
	import {
		getWizardState,
		resetWizard,
		setStep,
		step1Valid,
		step3Valid,
		type WizardPreset
	} from '$lib/components/evaluations/wizard/wizard-store.svelte';
	import { ArrowLeft } from 'lucide-svelte';

	const slug = $derived((page.params.slug as string) ?? 'default');
	const presetParam = $derived(page.url.searchParams.get('preset') as WizardPreset);

	const wiz = getWizardState();
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);

	onMount(() => {
		resetWizard(presetParam);
	});

	const stepValid = $derived(
		wiz.step === 1 ? step1Valid() : wiz.step === 3 ? step3Valid() : true
	);

	function back() {
		if (wiz.step === 1) {
			goto(`/workspaces/${slug}/evaluations?tab=evals`);
			return;
		}
		setStep((wiz.step - 1) as 1 | 2 | 3);
	}

	function next() {
		if (wiz.step < 3) {
			setStep((wiz.step + 1) as 1 | 2 | 3);
		}
	}

	async function createDatasetFromRows(): Promise<string> {
		// Create a hidden dataset for the manual rows
		const rows = wiz.rows.map((r, i) => ({
			externalId: `row_${i + 1}`,
			input: { input: r.input },
			expectedOutput: r.ground_truth || null
		}));
		const res = await fetch('/api/evaluations/datasets', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: `${wiz.name || 'wizard'} dataset`,
				description: 'Created from eval wizard',
				sourceType: 'manual',
				rows
			})
		});
		if (!res.ok) throw new Error(`Failed to create dataset (${res.status})`);
		const data = (await res.json()) as { dataset: { id: string } };
		return data.dataset.id;
	}

	async function createDatasetFromUpload(): Promise<string> {
		// Step 1 — create the dataset, Step 2 — import rows.
		const createRes = await fetch('/api/evaluations/datasets', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: `${wiz.name || 'wizard'} dataset`,
				description: 'Created from eval wizard upload',
				sourceType: 'upload'
			})
		});
		if (!createRes.ok) throw new Error(`Failed to create dataset (${createRes.status})`);
		const createData = (await createRes.json()) as { dataset: { id: string } };
		const datasetId = createData.dataset.id;
		// Inject row_N ids so predictions JSONL can match without forcing the user
		// to also include id fields up-front.
		const ensuredContent =
			wiz.uploadFormat === 'jsonl'
				? wiz.uploadContent
						.split(/\r?\n/)
						.map((line) => line.trim())
						.filter(Boolean)
						.map((line, idx) => {
							try {
								const parsed = JSON.parse(line) as Record<string, unknown>;
								if (!parsed.id && !parsed.externalId && !parsed.external_id) {
									parsed.externalId = `row_${idx + 1}`;
								}
								return JSON.stringify(parsed);
							} catch {
								return line;
							}
						})
						.join('\n')
				: wiz.uploadContent;
		const importRes = await fetch(`/api/evaluations/datasets/${datasetId}/import`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ format: wiz.uploadFormat, content: ensuredContent })
		});
		if (!importRes.ok) throw new Error(`Failed to import rows (${importRes.status})`);
		return datasetId;
	}

	async function createSwebenchTemplate(): Promise<{ evaluationId: string; datasetId: string }> {
		const instanceIds = wiz.swebenchInstanceIds
			.split(/\s+/)
			.map((v) => v.trim())
			.filter(Boolean);
		const res = await fetch('/api/evaluations/templates/swebench', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				suiteSlug: wiz.swebenchSuiteSlug,
				name: wiz.name || `${wiz.swebenchSuiteSlug} eval`,
				description: wiz.description || null,
				instanceIds: instanceIds.length > 0 ? instanceIds : undefined
			})
		});
		if (!res.ok) throw new Error(`Failed to create SWE-bench patch smoke (${res.status})`);
		const data = (await res.json()) as {
			evaluation: { id: string };
			dataset: { id: string };
		};
		return { evaluationId: data.evaluation.id, datasetId: data.dataset.id };
	}

	async function createAndRun() {
		if (!step3Valid() || busy) return;
		busy = true;
		errorMessage = null;
		try {
			// SWE-bench preset short-circuits the regular flow: the template endpoint
			// creates dataset + evaluation in one call with built-in graders.
			if (wiz.dataSource === 'swebench') {
				const { evaluationId, datasetId } = await createSwebenchTemplate();
				const runRes = await fetch('/api/evaluations/runs', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						evaluationId,
						datasetId,
						subjectType: wiz.subject.type,
						subjectId: wiz.subject.id,
						subjectVersion: wiz.subject.version,
						executionConfig: {
							concurrency: wiz.concurrency,
							timeoutSeconds: wiz.timeoutSeconds
						}
					})
				});
				if (!runRes.ok) {
					errorMessage = `SWE-bench patch smoke created, but run failed (${runRes.status}). Open the eval to retry.`;
					goto(`/workspaces/${slug}/evaluations/evals/${evaluationId}`);
					return;
				}
				const runData = (await runRes.json()) as { run: { id: string } };
				goto(
					`/workspaces/${slug}/evaluations/evals/${evaluationId}/runs/${runData.run.id}`
				);
				return;
			}

			// 1. Provision dataset based on data source
			const datasetId =
				wiz.dataSource === 'upload'
					? await createDatasetFromUpload()
					: await createDatasetFromRows();

			// 2. Create evaluation with criteria
			const evalRes = await fetch('/api/evaluations/evals', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: wiz.name,
					description: wiz.description || null,
					datasetId,
					graders: wiz.criteria.map((c) => ({
						name: c.name,
						type: c.type === 'endpoint' ? 'external_harness' : c.type,
						config: c.config,
						weight: c.weight,
						passThreshold: c.passThreshold,
						enabled: c.enabled
					}))
				})
			});
			if (!evalRes.ok) {
				errorMessage = `Failed to create evaluation (${evalRes.status})`;
				return;
			}
			const evalData = (await evalRes.json()) as { evaluation: { id: string } };
			const evaluationId = evalData.evaluation.id;

			// 3. Create run. Parse JSONL predictions client-side so the server
			// receives an array shape (server's normalizeImportedOutputs only
			// accepts Array<object> or Record<string, output>; raw strings are
			// silently discarded).
			const importedOutputs =
				wiz.subject.type === 'imported_outputs' && wiz.subject.importedOutputs
					? wiz.subject.importedOutputs
							.split(/\r?\n/)
							.map((line) => line.trim())
							.filter(Boolean)
							.map((line) => {
								try {
									return JSON.parse(line) as Record<string, unknown>;
								} catch {
									return null;
								}
							})
							.filter((v): v is Record<string, unknown> => v !== null)
					: undefined;
			const runRes = await fetch('/api/evaluations/runs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					evaluationId,
					datasetId,
					subjectType: wiz.subject.type,
					subjectId: wiz.subject.id,
					subjectVersion: wiz.subject.version,
					importedOutputs,
					executionConfig: {
						concurrency: wiz.concurrency,
						timeoutSeconds: wiz.timeoutSeconds
					},
					autoGrade: wiz.subject.type === 'imported_outputs'
				})
			});
			if (!runRes.ok) {
				errorMessage = `Created eval, but run failed (${runRes.status}). View it on the eval page.`;
				goto(`/workspaces/${slug}/evaluations/evals/${evaluationId}`);
				return;
			}
			const runData = (await runRes.json()) as { run: { id: string } };
			goto(
				`/workspaces/${slug}/evaluations/evals/${evaluationId}/runs/${runData.run.id}`
			);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to create eval';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>New evaluation</title>
</svelte:head>

<div class="flex flex-col h-full">
	<header class="border-b px-6 py-4">
		<AppBreadcrumb
			items={[
				{ label: 'Evaluations', href: `/workspaces/${slug}/evaluations` },
				{ label: 'Evals', href: `/workspaces/${slug}/evaluations?tab=evals` },
				{ label: 'New evaluation' }
			]}
		/>
		<div class="mt-3 flex items-center justify-between gap-4 flex-wrap">
			<div>
				<h1 class="text-xl font-semibold tracking-tight">New evaluation</h1>
				<p class="text-xs text-muted-foreground mt-1">Step {wiz.step} / 3</p>
			</div>
			<div class="flex items-center gap-1">
				<button
					type="button"
					onclick={() => setStep(1)}
					class="text-xs px-2 py-1 rounded {wiz.step === 1 ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
				>
					1. Data
				</button>
				<button
					type="button"
					onclick={() => wiz.step >= 2 && setStep(2)}
					class="text-xs px-2 py-1 rounded {wiz.step === 2 ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
					disabled={wiz.step < 2}
				>
					2. Criteria
				</button>
				<button
					type="button"
					onclick={() => wiz.step >= 3 && setStep(3)}
					class="text-xs px-2 py-1 rounded {wiz.step === 3 ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
					disabled={wiz.step < 3}
				>
					3. Review
				</button>
			</div>
		</div>
	</header>

	<div class="flex-1 min-h-0 overflow-y-auto">
		<div class="max-w-4xl mx-auto w-full p-6 flex flex-col gap-6">
			{#if errorMessage}
				<Alert variant="destructive">
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			{/if}

			{#if wiz.step === 1}
				<Step1DataSource />
			{:else if wiz.step === 2}
				<Step2Criteria />
			{:else}
				<Step3Review />
			{/if}
		</div>
	</div>

	<footer class="border-t px-6 py-3 flex items-center justify-between gap-2">
		<Button variant="outline" size="sm" onclick={back} disabled={busy}>
			<ArrowLeft class="size-3.5 mr-1" /> Back
		</Button>
		<div class="flex items-center gap-2">
			{#if wiz.step < 3}
				<Button size="sm" onclick={next} disabled={!stepValid || busy}>Next</Button>
			{:else}
				<Button size="sm" onclick={createAndRun} disabled={!stepValid || busy}>
					{busy ? 'Creating…' : 'Create and run'}
				</Button>
			{/if}
		</div>
	</footer>
</div>
