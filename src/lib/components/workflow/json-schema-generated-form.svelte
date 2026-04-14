<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		Content,
		Form,
		ON_CHANGE,
		ON_INPUT,
		createForm,
		setFormContext,
		type Schema,
		type UiSchemaRoot
	} from '@sjsf/form';
	import { resolver } from '@sjsf/form/resolvers/basic';
	import { translation } from '@sjsf/form/translations/en';
	import { createFormMerger } from '@sjsf/form/mergers/modern';
	import { createFormIdBuilder } from '@sjsf/form/id-builders/modern';
	import { createFormValidator } from '@sjsf/ajv8-validator';
	import { theme } from '@sjsf/shadcn4-theme';

	interface Props {
		schema: Schema;
		value: unknown;
		onChange: (value: unknown) => void;
		uiSchema?: UiSchemaRoot;
		disabled?: boolean;
	}

	let { schema, value, onChange, uiSchema = {}, disabled = false }: Props = $props();

	const form = createForm<unknown>({
		theme,
		get schema() {
			return schema;
		},
		get uiSchema() {
			return uiSchema;
		},
		resolver,
		translation,
		merger: createFormMerger,
		validator: createFormValidator,
		idBuilder: createFormIdBuilder,
		get disabled() {
			return disabled;
		},
		fieldsValidationMode: ON_INPUT | ON_CHANGE,
		value: [
			() => value,
			(nextValue) => onChange(nextValue)
		],
		onSubmit: (nextValue) => onChange(nextValue)
	});

	setFormContext(form);

	onDestroy(() => {
		form.submission.abort();
		form.fieldsValidation.abort();
	});

	function preventSubmit(event: SubmitEvent) {
		event.preventDefault();
	}
</script>

<div class="workflow-json-schema-generated-form">
	<Form attributes={{ onsubmit: preventSubmit }}>
		<Content />
	</Form>
</div>

<style>
	.workflow-json-schema-generated-form :global(form) {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.workflow-json-schema-generated-form :global([data-slot='field']),
	.workflow-json-schema-generated-form :global([data-slot='field-content']),
	.workflow-json-schema-generated-form :global(.sjsf-layout[data-layout='field']),
	.workflow-json-schema-generated-form :global(.sjsf-layout[data-layout='object-field']),
	.workflow-json-schema-generated-form :global(.sjsf-layout[data-layout='array-field']) {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.workflow-json-schema-generated-form :global([data-slot='field-label']),
	.workflow-json-schema-generated-form :global(label) {
		font-size: 0.75rem;
		line-height: 1rem;
		font-weight: 500;
	}

	.workflow-json-schema-generated-form :global([data-slot='field-description']),
	.workflow-json-schema-generated-form :global(.sjsf-description),
	.workflow-json-schema-generated-form :global(.sjsf-help) {
		color: var(--muted-foreground);
		font-size: 0.6875rem;
		line-height: 0.95rem;
	}

	.workflow-json-schema-generated-form :global([data-slot='field-error']),
	.workflow-json-schema-generated-form :global(.sjsf-errors-list) {
		color: var(--destructive);
		font-size: 0.6875rem;
		line-height: 0.95rem;
	}

	.workflow-json-schema-generated-form :global(input:not([type='checkbox']):not([type='radio'])),
	.workflow-json-schema-generated-form :global(select),
	.workflow-json-schema-generated-form :global(textarea) {
		width: 100%;
		min-width: 0;
	}

	.workflow-json-schema-generated-form :global(.sjsf-title) {
		font-size: 0.75rem;
		font-weight: 600;
	}
</style>
