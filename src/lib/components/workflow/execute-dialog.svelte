<script lang="ts">
	import { getContext, untrack } from 'svelte';
	import { Play, Loader2, CircleAlert } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Select from '$lib/components/ui/select';
	import * as Tabs from '$lib/components/ui/tabs';
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
		model: 'Model to use for durable/run steps',
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

	function fieldDefaultValue(key: string, prop: SchemaProperty): string {
		const configured = workflowInputFieldConfigs[key]?.defaultValue;
		if (configured !== undefined) return configured;
		const raw = prop.default;
		if (typeof raw === 'string') return raw;
		if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
		return '';
	}

	function selectedOptionLabel(
		options: { label: string; value: string }[] | undefined,
		value: string,
		fallback: string
	): string {
		if (!value) return fallback;
		return options?.find((option) => option.value === value)?.label ?? value;
	}

	function setFormValue(key: string, value: string | undefined) {
		formValues = {
			...formValues,
			[key]: value ?? ''
		};
	}

	interface Props {
		open: boolean;
		onClose: () => void;
		onExecute: (
			input: Record<string, unknown>,
			opts?: { budgetTotal?: number | null }
		) => void;
	}

	interface SchemaProperty {
		type: string;
		description?: string;
		default?: unknown;
		enum?: unknown[];
		title?: string;
	}

	let { open = $bindable(), onClose, onExecute }: Props = $props();

	let isSubmitting = $state(false);
	let errorMsg = $state<string | null>(null);

	/** Walk spec.do and collect task names of durable/run tasks without
	 * a bound agentRef. Mirrors the server-side resolver at
	 * src/lib/server/agents/resolver.ts so the user sees the 400 reason
	 * proactively instead of after submit. */
	function findUnboundAgentTasks(spec: Record<string, unknown> | null | undefined): string[] {
		const unbound: string[] = [];
		if (!spec || typeof spec !== 'object') return unbound;
		const doArr = (spec as { do?: unknown }).do;
		if (!Array.isArray(doArr)) return unbound;
		for (const entry of doArr) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
			const taskName = Object.keys(entry as Record<string, unknown>)[0];
			const task = taskName ? (entry as Record<string, unknown>)[taskName] : null;
			if (!task || typeof task !== 'object') continue;
			if ((task as { call?: string }).call !== 'durable/run') continue;
			const withBlock = ((task as Record<string, unknown>).with ?? {}) as Record<string, unknown>;
			const body = (withBlock.body ?? withBlock) as Record<string, unknown>;
			// A durable/run node is "bound" if it references a managed agent by id
			// OR by slug — including a trigger-templated slug like
			// `${ .trigger.agentSlug // "general-assistant" }`. The workflow→session
			// bridge resolves slug→agent at dispatch, so slug-bound (and templated)
			// refs are runnable and must NOT be flagged unbound.
			const refOf = (v: unknown) => v as { id?: unknown; slug?: unknown } | undefined;
			const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
			const bodyRef = refOf(body.agentRef);
			const withRef = refOf(withBlock.agentRef);
			const bound =
				nonEmpty(bodyRef?.id) ||
				nonEmpty(withRef?.id) ||
				nonEmpty(bodyRef?.slug) ||
				nonEmpty(withRef?.slug) ||
				nonEmpty(body.agentSlug) ||
				nonEmpty(withBlock.agentSlug);
			if (!bound) unbound.push(taskName as string);
		}
		return unbound;
	}

	let unboundAgentTasks = $derived(findUnboundAgentTasks(store.spec));

	// Dynamic-script engine: a distinct confirm panel (no SW trigger schema —
	// the script's `args` global is free-form JSON). Detected from the spec.
	let isDynamicScript = $derived(
		(store.spec as Record<string, unknown> | null)?.engine === 'dynamic-script'
	);
	let scriptMeta = $derived.by(() => {
		const m = ((store.spec as Record<string, unknown> | null)?.meta ?? {}) as Record<
			string,
			unknown
		>;
		const phasesRaw = Array.isArray(m.phases) ? m.phases : [];
		const phases = phasesRaw
			.map((p) =>
				typeof p === 'string'
					? p
					: p && typeof p === 'object' && typeof (p as Record<string, unknown>).title === 'string'
						? ((p as Record<string, unknown>).title as string)
						: null
			)
			.filter((t): t is string => Boolean(t));
		return {
			name: typeof m.name === 'string' ? m.name : 'Dynamic script',
			description: typeof m.description === 'string' ? m.description : null,
			phases,
			estimatedAgentCalls:
				typeof m.estimatedAgentCalls === 'number' ? m.estimatedAgentCalls : null
		};
	});
	let scriptArgsJson = $state('{}');
	let scriptBudgetTotal = $state<string>('');
	// meta.input (cutover P1f): an object JSON Schema turns the free-form Args
	// textarea into a generated form (same start-path validation applies).
	let scriptInputSchema = $derived.by(() => {
		const m = ((store.spec as Record<string, unknown> | null)?.meta ?? {}) as Record<
			string,
			unknown
		>;
		const input = m.input;
		return input && typeof input === 'object' && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: null;
	});
	// Flat field model for the meta.input form. The sjsf generated form needs a
	// theme-component registration this app doesn't wire (its other consumers
	// hand-roll fields too), so render the fields directly — same shape as the
	// SW trigger form above.
	type ScriptInputField = {
		key: string;
		type: 'string' | 'number' | 'boolean' | 'enum' | 'json';
		label: string;
		description: string | null;
		required: boolean;
		options: string[];
		defaultValue: unknown;
		/** Semantic annotation (`x-wfb: {kind}`): 'agent' renders a typed picker
		 * populated from the agent catalog; unknown kinds degrade to plain
		 * inputs. Vendor keywords are ignored by Ajv (strict:false) — the run
		 * contract is unchanged. */
		wfbKind: string | null;
		wfbRuntime: string | null;
	};
	const scriptInputFields = $derived.by<ScriptInputField[]>(() => {
		const schema = scriptInputSchema;
		if (!schema) return [];
		const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
		const required = new Set(
			Array.isArray(schema.required) ? (schema.required as string[]) : []
		);
		return Object.entries(props).map(([key, prop]) => {
			const enumVals = Array.isArray(prop.enum) ? (prop.enum as unknown[]) : [];
			const t = String(prop.type ?? '');
			const type: ScriptInputField['type'] = enumVals.length
				? 'enum'
				: t === 'number' || t === 'integer'
					? 'number'
					: t === 'boolean'
						? 'boolean'
						: t === 'object' || t === 'array'
							? 'json'
							: 'string';
			const xwfb =
				prop['x-wfb'] && typeof prop['x-wfb'] === 'object' && !Array.isArray(prop['x-wfb'])
					? (prop['x-wfb'] as Record<string, unknown>)
					: null;
			return {
				key,
				type,
				label: typeof prop.title === 'string' ? prop.title : toFieldLabel(key),
				description: typeof prop.description === 'string' ? prop.description : null,
				required: required.has(key),
				options: enumVals.map((v) => String(v)),
				defaultValue: prop.default,
				wfbKind: typeof xwfb?.kind === 'string' ? xwfb.kind : null,
				wfbRuntime: typeof xwfb?.runtime === 'string' ? xwfb.runtime : null
			};
		});
	});
	let scriptFieldValues = $state<Record<string, string>>({});

	// Agent picker catalog (x-wfb kind 'agent'): fetched once per dialog open,
	// only when the schema actually declares an agent-kind input.
	type AgentOption = { slug: string; name: string; runtime: string | null };
	let agentOptions = $state<AgentOption[] | null>(null);
	let agentFetchSeq = 0;
	$effect(() => {
		if (!open) return;
		if (!scriptInputFields.some((f) => f.wfbKind === 'agent')) return;
		if (agentOptions !== null) return;
		const seq = ++agentFetchSeq;
		void (async () => {
			try {
				const res = await fetch('/api/agents');
				if (!res.ok) return;
				const body = (await res.json()) as {
					agents?: Array<{ slug?: string; name?: string; runtime?: string | null }>;
				};
				if (seq !== agentFetchSeq) return;
				agentOptions = (body.agents ?? [])
					.filter((a) => typeof a.slug === 'string' && a.slug && !a.slug.startsWith('wf-') && !a.slug.startsWith('exp-'))
					.map((a) => ({
						slug: a.slug as string,
						name: typeof a.name === 'string' ? a.name : (a.slug as string),
						runtime: typeof a.runtime === 'string' ? a.runtime : null
					}));
			} catch {
				/* picker degrades to a free-text input */
			}
		})();
	});
	function agentChoices(field: ScriptInputField): AgentOption[] {
		const list = agentOptions ?? [];
		return field.wfbRuntime && field.wfbRuntime !== 'any'
			? list.filter((a) => a.runtime === field.wfbRuntime)
			: list;
	}
	$effect(() => {
		if (!open || !scriptInputSchema) return;
		const fields = scriptInputFields;
		// untrack: this effect SEEDS the field values from schema defaults. It must
		// react only to open/schema — reading AND writing scriptFieldValues while
		// subscribed to it is an infinite effect loop (a fresh object every pass)
		// that freezes the dialog the moment it opens.
		untrack(() => {
			const next: Record<string, string> = {};
			let changed = false;
			for (const f of fields) {
				const existing = scriptFieldValues[f.key];
				const seeded =
					existing !== undefined && existing !== ''
						? existing
						: f.defaultValue === undefined || f.defaultValue === null
							? ''
							: typeof f.defaultValue === 'object'
								? JSON.stringify(f.defaultValue)
								: String(f.defaultValue);
				next[f.key] = seeded;
				if (seeded !== existing) changed = true;
			}
			if (changed || Object.keys(scriptFieldValues).length !== fields.length) {
				scriptFieldValues = next;
			}
		});
	});
	function scriptArgsFromFields(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const f of scriptInputFields) {
			const raw = scriptFieldValues[f.key];
			if (raw === undefined || raw === '') continue;
			if (f.type === 'number') {
				const n = Number(raw);
				if (Number.isFinite(n)) out[f.key] = n;
			} else if (f.type === 'boolean') {
				out[f.key] = raw === 'true';
			} else if (f.type === 'json') {
				try {
					out[f.key] = JSON.parse(raw);
				} catch {
					out[f.key] = raw;
				}
			} else {
				out[f.key] = raw;
			}
		}
		return out;
	}

	async function handleScriptSubmit() {
		errorMsg = null;
		isSubmitting = true;
		try {
			let input: Record<string, unknown>;
			if (scriptInputSchema) {
				input = scriptArgsFromFields();
			} else {
				try {
					input = scriptArgsJson.trim() ? JSON.parse(scriptArgsJson) : {};
				} catch {
					errorMsg = 'Invalid args JSON';
					isSubmitting = false;
					return;
				}
			}
			const budgetTotal = scriptBudgetTotal.trim() ? Number(scriptBudgetTotal) : null;
			if (budgetTotal != null && (!Number.isFinite(budgetTotal) || budgetTotal < 0)) {
				errorMsg = 'Budget must be a non-negative number';
				isSubmitting = false;
				return;
			}
			onExecute(input, { budgetTotal });
			handleClose();
		} finally {
			isSubmitting = false;
		}
	}

	let rawJson = $state('{}');
	let inputMode = $state<'form' | 'json'>('form');
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
					const defaultValue = fieldDefaultValue(key, effectiveInputSchema.properties[key]);
					nextValues[key] = existingValue || defaultValue;
				}
				formValues = nextValues;
			}
			initialized = true;
		}

		if (!open) {
			initialized = false;
			inputMode = 'form';
		}
	});

	$effect(() => {
		if (open && effectiveInputSchema && inputMode === 'form') {
			rawJson = JSON.stringify(buildInputFromSchema(), null, 2);
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

			if (inputMode === 'json' || !effectiveInputSchema) {
				try {
					input = JSON.parse(rawJson);
				} catch {
					errorMsg = 'Invalid JSON';
					isSubmitting = false;
					return;
				}
			} else {
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

		{#if unboundAgentTasks.length > 0}
			<Alert variant="destructive">
				<CircleAlert class="size-4" />
				<AlertDescription>
					{unboundAgentTasks.length === 1 ? 'Task' : 'Tasks'}
					<strong>{unboundAgentTasks.join(', ')}</strong>
					{unboundAgentTasks.length === 1 ? "doesn't have" : "don't have"}
					an agent selected. Open each node's Properties panel and bind a managed
					agent before executing.
				</AlertDescription>
			</Alert>
		{/if}

		{#if errorMsg}
			<Alert variant="destructive">
				<CircleAlert class="size-4" />
				<AlertDescription>{errorMsg}</AlertDescription>
			</Alert>
		{/if}

		{#if isDynamicScript}
			<form onsubmit={(event) => { event.preventDefault(); handleScriptSubmit(); }}>
				<div class="space-y-3 max-h-[450px] overflow-y-auto pr-1">
					<div class="space-y-1">
						<div class="text-sm font-semibold">{scriptMeta.name}</div>
						{#if scriptMeta.description}
							<p class="text-xs text-muted-foreground">{scriptMeta.description}</p>
						{/if}
					</div>
					{#if scriptMeta.phases.length}
						<div class="flex flex-wrap gap-1.5">
							{#each scriptMeta.phases as phase (phase)}
								<span class="rounded-md border px-2 py-0.5 text-xs text-muted-foreground">{phase}</span>
							{/each}
						</div>
					{/if}
					{#if scriptMeta.estimatedAgentCalls != null}
						<p class="text-xs text-muted-foreground">
							Estimated agent calls: <strong>{scriptMeta.estimatedAgentCalls}</strong>
						</p>
					{/if}
					{#if scriptInputSchema}
						<div class="space-y-2.5">
							<p class="text-xs font-semibold">Input</p>
							{#each scriptInputFields as field (field.key)}
								<div class="space-y-1.5">
									<Label for="script-input-{field.key}">
										{field.label}
										{#if field.required}<span class="text-destructive">*</span>{/if}
									</Label>
									{#if field.wfbKind === 'agent' && agentChoices(field).length > 0}
										<Select.Root
											type="single"
											value={scriptFieldValues[field.key] ?? ''}
											onValueChange={(v) => (scriptFieldValues = { ...scriptFieldValues, [field.key]: v })}
										>
											<Select.Trigger class="w-full">
												{#if scriptFieldValues[field.key]}
													{@const sel = agentChoices(field).find((a) => a.slug === scriptFieldValues[field.key])}
													{sel ? sel.name : scriptFieldValues[field.key]}
												{:else}
													Select an agent…
												{/if}
											</Select.Trigger>
											<Select.Content>
												{#each agentChoices(field) as a (a.slug)}
													<Select.Item value={a.slug}>
														<span class="flex w-full items-center justify-between gap-2">
															<span class="truncate">{a.name}</span>
															{#if a.runtime}
																<span class="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">{a.runtime}</span>
															{/if}
														</span>
													</Select.Item>
												{/each}
											</Select.Content>
										</Select.Root>
									{:else if field.type === 'enum'}
										<Select.Root
											type="single"
											value={scriptFieldValues[field.key] ?? ''}
											onValueChange={(v) => (scriptFieldValues = { ...scriptFieldValues, [field.key]: v })}
										>
											<Select.Trigger class="w-full">
												{scriptFieldValues[field.key] || field.description || 'Select…'}
											</Select.Trigger>
											<Select.Content>
												{#each field.options as option (option)}
													<Select.Item value={option}>{option}</Select.Item>
												{/each}
											</Select.Content>
										</Select.Root>
									{:else if field.type === 'boolean'}
										<Select.Root
											type="single"
											value={scriptFieldValues[field.key] ?? ''}
											onValueChange={(v) => (scriptFieldValues = { ...scriptFieldValues, [field.key]: v })}
										>
											<Select.Trigger class="w-full">
												{scriptFieldValues[field.key] || 'false'}
											</Select.Trigger>
											<Select.Content>
												<Select.Item value="true">true</Select.Item>
												<Select.Item value="false">false</Select.Item>
											</Select.Content>
										</Select.Root>
									{:else if field.type === 'json'}
										<Textarea
											id="script-input-{field.key}"
											bind:value={scriptFieldValues[field.key]}
											rows={3}
											class="font-mono text-xs"
										/>
									{:else}
										<Input
											id="script-input-{field.key}"
											type={field.type === 'number' ? 'number' : 'text'}
											bind:value={scriptFieldValues[field.key]}
											placeholder={field.description ?? ''}
										/>
									{/if}
									{#if field.description}
										<p class="text-[10px] text-muted-foreground">{field.description}</p>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<div class="space-y-1.5">
							<Label for="script-args">Args (JSON)</Label>
							<Textarea
								id="script-args"
								bind:value={scriptArgsJson}
								rows={6}
								class="font-mono"
								placeholder={'{"topic": "hello"}'}
							/>
						</div>
					{/if}
					<div class="space-y-1.5">
						<Label for="script-budget">Budget (tokens, optional)</Label>
						<Input
							id="script-budget"
							type="number"
							min="0"
							bind:value={scriptBudgetTotal}
							placeholder="e.g. 500000"
						/>
					</div>
				</div>
				<DialogFooter class="mt-4">
					<Button variant="outline" type="button" onclick={handleClose}>Cancel</Button>
					<Button type="submit" disabled={isSubmitting}>
						{#if isSubmitting}
							<Loader2 size={14} class="animate-spin" /> Starting...
						{:else}
							<Play size={14} /> Run script
						{/if}
					</Button>
				</DialogFooter>
			</form>
		{:else}
		<form onsubmit={(event) => { event.preventDefault(); handleSubmit(); }}>
			{#if effectiveInputSchema}
				<Tabs.Root bind:value={inputMode} class="min-h-0 gap-3">
					<Tabs.List class="h-7 w-full">
						<Tabs.Trigger value="form" class="text-xs">Form</Tabs.Trigger>
						<Tabs.Trigger value="json" class="text-xs">JSON</Tabs.Trigger>
					</Tabs.List>
					<Tabs.Content value="form" class="mt-0">
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
								{@const options = fieldConfig?.options ?? []}
								<div class="space-y-1.5">
									<Label for="input-{key}">
										{fieldConfig?.label || toFieldLabel(key)}
										{#if effectiveInputSchema.required.includes(key)}
											<span class="text-destructive">*</span>
										{/if}
									</Label>
									{#if fieldConfig?.type === 'multiselect' && fieldConfig?.options?.length}
										{@const selected = new Set((formValues[key] || fieldConfig.defaultValue || '').split(',').map((s: string) => s.trim()).filter(Boolean))}
										<div class="flex flex-wrap gap-1.5">
											{#each fieldConfig.options as option}
												{@const isSelected = selected.has(option.value)}
												<button
													type="button"
													class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors {isSelected ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground hover:bg-muted'}"
													onclick={() => {
														const current = new Set((formValues[key] || fieldConfig.defaultValue || '').split(',').map((s: string) => s.trim()).filter(Boolean));
														if (current.has(option.value)) {
															current.delete(option.value);
														} else {
															current.add(option.value);
														}
														setFormValue(key, [...current].join(','));
													}}
												>
													<span class="h-3 w-3 rounded-sm border {isSelected ? 'border-primary bg-primary' : 'border-muted-foreground/40'}">
														{#if isSelected}
															<svg viewBox="0 0 12 12" class="h-3 w-3 text-primary-foreground"><path d="M3 6l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
														{/if}
													</span>
													{option.label}
												</button>
											{/each}
										</div>
									{:else if options.length}
										<Select.Root
											type="single"
											value={formValues[key] || ''}
											onValueChange={(value) => setFormValue(key, value)}
										>
											<Select.Trigger class="w-full">
												{selectedOptionLabel(
													options,
													formValues[key],
													fieldConfig?.description || prop.description || toFieldLabel(key)
												)}
											</Select.Trigger>
											<Select.Content>
												{#each options as option}
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
					</Tabs.Content>
					<Tabs.Content value="json" class="mt-0">
						<div class="space-y-1.5">
							<Label for="raw-input">Input (JSON)</Label>
							<Textarea
								id="raw-input"
								bind:value={rawJson}
								rows={10}
								class="font-mono"
								placeholder={'{"key": "value"}'}
							/>
						</div>
					</Tabs.Content>
				</Tabs.Root>
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
				<Button
					type="submit"
					disabled={isSubmitting || unboundAgentTasks.length > 0}
					title={unboundAgentTasks.length > 0
						? 'Bind an agent to every durable/run task first'
						: undefined}
				>
					{#if isSubmitting}
						<Loader2 size={14} class="animate-spin" /> Starting...
					{:else}
						<Play size={14} /> Execute
					{/if}
				</Button>
			</DialogFooter>
		</form>
		{/if}
	</DialogContent>
</Dialog>
