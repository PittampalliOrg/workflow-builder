import { describe, expect, it } from "vitest";
import {
	booleanOrNull,
	dateOrNull,
	jsonParam,
	jsonValue,
	numberOrNull,
	stringOrNull,
} from "$lib/server/application/adapters/dapr-postgres-rows";

describe("Dapr PostgreSQL row helpers", () => {
	it("normalizes scalar nulls and primitive values", () => {
		expect(stringOrNull(null)).toBeNull();
		expect(stringOrNull(42)).toBe("42");
		expect(numberOrNull("12")).toBe(12);
		expect(numberOrNull("bad")).toBeNull();
		expect(booleanOrNull("t")).toBe(true);
		expect(booleanOrNull("0")).toBe(false);
		expect(booleanOrNull("unknown")).toBeNull();
	});

	it("normalizes timestamps and JSON payloads from binding rows", () => {
		expect(dateOrNull("2026-07-09T12:00:00.000Z")?.toISOString()).toBe(
			"2026-07-09T12:00:00.000Z",
		);
		expect(dateOrNull("bad")).toBeNull();
		expect(jsonValue('{"ok":true}', {})).toEqual({ ok: true });
		expect(jsonValue("not-json", { fallback: true })).toEqual({ fallback: true });
		expect(jsonParam({ ok: true })).toBe('{"ok":true}');
		expect(jsonParam(null)).toBeNull();
	});
});
