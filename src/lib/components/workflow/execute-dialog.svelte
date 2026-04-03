<script lang="ts">
	/**
	 * ExecuteDialog — collects workflow input with smart dropdowns.
	 *
	 * For the "Resolve GitHub Issue" workflow pattern:
	 * - Provider selector (github / gitea)
	 * - Owner dropdown (pre-filled)
	 * - Repo dropdown (fetched from SCM API)
	 * - Issue dropdown (fetched when repo selected, auto-fills title + body)
	 * - Falls back to schema-driven form for other workflows
	 */
	import { getContext } from 'svelte';
	import { Play, Loader2, CircleAlert } from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Select from '$lib/components/ui/select';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import {
		Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
	} from '$lib/components/ui/dialog';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	interface Props {
		open: boolean;
		onClose: () => void;
		onExecute: (input: Record<string, unknown>) => void;
	}

	let { open = $bindable(), onClose, onExecute }: Props = $props();

	let isSubmitting = $state(false);
	let errorMsg = $state<string | null>(null);

	// Schema detection
	interface SchemaProperty { type: string; description?: string; }
	let inputSchema = $derived.by(() => {
		const startNode = store.nodes.find((n) => n.type === 'start' || n.id === '__start__');
		const taskConfig = (startNode?.data as Record<string, unknown>)?.taskConfig as Record<string, unknown> | undefined;
		const input = taskConfig?.input as Record<string, unknown> | undefined;
		const schema = input?.schema as Record<string, unknown> | undefined;
		const doc = schema?.document as Record<string, unknown> | undefined;
		if (!doc || doc.type !== 'object') return null;
		return {
			properties: (doc.properties || {}) as Record<string, SchemaProperty>,
			required: (doc.required || []) as string[]
		};
	});

	// Detect if this is a "resolve issue" pattern (has owner, repo, issue_number)
	let isIssueWorkflow = $derived(
		inputSchema?.properties?.owner && inputSchema?.properties?.repo && inputSchema?.properties?.issue_number
	);

	// SCM state
	let provider = $state('gitea');
	let owner = $state('giteaadmin');
	let repos = $state<{ name: string; fullName: string; description: string }[]>([]);
	let selectedRepo = $state('');
	let issues = $state<{ number: number; title: string; body: string; state: string }[]>([]);
	let selectedIssue = $state<number | null>(null);
	let title = $state('');
	let body = $state('');
	let sender = $state('');
	let loadingRepos = $state(false);
	let loadingIssues = $state(false);

	// Generic form values (for non-issue workflows)
	let formValues = $state<Record<string, string>>({});
	let rawJson = $state('{}');
	let initialized = false;

	$effect(() => {
		if (open && !initialized) {
			if (inputSchema && !isIssueWorkflow) {
				const vals: Record<string, string> = {};
				for (const key of Object.keys(inputSchema.properties)) {
					if (key === 'provider') vals[key] = 'github';
					else vals[key] = formValues[key] || '';
				}
				formValues = vals;
			}
			if (isIssueWorkflow) {
				loadRepos();
			}
			initialized = true;
		}
		if (!open) initialized = false;
	});

	function switchProvider(newProvider: string) {
		provider = newProvider;
		// Auto-switch owner for common defaults
		if (newProvider === 'gitea' && (owner === 'PittampalliOrg' || !owner)) {
			owner = 'giteaadmin';
		} else if (newProvider === 'github' && (owner === 'giteaadmin' || !owner)) {
			owner = 'PittampalliOrg';
		}
		loadRepos();
	}

	async function loadRepos() {
		loadingRepos = true;
		repos = [];
		selectedRepo = '';
		issues = [];
		selectedIssue = null;
		try {
			const params = new URLSearchParams({ provider });
			if (owner) params.set('owner', owner);
			const res = await fetch(`/api/scm/repos?${params}`);
			if (res.ok) {
				const data = await res.json();
				repos = data.repos || [];
			}
		} catch {
			// ignore
		} finally {
			loadingRepos = false;
		}
	}

	async function loadIssues() {
		if (!selectedRepo) return;
		loadingIssues = true;
		issues = [];
		selectedIssue = null;
		title = '';
		body = '';
		try {
			const res = await fetch(`/api/scm/issues?provider=${provider}&owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(selectedRepo)}`);
			if (res.ok) {
				const data = await res.json();
				issues = data.issues || [];
			}
		} catch {
			// ignore
		} finally {
			loadingIssues = false;
		}
	}

	function selectIssue(issueNum: number) {
		selectedIssue = issueNum;
		const issue = issues.find((i) => i.number === issueNum);
		if (issue) {
			title = issue.title;
			body = issue.body;
		}
	}

	function handleClose() {
		errorMsg = null;
		isSubmitting = false;
		onClose();
	}

	async function handleSubmit() {
		errorMsg = null;
		isSubmitting = true;

		try {
			let input: Record<string, unknown>;

			if (isIssueWorkflow) {
				if (!owner) { errorMsg = '"owner" is required'; isSubmitting = false; return; }
				if (!selectedRepo) { errorMsg = '"repo" is required'; isSubmitting = false; return; }
				if (!selectedIssue) { errorMsg = '"issue_number" is required'; isSubmitting = false; return; }
				if (!title) { errorMsg = '"title" is required'; isSubmitting = false; return; }
				if (!body) { errorMsg = '"body" is required'; isSubmitting = false; return; }

				input = {
					owner,
					repo: selectedRepo,
					issue_number: selectedIssue,
					title,
					body,
					sender: sender || owner,
					provider
				};
			} else if (inputSchema) {
				input = {};
				for (const [key, prop] of Object.entries(inputSchema.properties)) {
					const val = formValues[key] || '';
					input[key] = (prop.type === 'integer' || prop.type === 'number') ? (val ? Number(val) : 0) : val;
				}
				for (const reqKey of inputSchema.required) {
					if (!input[reqKey] && input[reqKey] !== 0) {
						errorMsg = `"${reqKey}" is required`;
						isSubmitting = false;
						return;
					}
				}
			} else {
				try { input = JSON.parse(rawJson); } catch {
					errorMsg = 'Invalid JSON'; isSubmitting = false; return;
				}
			}

			onExecute(input);
			handleClose();
		} catch (err) {
			errorMsg = String(err);
		} finally {
			isSubmitting = false;
		}
	}
</script>

<Dialog {open} onOpenChange={(v) => { if (!v) handleClose(); }}>
	<DialogContent class="sm:max-w-lg">
		<DialogHeader>
			<DialogTitle>Execute Workflow</DialogTitle>
		</DialogHeader>

		{#if errorMsg}
			<Alert variant="destructive">
				<CircleAlert class="size-4" />
				<AlertDescription>{errorMsg}</AlertDescription>
			</Alert>
		{/if}

		<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
			{#if isIssueWorkflow}
					<!-- Smart issue workflow form with cascading dropdowns -->
					<div class="space-y-3 max-h-[450px] overflow-y-auto pr-1">
						<!-- Provider -->
						<div class="space-y-1.5">
							<Label>Provider</Label>
							<Select.Root type="single" value={provider} onValueChange={(v) => switchProvider(v)}>
								<Select.Trigger class="w-full">
									{provider === 'gitea' ? 'Gitea (local)' : 'GitHub'}
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="github">GitHub</Select.Item>
									<Select.Item value="gitea">Gitea (local)</Select.Item>
								</Select.Content>
							</Select.Root>
						</div>

						<!-- Owner -->
						<div class="space-y-1.5">
							<Label>Owner <span class="text-destructive">*</span></Label>
							<Input
								bind:value={owner}
								placeholder={provider === 'gitea' ? 'giteaadmin' : 'PittampalliOrg'}
							/>
						</div>

						<!-- Repo dropdown -->
						<div class="space-y-1.5">
							<Label>
								Repository <span class="text-destructive">*</span>
								{#if loadingRepos}<Loader2 size={12} class="inline animate-spin ml-1" />{/if}
							</Label>
							<Select.Root
								type="single"
								value={selectedRepo}
								onValueChange={(v) => { selectedRepo = v; loadIssues(); }}
								disabled={loadingRepos || repos.length === 0}
							>
								<Select.Trigger class="w-full">
									<span class={!selectedRepo ? 'text-muted-foreground' : ''}>
										{#if selectedRepo}
											{selectedRepo}
										{:else if loadingRepos}
											Loading...
										{:else if repos.length === 0}
											No repos found
										{:else}
											Select repository...
										{/if}
									</span>
								</Select.Trigger>
								<Select.Content>
									{#each repos as repo}
										<Select.Item value={repo.name}>{repo.name}{repo.description ? ` — ${repo.description}` : ''}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>

						<!-- Issue dropdown -->
						<div class="space-y-1.5">
							<Label>
								Issue <span class="text-destructive">*</span>
								{#if loadingIssues}<Loader2 size={12} class="inline animate-spin ml-1" />{/if}
							</Label>
							<Select.Root
								type="single"
								value={selectedIssue?.toString() || ''}
								onValueChange={(v) => selectIssue(Number(v))}
								disabled={loadingIssues || issues.length === 0 || !selectedRepo}
							>
								<Select.Trigger class="w-full">
									<span class={!selectedIssue ? 'text-muted-foreground' : ''}>
										{#if selectedIssue}
											#{selectedIssue} — {issues.find(i => i.number === selectedIssue)?.title || ''}
										{:else if !selectedRepo}
											Select repo first
										{:else if loadingIssues}
											Loading...
										{:else if issues.length === 0}
											No open issues
										{:else}
											Select issue...
										{/if}
									</span>
								</Select.Trigger>
								<Select.Content>
									{#each issues as issue}
										<Select.Item value={issue.number.toString()}>#{issue.number} — {issue.title}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>

						<!-- Title (auto-filled from issue) -->
						<div class="space-y-1.5">
							<Label>Title <span class="text-destructive">*</span></Label>
							<Input
								bind:value={title}
								placeholder="Issue title"
							/>
						</div>

						<!-- Body (auto-filled from issue) -->
						<div class="space-y-1.5">
							<Label>Body <span class="text-destructive">*</span></Label>
							<Textarea
								bind:value={body}
								rows={4}
								placeholder="Issue body / description"
							/>
						</div>
					</div>

				{:else if inputSchema}
					<!-- Generic schema form -->
					<div class="space-y-3 max-h-[400px] overflow-y-auto pr-1">
						{#each Object.entries(inputSchema.properties) as [key, prop]}
							<div class="space-y-1.5">
								<Label for="input-{key}">
									{key}
									{#if inputSchema.required.includes(key)}<span class="text-destructive">*</span>{/if}
								</Label>
								<Input
									id="input-{key}"
									type={prop.type === 'integer' || prop.type === 'number' ? 'number' : 'text'}
									bind:value={formValues[key]}
									placeholder={prop.description || key}
								/>
							</div>
						{/each}
					</div>

				{:else}
					<!-- Raw JSON -->
					<div class="space-y-1.5">
						<Label for="raw-input">Input (JSON)</Label>
						<Textarea
							id="raw-input"
							bind:value={rawJson}
							rows={6}
							class="font-mono"
							placeholder={'{"key": "value"}'}
						/>
					</div>
				{/if}

				<DialogFooter class="mt-4">
					<Button variant="outline" type="button" onclick={handleClose}>
						Cancel
					</Button>
					<Button type="submit" disabled={isSubmitting}>
						{#if isSubmitting}
							<Loader2 size={14} class="animate-spin" /> Starting...
						{:else}
							<Play size={14} /> Execute
						{/if}
					</Button>
				</DialogFooter>
			</form>
	</DialogContent>
</Dialog>
