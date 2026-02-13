/**
 * Input Normalizer
 *
 * Extracted from fn-activepieces/src/executor.ts.
 * Normalizes MCP tool arguments to match what AP actions expect
 * (unwrap dropdown selections, parse multi-selects, etc.)
 */

type ApActionProp = {
	type?: string;
	displayName?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikePlaceholderSelection(
	value: string,
	displayName?: string,
): boolean {
	const normalized = value.trim().toLowerCase();
	if (!normalized) {
		return true;
	}

	const normalizedDisplayName = displayName?.trim().toLowerCase();
	if (normalizedDisplayName) {
		if (
			normalized === `your ${normalizedDisplayName}` ||
			normalized === `select ${normalizedDisplayName}` ||
			normalized === `enter ${normalizedDisplayName}`
		) {
			return true;
		}
	}

	return normalized.startsWith("your ");
}

export function normalizeActionInput(
	action: { props?: unknown },
	input: Record<string, unknown>,
): Record<string, unknown> {
	const normalizedInput: Record<string, unknown> = { ...input };
	if (!isRecord(action.props)) {
		return normalizedInput;
	}

	for (const [propKey, propDefUnknown] of Object.entries(action.props)) {
		if (!isRecord(propDefUnknown)) {
			continue;
		}

		const propDef = propDefUnknown as ApActionProp;
		const propType = propDef.type;
		const currentValue = normalizedInput[propKey];

		if (propType === "DROPDOWN") {
			if (isRecord(currentValue) && "value" in currentValue) {
				normalizedInput[propKey] = currentValue.value;
			}

			const normalizedValue = normalizedInput[propKey];
			if (typeof normalizedValue !== "string") {
				continue;
			}

			const trimmed = normalizedValue.trim();
			if (looksLikePlaceholderSelection(trimmed, propDef.displayName)) {
				delete normalizedInput[propKey];
				continue;
			}

			if (trimmed !== normalizedValue) {
				normalizedInput[propKey] = trimmed;
			}
			continue;
		}

		if (propType === "MULTI_SELECT_DROPDOWN") {
			if (typeof currentValue === "string") {
				const trimmed = currentValue.trim();
				if (looksLikePlaceholderSelection(trimmed, propDef.displayName)) {
					delete normalizedInput[propKey];
					continue;
				}

				try {
					const parsed = JSON.parse(trimmed) as unknown;
					if (Array.isArray(parsed)) {
						normalizedInput[propKey] = parsed;
						continue;
					}
				} catch {
					// Fall back to a singleton array.
				}

				normalizedInput[propKey] = [trimmed];
				continue;
			}

			if (isRecord(currentValue) && "value" in currentValue) {
				normalizedInput[propKey] = [currentValue.value];
			}
		}
	}

	return normalizedInput;
}
