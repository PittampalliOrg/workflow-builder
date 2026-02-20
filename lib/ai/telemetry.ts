type TelemetryValue = string | number | boolean | null | undefined;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (!value) {
		return fallback;
	}
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "1" ||
		normalized === "true" ||
		normalized === "yes" ||
		normalized === "on"
	) {
		return true;
	}
	if (
		normalized === "0" ||
		normalized === "false" ||
		normalized === "no" ||
		normalized === "off"
	) {
		return false;
	}
	return fallback;
}

function resolveEnabled(defaultValue: boolean): boolean {
	const value =
		process.env.AI_SDK_EXPERIMENTAL_TELEMETRY ??
		process.env.AI_SDK_OPEN_TELEMETRY;
	return parseBoolean(value, defaultValue);
}

function normalizeMetadata(
	metadata: Record<string, TelemetryValue> | undefined,
): Record<string, string> | undefined {
	if (!metadata) {
		return undefined;
	}
	const entries = Object.entries(metadata)
		.map(([key, value]) => {
			if (!key.trim()) {
				return null;
			}
			if (value === undefined || value === null) {
				return null;
			}
			return [key.trim(), String(value)] as const;
		})
		.filter((entry): entry is readonly [string, string] => Boolean(entry));
	if (entries.length === 0) {
		return undefined;
	}
	return Object.fromEntries(entries);
}

export function aiSdkTelemetry(input: {
	functionId: string;
	metadata?: Record<string, TelemetryValue>;
	defaultEnabled?: boolean;
}): {
	experimental_telemetry?: {
		isEnabled: true;
		functionId: string;
		metadata?: Record<string, string>;
	};
} {
	const enabled = resolveEnabled(input.defaultEnabled ?? true);
	if (!enabled) {
		return {};
	}
	const metadata = normalizeMetadata(input.metadata);
	return {
		experimental_telemetry: {
			isEnabled: true,
			functionId: input.functionId,
			...(metadata ? { metadata } : {}),
		},
	};
}
