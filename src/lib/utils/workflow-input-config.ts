export interface PromptExpansionConfig {
	mode: 'single_prompt';
	promptField: string;
	derivedFields: string[];
	promptLabel?: string;
	promptPlaceholder?: string;
	/** True when derivedFields is non-empty and AI expansion is required. */
	requiresExpansion: boolean;
}

export interface WorkflowInputOption {
	label: string;
	value: string;
}

export interface WorkflowInputFieldConfig {
	type?: 'text' | 'textarea' | 'select' | 'multiselect';
	label?: string;
	description?: string;
	defaultValue?: string;
	options?: WorkflowInputOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : undefined;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return undefined;
}

function enumOptions(value: unknown): WorkflowInputOption[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const options = value
		.map((item) => stringValue(item))
		.filter((item): item is string => Boolean(item))
		.map((item) => ({ label: item, value: item }));
	return options.length > 0 ? options : undefined;
}

function workflowInputSchemaProperties(spec: Record<string, unknown>): Record<string, unknown> {
	const topLevelInput = isRecord(spec.input) ? spec.input : null;
	const topLevelSchema = topLevelInput && isRecord(topLevelInput.schema) ? topLevelInput.schema : null;
	const topLevelDocument =
		topLevelSchema && isRecord(topLevelSchema.document) ? topLevelSchema.document : null;
	if (topLevelDocument && isRecord(topLevelDocument.properties)) {
		return topLevelDocument.properties;
	}

	const document = isRecord(spec.document) ? spec.document : null;
	const wb = document && isRecord(document['x-workflow-builder']) ? document['x-workflow-builder'] : null;
	const input = wb && isRecord(wb.input) ? wb.input : null;
	const schema = input && isRecord(input.schema) ? input.schema : null;
	return schema && isRecord(schema.properties) ? schema.properties : {};
}

export function getPromptExpansionConfig(spec: unknown): PromptExpansionConfig | null {
	if (!isRecord(spec)) return null;
	const document = isRecord(spec.document) ? spec.document : null;
	if (!document) return null;
	const wb = isRecord(document['x-workflow-builder']) ? document['x-workflow-builder'] : null;
	const input = wb && isRecord(wb.input) ? wb.input : null;
	if (!input || input.mode !== 'single_prompt') return null;

	const promptField =
		typeof input.promptField === 'string' && input.promptField.trim()
			? input.promptField.trim()
			: 'prompt';
	const derivedFields = Array.isArray(input.derivedFields)
		? input.derivedFields.filter((field): field is string => typeof field === 'string' && field.trim().length > 0)
		: [];

	return {
		mode: 'single_prompt',
		promptField,
		derivedFields,
		requiresExpansion: derivedFields.length > 0,
		promptLabel:
			typeof input.promptLabel === 'string' && input.promptLabel.trim()
				? input.promptLabel.trim()
				: undefined,
		promptPlaceholder:
			typeof input.promptPlaceholder === 'string' && input.promptPlaceholder.trim()
				? input.promptPlaceholder.trim()
				: undefined
	};
}

export function getWorkflowInputFieldConfigs(
	spec: unknown
): Record<string, WorkflowInputFieldConfig> {
	if (!isRecord(spec)) return {};
	const document = isRecord(spec.document) ? spec.document : null;
	const wb = document && isRecord(document['x-workflow-builder']) ? document['x-workflow-builder'] : null;
	const input = wb && isRecord(wb.input) ? wb.input : null;
	const rawFields = input && isRecord(input.fields) ? input.fields : null;

	const fields: Record<string, WorkflowInputFieldConfig> = {};
	if (rawFields) {
		for (const [key, value] of Object.entries(rawFields)) {
			if (!isRecord(value)) continue;
			const options = Array.isArray(value.options)
				? value.options
						.filter(
							(option): option is Record<string, unknown> =>
								isRecord(option) &&
								typeof option.label === 'string' &&
								option.label.trim().length > 0 &&
								typeof option.value === 'string' &&
								option.value.trim().length > 0
						)
						.map((option) => ({
							label: String(option.label).trim(),
							value: String(option.value).trim()
						}))
				: undefined;

			fields[key] = {
				type:
					value.type === 'textarea' || value.type === 'select' || value.type === 'text' || value.type === 'multiselect'
						? value.type
						: undefined,
				label: nonEmptyString(value.label),
				description: nonEmptyString(value.description),
				defaultValue: stringValue(value.defaultValue),
				options: options && options.length > 0 ? options : undefined
			};
		}
	}

	for (const [key, value] of Object.entries(workflowInputSchemaProperties(spec))) {
		if (!isRecord(value)) continue;
		const options = enumOptions(value.enum);
		const defaultValue = stringValue(value.default);
		if (!options && defaultValue === undefined && !value.title && !value.description) continue;
		const existing = fields[key] ?? {};
		fields[key] = {
			type: existing.type ?? (options ? 'select' : undefined),
			label: existing.label ?? nonEmptyString(value.title),
			description: existing.description ?? nonEmptyString(value.description),
			defaultValue: existing.defaultValue ?? defaultValue,
			options: existing.options ?? options
		};
	}

	return fields;
}

export function applyWorkflowInputDefaults(
	spec: unknown,
	triggerData: Record<string, unknown>
): Record<string, unknown> {
	const fieldConfigs = getWorkflowInputFieldConfigs(spec);
	if (Object.keys(fieldConfigs).length === 0) return triggerData;

	const nextData = { ...triggerData };
	for (const [key, config] of Object.entries(fieldConfigs)) {
		const current = nextData[key];
		const hasValue =
			typeof current === 'string'
				? current.trim().length > 0
				: current !== null && current !== undefined;
		if (!hasValue && config.defaultValue !== undefined) {
			nextData[key] = config.defaultValue;
		}
	}

	return nextData;
}
