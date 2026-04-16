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

function extensionFromFilename(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;

	const match = value.trim().match(/\.([A-Za-z0-9]+)$/);
	return match?.[1]?.toLowerCase();
}

function extensionFromMimeType(value: string): string | undefined {
	const mimeType = value.toLowerCase();
	if (
		mimeType ===
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	) {
		return "xlsx";
	}
	if (mimeType === "application/vnd.ms-excel") return "xls";
	if (mimeType === "text/csv") return "csv";
	if (mimeType === "application/pdf") return "pdf";
	if (mimeType === "application/json") return "json";
	if (mimeType === "text/plain") return "txt";
	return undefined;
}

function normalizeFileValue(
	value: unknown,
	fallbackExtension?: string,
): unknown {
	if (isRecord(value)) {
		const fileValue: Record<string, unknown> = { ...value };
		if (
			typeof fileValue.base64 === "string" &&
			fileValue.data === undefined
		) {
			fileValue.data = fileValue.base64;
		}
		if (
			typeof fileValue.extension !== "string" &&
			fallbackExtension !== undefined
		) {
			fileValue.extension = fallbackExtension;
		}
		return fileValue;
	}

	if (typeof value !== "string") {
		return value;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return value;
	}

	if (trimmed.startsWith("{")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isRecord(parsed)) {
				return normalizeFileValue(parsed, fallbackExtension);
			}
		} catch {
			const base64Match = trimmed.match(
				/['"](?:base64|data)['"]\s*:\s*['"]([^'"]+)['"]/,
			);
			if (base64Match) {
				const extensionMatch = trimmed.match(
					/['"]extension['"]\s*:\s*['"]([A-Za-z0-9]+)['"]/,
				);
				const base64 = base64Match[1];
				return {
					base64,
					data: base64,
					extension:
						extensionMatch?.[1]?.toLowerCase() ??
						fallbackExtension ??
						"bin",
				};
			}
		}
	}

	const dataUriMatch = trimmed.match(/^data:([^;,]+);base64,(.+)$/s);
	if (dataUriMatch) {
		const [, mimeType, base64] = dataUriMatch;
		return {
			base64,
			data: base64,
			extension:
				fallbackExtension ?? extensionFromMimeType(mimeType) ?? "bin",
		};
	}

	return {
		base64: trimmed,
		data: trimmed,
		extension: fallbackExtension ?? "bin",
	};
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

function coerceBoolean(value: unknown): unknown {
	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value !== "string") {
		return value;
	}

	const normalized = value.trim().toLowerCase();
	if (["true", "yes", "1"].includes(normalized)) {
		return true;
	}
	if (["false", "no", "0"].includes(normalized)) {
		return false;
	}

	return value;
}

function applyKnownAliases(
	input: Record<string, unknown>,
	propKey: string,
): void {
	if (input[propKey] !== undefined) {
		return;
	}

	if (propKey === "workbook" && input.workbookId !== undefined) {
		input.workbook = input.workbookId;
		return;
	}

	if (propKey === "workbook_id") {
		if (input.workbookId !== undefined) {
			input.workbook_id = input.workbookId;
			return;
		}
		if (input.workbook !== undefined) {
			input.workbook_id = input.workbook;
			return;
		}
	}

	if (propKey === "worksheet_id") {
		if (input.worksheetId !== undefined) {
			input.worksheet_id = input.worksheetId;
			return;
		}
		if (input.worksheet !== undefined) {
			input.worksheet_id = input.worksheet;
		}
	}
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
		applyKnownAliases(normalizedInput, propKey);

		const propType = propDef.type;
		const currentValue = normalizedInput[propKey];

		if (propType === "FILE") {
			normalizedInput[propKey] = normalizeFileValue(
				currentValue,
				extensionFromFilename(normalizedInput.fileName),
			);
			continue;
		}

		if (propType === "CHECKBOX") {
			normalizedInput[propKey] = coerceBoolean(currentValue);
			continue;
		}

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
