<script lang="ts">
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
	import { collectRequiredTriggerFields } from '$lib/utils/trigger-fields';
	import ScmTriggerFields, { type ScmTriggerValues } from '$lib/components/workflow/scm-trigger-fields.svelte';
	import {
		getPromptExpansionConfig,
		getWorkflowInputFieldConfigs
	} from '$lib/utils/workflow-input-config';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	const TRIGGER_FIELD_DESCRIPTIONS: Record<string, string> = {
		owner: 'Repository owner or organization',
		repo: 'Repository name',
		model: 'Claude model to use for claude/run steps',
		app_name: 'Display name for the generated application',
		headline: 'Primary headline shown in the UI',
		description: 'Repository or project description',
		ui_brief: 'Detailed UI/design brief for the generated app'
	};

	const SCM_TRIGGER_FIELDS = new Set([
		'provider',
		'owner',
		'repo',
		'issue_number',
		'title',
		'body',
		'sender'
	]);
	function toFieldLabel(field: string): string {
		return field
			.split('_')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function isLongTextField(field: string): boolean {
		return field === 'description' || field === 'ui_brief' || field === 'body';
	}

	function shouldRenderGenericField(key: string, showScmFields: boolean): boolean {
		return !showScmFields || !SCM_TRIGGER_FIELDS.has(key);
	}

	function shouldRenderWorkflowField(
		key: string,
		showScmFields: boolean,
		hideDerivedField: boolean
	): boolean {
		if (!shouldRenderGenericField(key, showScmFields)) return false;
		if (hideDerivedField) return false;
		return true;
	}

	interface Props {
		open: boolean;
		onClose: () => void;
		onExecute: (input: Record<string, unknown>) => void;
	}

	interface SchemaProperty {
		type: string;
		description?: string;
	}

	let { open = $bindable(), onClose, onExecute }: Props = $props();

	let isSubmitting = $state(false);
	let errorMsg = $state<string | null>(null);
	let rawJson = $state('{}');
	let formValues = $state<Record<string, string>>({});
	let initialized = false;
	let scmValues = $state<ScmTriggerValues>({
		connectionExternalId: '',
		provider: '',
		owner: '',
		repo: '',
		issue_number: null,
		title: '',
		body: '',
		sender: ''
	});

	let inputSchema = $derived.by(() => {
		const startNode = store.nodes.find((node) => node.type === 'start' || node.id === '__start__');
		const taskConfig = (startNode?.data as Record<string, unknown>)?.taskConfig as
			| Record<string, unknown>
			| undefined;
		const input = taskConfig?.input as Record<string, unknown> | undefined;
		const schema = input?.schema as Record<string, unknown> | undefined;
		const doc = schema?.document as Record<string, unknown> | undefined;
		if (!doc || doc.type !== 'object') return null;
		return {
			properties: (doc.properties || {}) as Record<string, SchemaProperty>,
			required: (doc.required || []) as string[]
		};
	});

	let requiredTriggerFields = $derived(collectRequiredTriggerFields(store.spec ?? null));
	let effectiveInputSchema = $derived.by(() => {
		const baseProperties = { ...(inputSchema?.properties || {}) };
		const baseRequired = new Set(inputSchema?.required || []);

		for (const field of requiredTriggerFields) {
			baseRequired.add(field);
			if (!baseProperties[field]) {
				baseProperties[field] = {
					type: 'string',
					description: TRIGGER_FIELD_DESCRIPTIONS[field] || toFieldLabel(field)
				};
			}
		}

		if (Object.keys(baseProperties).length === 0) return null;

		return {
			properties: baseProperties,
			required: [...baseRequired]
		};
	});

	let hasScmFields = $derived(
		Boolean(
			effectiveInputSchema?.properties?.owner ||
				effectiveInputSchema?.properties?.repo ||
				effectiveInputSchema?.properties?.provider ||
				effectiveInputSchema?.properties?.issue_number
		)
	);

	let isIssueWorkflow = $derived(
		Boolean(
			effectiveInputSchema?.properties?.owner &&
				effectiveInputSchema?.properties?.repo &&
				effectiveInputSchema?.properties?.issue_number
		)
	);

	let promptExpansionConfig = $derived(getPromptExpansionConfig(store.spec ?? null));
	let workflowInputFieldConfigs = $derived(getWorkflowInputFieldConfigs(store.spec ?? null));
	let hiddenDerivedFields = $derived(new Set(promptExpansionConfig?.derivedFields || []));

	let visibleSchemaEntries = $derived.by(() =>
		Object.entries(effectiveInputSchema?.properties || {}).filter(([key]) =>
			shouldRenderWorkflowField(key, hasScmFields, hiddenDerivedFields.has(key))
		)
	);

	$effect(() => {
		if (open && !initialized) {
			if (effectiveInputSchema) {
				const nextValues: Record<string, string> = {};
				if (promptExpansionConfig) {
					nextValues[promptExpansionConfig.promptField] =
						formValues[promptExpansionConfig.promptField] || '';
				}
				for (const key of Object.keys(effectiveInputSchema.properties)) {
					if (!shouldRenderWorkflowField(key, hasScmFields, hiddenDerivedFields.has(key))) continue;
					const existingValue = formValues[key] || '';
					const defaultValue = workflowInputFieldConfigs[key]?.defaultValue || '';
					nextValues[key] = existingValue || defaultValue;
				}
				formValues = nextValues;
			}
			initialized = true;
		}

		if (!open) {
			initialized = false;
		}
	});

	function handleClose() {
		errorMsg = null;
		isSubmitting = false;
		onClose();
	}

	function buildInputFromSchema(): Record<string, unknown> {
		const input: Record<string, unknown> = {};

		for (const [key, prop] of Object.entries(effectiveInputSchema?.properties || {})) {
			if (hasScmFields && SCM_TRIGGER_FIELDS.has(key)) {
				if (key === 'issue_number') {
					input[key] = scmValues.issue_number;
				} else {
					input[key] = scmValues[key as keyof ScmTriggerValues] || '';
				}
				continue;
			}

			if (hiddenDerivedFields.has(key)) {
				continue;
			}

			const value = formValues[key] || '';
			input[key] =
				prop.type === 'integer' || prop.type === 'number'
					? value
						? Number(value)
						: 0
					: value;
		}

		if (promptExpansionConfig) {
			input[promptExpansionConfig.promptField] = formValues[promptExpansionConfig.promptField] || '';
		}

		return input;
	}

	async function handleSubmit() {
		errorMsg = null;
		isSubmitting = true;

		try {
			let input: Record<string, unknown>;

			if (effectiveInputSchema) {
				input = buildInputFromSchema();
				for (const reqKey of effectiveInputSchema.required) {
					if (
						promptExpansionConfig &&
						hiddenDerivedFields.has(reqKey) &&
						formValues[promptExpansionConfig.promptField]?.trim()
					) {
						continue;
					}
					if (!input[reqKey] && input[reqKey] !== 0) {
						errorMsg = `"${reqKey}" is required`;
						isSubmitting = false;
						return;
					}
				}
			} else {
				try {
					input = JSON.parse(rawJson);
				} catch {
					errorMsg = 'Invalid JSON';
					isSubmitting = false;
					return;
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

<Dialog {open} onOpenChange={(value) => { if (!value) handleClose(); }}>
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

		<form onsubmit={(event) => { event.preventDefault(); handleSubmit(); }}>
			{#if effectiveInputSchema}
				<div class="space-y-3 max-h-[450px] overflow-y-auto pr-1">
					{#if hasScmFields}
						<ScmTriggerFields
							enabled={open}
							mode={isIssueWorkflow ? 'issue' : 'create'}
							fieldKeys={Object.keys(effectiveInputSchema.properties)}
							bind:values={scmValues}
						/>
					{/if}

					{#if promptExpansionConfig}
						<div class="space-y-1.5">
							<Label for="input-{promptExpansionConfig.promptField}">
								{promptExpansionConfig.promptLabel || 'Prompt'} <span class="text-destructive">*</span>
							</Label>
							<Textarea
								id="input-{promptExpansionConfig.promptField}"
								bind:value={formValues[promptExpansionConfig.promptField]}
								rows={5}
								placeholder={promptExpansionConfig.promptPlaceholder || 'Describe what you want to build.'}
							/>
						</div>
					{/if}

					{#each visibleSchemaEntries as [key, prop]}
						{@const fieldConfig = workflowInputFieldConfigs[key]}
						<div class="space-y-1.5">
							<Label for="input-{key}">
								{fieldConfig?.label || toFieldLabel(key)}
								{#if effectiveInputSchema.required.includes(key)}
									<span class="text-destructive">*</span>
								{/if}
							</Label>
							{#if fieldConfig?.options?.length}
								<Select.Root
									type="single"
									value={formValues[key] || fieldConfig.defaultValue || ''}
									onValueChange={(value) => (formValues[key] = value)}
								>
									<Select.Trigger class="w-full">
										{formValues[key] || fieldConfig.defaultValue || fieldConfig.description || toFieldLabel(key)}
									</Select.Trigger>
									<Select.Content>
										{#each fieldConfig.options as option}
											<Select.Item value={option.value}>{option.label}</Select.Item>
										{/each}
									</Select.Content>
								</Select.Root>
							{:else if fieldConfig?.type === 'textarea' || isLongTextField(key)}
								<Textarea
									id="input-{key}"
									bind:value={formValues[key]}
									rows={key === 'ui_brief' ? 4 : 3}
									placeholder={fieldConfig?.description || prop.description || toFieldLabel(key)}
								/>
							{:else}
								<Input
									id="input-{key}"
									type={prop.type === 'integer' || prop.type === 'number' ? 'number' : 'text'}
									bind:value={formValues[key]}
									placeholder={fieldConfig?.description || prop.description || toFieldLabel(key)}
								/>
							{/if}
						</div>
					{/each}
				</div>
			{:else}
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
