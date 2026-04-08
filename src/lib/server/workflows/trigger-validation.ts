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

export function collectRequiredTriggerFields(spec: unknown): string[] {
	if (!isRecord(spec)) return [];
	const serialized = JSON.stringify(spec);
	const pattern = /\{\{\s*trigger\.([a-zA-Z0-9_]+)(?=[.\s}])/g;
	const fields = new Set<string>();

	for (const match of serialized.matchAll(pattern)) {
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

