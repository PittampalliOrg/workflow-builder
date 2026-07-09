export type DaprPostgresRow = readonly unknown[];

export function stringOrNull(value: unknown): string | null {
	return value == null ? null : String(value);
}

export function stringValue(value: unknown, fallback = ""): string {
	return value == null ? fallback : String(value);
}

export function numberOrNull(value: unknown): number | null {
	if (value == null || value === "") return null;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function numberValue(value: unknown, fallback = 0): number {
	return numberOrNull(value) ?? fallback;
}

export function booleanOrNull(value: unknown): boolean | null {
	if (value == null || value === "") return null;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	const normalized = String(value).trim().toLowerCase();
	if (["true", "t", "1", "yes", "y", "on"].includes(normalized)) return true;
	if (["false", "f", "0", "no", "n", "off"].includes(normalized)) return false;
	return null;
}

export function dateOrNull(value: unknown): Date | null {
	if (value == null || value === "") return null;
	if (value instanceof Date) return value;
	const parsed = new Date(value as string | number);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function dateValue(value: unknown, fallback = new Date(0)): Date {
	return dateOrNull(value) ?? fallback;
}

export function isoTimestamp(value: unknown): string {
	return dateValue(value).toISOString();
}

export function jsonValue<T = unknown>(value: unknown, fallback: T): T {
	if (value == null || value === "") return fallback;
	if (typeof value === "string") {
		try {
			return JSON.parse(value) as T;
		} catch {
			return fallback;
		}
	}
	return value as T;
}

export function jsonParam(value: unknown): string | null {
	if (value == null) return null;
	return JSON.stringify(value);
}
