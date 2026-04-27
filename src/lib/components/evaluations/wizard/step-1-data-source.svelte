<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		getWizardState,
		addRow,
		updateRow,
		removeRow,
		type DataSourceKind
	} from './wizard-store.svelte';
	import { Beaker, FileJson, FileText, History, Plus, Trash2, Upload } from 'lucide-svelte';

	const wiz = getWizardState();

	type Tile = {
		kind: DataSourceKind | 'api';
		title: string;
		desc: string;
		icon: typeof FileJson;
		disabled?: boolean;
	};

	const tiles: Tile[] = [
		{
			kind: 'logs',
			title: 'Import Logs',
			desc: 'Evaluate stored chat completions and responses.',
			icon: History,
			disabled: true
		},
		{
			kind: 'manual',
			title: 'Create new data',
			desc: 'Craft input data and prompts manually.',
			icon: FileText
		},
		{
			kind: 'upload',
			title: 'Upload a file',
			desc: 'Upload responses or input data from JSONL or CSV.',
			icon: Upload
		},
		{
			kind: 'swebench',
			title: 'SWE-bench template',
			desc: 'Princeton/Berkeley coding benchmark. Auto-provisions dataset + harness graders.',
			icon: Beaker
		},
		{
			kind: 'api',
			title: 'Use the API',
			desc: 'Use POST /api/evaluations for full programmatic control.',
			icon: FileJson,
			disabled: true
		}
	];

	function selectTile(kind: DataSourceKind | 'api') {
		if (kind === 'api') return;
		wiz.dataSource = kind;
	}
</script>

<div class="flex flex-col gap-6">
	<div>
		<h2 class="text-base font-semibold">Select your data source</h2>
		<p class="text-sm text-muted-foreground mt-0.5">
			Choose how you'd like to provide test data for evaluation.
		</p>
	</div>

	<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
		{#each tiles as tile (tile.kind)}
			{@const isActive = wiz.dataSource === tile.kind}
			<button
				type="button"
				disabled={tile.disabled}
				onclick={() => selectTile(tile.kind)}
				class="border rounded-md p-4 text-left transition-colors hover:bg-muted/40
				disabled:opacity-50 disabled:cursor-not-allowed
				{isActive ? 'ring-2 ring-primary border-primary' : ''}"
			>
				<div class="flex items-start gap-3">
					<div class="size-8 rounded-md bg-muted flex items-center justify-center shrink-0">
						<tile.icon class="size-4 text-muted-foreground" />
					</div>
					<div class="min-w-0">
						<div class="font-medium text-sm">
							{tile.title}
							{#if tile.disabled}<span class="ml-1 text-[10px] text-muted-foreground">Coming soon</span>{/if}
						</div>
						<div class="text-xs text-muted-foreground mt-0.5">{tile.desc}</div>
					</div>
				</div>
			</button>
		{/each}
	</div>

	{#if wiz.dataSource === 'manual'}
		<section class="flex flex-col gap-3">
			<div class="flex items-baseline justify-between">
				<h3 class="text-sm font-semibold">Test data</h3>
				<Button variant="outline" size="sm" onclick={() => addRow()}>
					<Plus class="size-3.5 mr-1" /> Add row
				</Button>
			</div>
			{#if wiz.rows.length === 0}
				<div class="border rounded-md p-6 text-center text-sm text-muted-foreground">
					No rows yet. Click <strong>Add row</strong> to start, or paste a few rows below.
				</div>
			{:else}
				<div class="border rounded-md overflow-hidden">
					<table class="w-full text-sm">
						<thead class="bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
							<tr class="border-b">
								<th class="px-3 py-2 text-left font-medium w-8">#</th>
								<th class="px-3 py-2 text-left font-medium">{`{{item.input}}`}</th>
								<th class="px-3 py-2 text-left font-medium">{`{{item.ground_truth}}`}</th>
								<th class="px-3 py-2 w-8"></th>
							</tr>
						</thead>
						<tbody class="divide-y">
							{#each wiz.rows as row, i (i)}
								<tr>
									<td class="px-3 py-2 text-xs text-muted-foreground tabular-nums align-top pt-3">{i + 1}</td>
									<td class="px-3 py-2 align-top">
										<Textarea
											value={row.input}
											oninput={(e) =>
												updateRow(i, { input: (e.target as HTMLTextAreaElement).value })}
											rows={2}
											class="text-xs font-mono min-h-[40px]"
											placeholder="The input"
										/>
									</td>
									<td class="px-3 py-2 align-top">
										<Input
											value={row.ground_truth}
											oninput={(e) =>
												updateRow(i, { ground_truth: (e.target as HTMLInputElement).value })}
											class="text-xs font-mono"
											placeholder="Expected"
										/>
									</td>
									<td class="px-3 py-2 align-top pt-3">
										<button
											type="button"
											aria-label="Remove row"
											onclick={() => removeRow(i)}
											class="text-muted-foreground hover:text-destructive"
										>
											<Trash2 class="size-3.5" />
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}

	{#if wiz.dataSource === 'swebench'}
		<section class="flex flex-col gap-3">
			<h3 class="text-sm font-semibold">SWE-bench template</h3>
			<label class="flex flex-col gap-1.5 text-xs">
				Suite slug
				<select
					bind:value={wiz.swebenchSuiteSlug}
					class="text-sm border rounded px-2 py-2 bg-background h-9"
				>
					<option value="SWE-bench_Lite">SWE-bench_Lite</option>
					<option value="SWE-bench">SWE-bench</option>
					<option value="SWE-bench_Verified">SWE-bench_Verified</option>
					<option value="SWE-bench_Multimodal">SWE-bench_Multimodal</option>
				</select>
			</label>
			<label class="flex flex-col gap-1.5 text-xs">
				Instance IDs (optional, space-separated)
				<Textarea
					bind:value={wiz.swebenchInstanceIds}
					rows={4}
					class="font-mono text-xs"
					placeholder="astropy__astropy-12907 django__django-13551"
				/>
			</label>
			<p class="text-[11px] text-muted-foreground">
				Leave empty to load every instance. The wizard will provision the dataset
				(<code>workspace_ref</code> rows + harness wiring) and create the eval with the
				built-in patch-present + SWE-bench harness graders. You'll pick a coding agent on
				Step 3.
			</p>
		</section>
	{/if}

	{#if wiz.dataSource === 'upload'}
		<section class="flex flex-col gap-3">
			<div class="flex items-baseline justify-between">
				<h3 class="text-sm font-semibold">Upload test data</h3>
				<select bind:value={wiz.uploadFormat} class="text-xs border rounded px-2 py-1 bg-background">
					<option value="jsonl">JSONL</option>
					<option value="json">JSON</option>
					<option value="csv">CSV</option>
				</select>
			</div>
			<Textarea
				bind:value={wiz.uploadContent}
				rows={12}
				class="font-mono text-xs"
				placeholder={'{"input":"My monitor won\'t turn on","ground_truth":"Hardware"}\n{"input":"I\'m in vim","ground_truth":"Software"}'}
			/>
			<p class="text-xs text-muted-foreground">
				Each row should include at least an <code>input</code> field. Add an
				<code>expected</code> or <code>ground_truth</code> for graders that compare against a reference.
			</p>
		</section>
	{/if}
</div>
