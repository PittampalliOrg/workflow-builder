<script lang="ts">
	import { Tabs, TabsContent, TabsList, TabsTrigger } from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Label } from '$lib/components/ui/label';
	import {
		getWizardState,
		type SubjectKind,
		type WizardSubject
	} from './wizard-store.svelte';

	type AgentOption = {
		id: string;
		name: string;
		slug: string;
		runtime: string;
		registryStatus: string;
		currentVersion: number | null;
	};

	type WorkflowOption = {
		id: string;
		name: string;
	};

	const wiz = getWizardState();

	let agents = $state<AgentOption[]>([]);
	let workflows = $state<WorkflowOption[]>([]);
	let loading = $state(true);

	async function load() {
		loading = true;
		try {
			const [aRes, wRes] = await Promise.all([
				fetch('/api/agents'),
				fetch('/api/workflows?projectOnly=1')
			]);
			if (aRes.ok) {
				const data = (await aRes.json()) as { agents: AgentOption[] };
				agents = (data.agents ?? []).filter(
					(a) => a.registryStatus === 'registered' && a.currentVersion
				);
			}
			if (wRes.ok) {
				const data = (await wRes.json()) as { workflows: WorkflowOption[] };
				workflows = data.workflows ?? [];
			}
		} finally {
			loading = false;
		}
	}

	function setSubject(patch: Partial<WizardSubject>) {
		wiz.subject = { ...wiz.subject, ...patch };
	}

	function setKind(kind: SubjectKind) {
		wiz.subject = { type: kind };
	}

	$effect(() => {
		load();
	});
</script>

<Tabs value={wiz.subject.type} onValueChange={(v) => setKind(v as SubjectKind)}>
	<TabsList class="h-9">
		<TabsTrigger value="agent" class="text-xs">Agent</TabsTrigger>
		<TabsTrigger value="workflow" class="text-xs">Workflow</TabsTrigger>
		<TabsTrigger value="imported_outputs" class="text-xs">Imported outputs</TabsTrigger>
	</TabsList>

	<TabsContent value="agent" class="mt-4">
		<div class="flex flex-col gap-1.5">
			<Label class="text-xs">Agent</Label>
			{#if loading}
				<div class="text-xs text-muted-foreground">Loading agents…</div>
			{:else if agents.length === 0}
				<div class="text-xs text-muted-foreground">
					No published agents. Publish one in <strong>Agents</strong> first.
				</div>
			{:else}
				<select
					value={wiz.subject.id ?? ''}
					onchange={(e) => setSubject({ id: (e.target as HTMLSelectElement).value })}
					class="text-sm border rounded px-2 py-2 bg-background h-9"
				>
					<option value="" disabled>Select an agent…</option>
					{#each agents as a (a.id)}
						<option value={a.id}>{a.name} (v{a.currentVersion})</option>
					{/each}
				</select>
			{/if}
		</div>
	</TabsContent>

	<TabsContent value="workflow" class="mt-4">
		<div class="flex flex-col gap-1.5">
			<Label class="text-xs">Workflow</Label>
			{#if loading}
				<div class="text-xs text-muted-foreground">Loading workflows…</div>
			{:else if workflows.length === 0}
				<div class="text-xs text-muted-foreground">No workflows in this project.</div>
			{:else}
				<select
					value={wiz.subject.id ?? ''}
					onchange={(e) => setSubject({ id: (e.target as HTMLSelectElement).value })}
					class="text-sm border rounded px-2 py-2 bg-background h-9"
				>
					<option value="" disabled>Select a workflow…</option>
					{#each workflows as w (w.id)}
						<option value={w.id}>{w.name}</option>
					{/each}
				</select>
			{/if}
		</div>
	</TabsContent>

	<TabsContent value="imported_outputs" class="mt-4">
		<div class="flex flex-col gap-1.5">
			<Label class="text-xs">Predictions JSONL</Label>
			<Textarea
				value={wiz.subject.importedOutputs ?? ''}
				oninput={(e) => setSubject({ importedOutputs: (e.target as HTMLTextAreaElement).value })}
				rows={8}
				class="font-mono text-xs"
				placeholder={'{"id":"row_1","output":"Hardware"}\n{"id":"row_2","output":"Software"}'}
			/>
			<p class="text-xs text-muted-foreground">
				One JSON object per line. Each row's <code>output</code> is graded against the dataset row's
				<code>expectedOutput</code>.
			</p>
		</div>
	</TabsContent>
</Tabs>
