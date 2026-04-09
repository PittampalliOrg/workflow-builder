export interface PromptExpansionConfig {
	mode: 'single_prompt';
	promptField: string;
	derivedFields: string[];
	promptLabel?: string;
	promptPlaceholder?: string;
}

export interface WorkflowInputOption {
	label: string;
	value: string;
}

export interface WorkflowInputFieldConfig {
	type?: 'text' | 'textarea' | 'select';
	label?: string;
	description?: string;
	defaultValue?: string;
	options?: WorkflowInputOption[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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
	if (derivedFields.length === 0) return null;

	return {
		mode: 'single_prompt',
		promptField,
		derivedFields,
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
	if (!document) return {};
	const wb = isRecord(document['x-workflow-builder']) ? document['x-workflow-builder'] : null;
	const input = wb && isRecord(wb.input) ? wb.input : null;
	const rawFields = input && isRecord(input.fields) ? input.fields : null;
	if (!rawFields) return {};

	const fields: Record<string, WorkflowInputFieldConfig> = {};
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
				value.type === 'textarea' || value.type === 'select' || value.type === 'text'
					? value.type
					: undefined,
			label:
				typeof value.label === 'string' && value.label.trim().length > 0
					? value.label.trim()
					: undefined,
			description:
				typeof value.description === 'string' && value.description.trim().length > 0
					? value.description.trim()
					: undefined,
			defaultValue:
				typeof value.defaultValue === 'string' && value.defaultValue.trim().length > 0
					? value.defaultValue.trim()
					: undefined,
			options: options && options.length > 0 ? options : undefined
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
