import type {
	ActionConfigField,
	ActionConfigFieldBase,
	ActionConfigFieldGroup,
	IntegrationType,
} from "./types";

/**
 * Compute a namespaced action ID `{integration}/{slug}`.
 */
export function computeActionId(
	integration: IntegrationType,
	slug: string,
): string {
	return `${integration}/${slug}`;
}

/**
 * Parse a namespaced action ID `{integration}/{slug}`.
 */
export function parseActionId(
	actionId: string,
): { integration: string; slug: string } | null {
	const idx = actionId.indexOf("/");
	if (idx <= 0 || idx >= actionId.length - 1) {
		return null;
	}
	return { integration: actionId.slice(0, idx), slug: actionId.slice(idx + 1) };
}

export function isFieldGroup(
	field: ActionConfigField,
): field is ActionConfigFieldGroup {
	return field.type === "group";
}

/**
 * Flatten config fields, extracting fields from groups.
 * Useful for validation and AI prompt generation.
 */
export function flattenConfigFields(
	fields: ActionConfigField[],
): ActionConfigFieldBase[] {
	const result: ActionConfigFieldBase[] = [];

	for (const field of fields) {
		if (isFieldGroup(field)) {
			result.push(...field.fields);
		} else {
			result.push(field);
		}
	}

	return result;
}
