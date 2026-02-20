import { getConfiguration } from "@/lib/dapr/client";

const DEFAULT_STORE =
	process.env.DAPR_CONFIG_STORE || "azureappconfig-workflow-builder";
const DEFAULT_LABEL = process.env.CONFIG_LABEL || "workflow-builder";

type RuntimeConfigReadInput = {
	storeName?: string;
	configKey: string;
	metadata?: Record<string, string>;
};

type RuntimeConfigWriteInput = {
	storeName?: string;
	configKey: string;
	value: string;
	metadata?: Record<string, string>;
};

export function normalizeRuntimeConfigMetadata(
	metadata: unknown,
): Record<string, string> | undefined {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return undefined;
	}
	const normalized = Object.fromEntries(
		Object.entries(metadata as Record<string, unknown>)
			.map(([key, value]) => {
				if (typeof value === "string") {
					return [key.trim(), value.trim()] as const;
				}
				if (typeof value === "number" || typeof value === "boolean") {
					return [key.trim(), String(value)] as const;
				}
				return null;
			})
			.filter((entry): entry is readonly [string, string] => Boolean(entry))
			.filter(([key, value]) => Boolean(key) && Boolean(value)),
	);
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function withDefaultMetadata(metadata: Record<string, string> | undefined) {
	if (metadata?.label) {
		return metadata;
	}
	return {
		...(metadata || {}),
		label: DEFAULT_LABEL,
	};
}

export async function readRuntimeConfigValue(input: RuntimeConfigReadInput) {
	const storeName = input.storeName?.trim() || DEFAULT_STORE;
	const configKey = input.configKey.trim();
	const metadata = withDefaultMetadata(
		normalizeRuntimeConfigMetadata(input.metadata),
	);
	const result = await getConfiguration(storeName, [configKey], metadata);
	const item = result[configKey];
	if (!item) {
		return null;
	}
	return {
		storeName,
		configKey,
		value: item.value,
		version: item.version,
		metadata: item.metadata,
	};
}

export async function writeRuntimeConfigValue(input: RuntimeConfigWriteInput) {
	const writerUrl = process.env.RUNTIME_CONFIG_WRITER_URL?.trim();
	if (!writerUrl) {
		throw new Error(
			"RUNTIME_CONFIG_WRITER_URL is not configured for runtime config writes",
		);
	}

	const storeName = input.storeName?.trim() || DEFAULT_STORE;
	const configKey = input.configKey.trim();
	const metadata = withDefaultMetadata(
		normalizeRuntimeConfigMetadata(input.metadata),
	);
	const token = process.env.RUNTIME_CONFIG_WRITER_TOKEN?.trim();
	const response = await fetch(writerUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({
			storeName,
			configKey,
			value: input.value,
			metadata,
		}),
	});

	const text = await response.text();
	let payload: Record<string, unknown> | undefined;
	if (text.trim()) {
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				payload = parsed as Record<string, unknown>;
			}
		} catch {
			payload = { raw: text };
		}
	}

	if (!response.ok) {
		throw new Error(
			`Runtime config writer failed (${response.status}): ${
				typeof payload?.error === "string"
					? payload.error
					: text || "request failed"
			}`,
		);
	}

	return {
		provider: "external-writer",
		response: payload,
		storeName,
		configKey,
	};
}

export function getRuntimeConfigDefaults() {
	return {
		storeName: DEFAULT_STORE,
		metadata: { label: DEFAULT_LABEL },
	};
}
