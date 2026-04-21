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
	if (
		mimeType ===
		"application/vnd.openxmlformats-officedocument.presentationml.presentation"
	) {
		return "pptx";
	}
	if (mimeType === "text/csv") return "csv";
	if (mimeType === "application/pdf") return "pdf";
	if (mimeType === "application/json") return "json";
	if (mimeType === "text/plain") return "txt";
	return undefined;
}

/**
 * Fetch a URL and convert the response body to base64. Used to transparently
 * resolve FILE props passed as `{url: "..."}` into `{base64, data, extension}`
 * so pieces that only read `fileData.base64` (e.g. microsoft-onedrive's
 * upload_onedrive_file) work seamlessly. Bypasses the LLM-truncates-large-
 * base64-in-tool-call-args problem by fetching server-side.
 */
async function fetchUrlAsBase64(
	url: string,
): Promise<{ base64: string; extension?: string } | null> {
	try {
		const res = await fetch(url, { redirect: "follow" });
		if (!res.ok) {
			console.warn(
				`[normalize-input] FILE url fetch failed: ${res.status} ${url}`,
			);
			return null;
		}
		const buf = Buffer.from(await res.arrayBuffer());
		const base64 = buf.toString("base64");
		const contentType = res.headers.get("content-type") || "";
		const extension = extensionFromMimeType(contentType);
		return { base64, extension };
	} catch (err) {
		console.warn(
			`[normalize-input] FILE url fetch threw: ${err instanceof Error ? err.message : String(err)} ${url}`,
		);
		return null;
	}
}

async function normalizeFileValue(
	value: unknown,
	fallbackExtension?: string,
): Promise<unknown> {
	if (isRecord(value)) {
		const fileValue: Record<string, unknown> = { ...value };
		// URL-mode: if only `url` is provided (no base64/data yet), fetch the
		// URL server-side and populate base64 so downstream pieces that read
		// `fileData.base64` (microsoft-onedrive, google-drive, etc.) work.
		// This bypasses the LLM-can't-emit-large-base64 tool-call-arg limit —
		// the agent just points at a reachable URL and we do the transport.
		const hasBase64 =
			typeof fileValue.base64 === "string" &&
			(fileValue.base64 as string).length > 0;
		const hasData =
			typeof fileValue.data === "string" &&
			(fileValue.data as string).length > 0;
		if (
			!hasBase64 &&
			!hasData &&
			typeof fileValue.url === "string" &&
			(fileValue.url as string).trim().length > 0
		) {
			const fetched = await fetchUrlAsBase64(
				(fileValue.url as string).trim(),
			);
			if (fetched) {
				fileValue.base64 = fetched.base64;
				fileValue.data = fetched.base64;
				if (
					typeof fileValue.extension !== "string" &&
					fetched.extension
				) {
					fileValue.extension = fetched.extension;
				}
			}
		}
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
				return await normalizeFileValue(parsed, fallbackExtension);
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

export async function normalizeActionInput(
	action: { props?: unknown },
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
			normalizedInput[propKey] = await normalizeFileValue(
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
