function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPresentValue(record: Record<string, unknown>, key: string): boolean {
	if (!(key in record)) return false;
	const value = record[key];
	if (value === null || value === undefined) return false;
	if (typeof value === 'string') return value.trim().length > 0;
	return true;
}

function workflowInputSchema(spec: Record<string, unknown>): Record<string, unknown> | null {
	const input = isRecord(spec.input) ? spec.input : null;
	const schema = input && isRecord(input.schema) ? input.schema : null;
	const schemaDocument = schema && isRecord(schema.document) ? schema.document : null;
	if (schemaDocument) return schemaDocument;

	const document = isRecord(spec.document) ? spec.document : null;
	const workflowBuilder =
		document && isRecord(document['x-workflow-builder']) ? document['x-workflow-builder'] : null;
	const workflowBuilderInput = workflowBuilder && isRecord(workflowBuilder.input) ? workflowBuilder.input : null;
	return workflowBuilderInput && isRecord(workflowBuilderInput.schema)
		? workflowBuilderInput.schema
		: null;
}

export function collectRequiredTriggerFields(spec: unknown): string[] {
	if (!isRecord(spec)) return [];
	const inputSchema = workflowInputSchema(spec);
	if (inputSchema) {
		return Array.isArray(inputSchema.required)
			? [
					...new Set(
						inputSchema.required.filter(
							(field): field is string => typeof field === 'string' && field.trim().length > 0
						)
					)
				].sort()
			: [];
	}
	const serialized = JSON.stringify(spec);
	const fields = new Set<string>();

	// Match {{ trigger.field }} (legacy/Mastra format)
	const legacyPattern = /\{\{\s*trigger\.([a-zA-Z0-9_]+)(?=[.\s}])/g;
	for (const match of serialized.matchAll(legacyPattern)) {
		const field = match[1]?.trim();
		if (field) fields.add(field);
	}

	// Match ${ .trigger.field ... } (SW 1.0 jq expression format)
	const sw1Pattern = /\$\{\s*[^}]*\.trigger\.([a-zA-Z0-9_]+)/g;
	for (const match of serialized.matchAll(sw1Pattern)) {
		const field = match[1]?.trim();
		if (field) fields.add(field);
	}

	return [...fields].sort();
}

export function getMissingRequiredTriggerFields(
	spec: unknown,
	triggerData: Record<string, unknown>
): string[] {
	const required = collectRequiredTriggerFields(spec);
	return required.filter((field) => !hasPresentValue(triggerData, field));
}
