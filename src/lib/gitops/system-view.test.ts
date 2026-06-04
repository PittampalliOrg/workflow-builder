import { describe, expect, it } from "vitest";

import { parseSoakTimer } from "./system-view";

describe("parseSoakTimer", () => {
	it("parses the canonical 'soaking N of M' countdown", () => {
		expect(parseSoakTimer("soaking 4m of 10m")).toEqual({
			elapsed: "4m",
			total: "10m",
			label: "4m of 10m",
		});
	});

	it("parses the bare 'N of M' form and the slash form", () => {
		expect(parseSoakTimer("4m of 10m")?.label).toBe("4m of 10m");
		expect(parseSoakTimer("soaking 30s / 2m")).toEqual({
			elapsed: "30s",
			total: "2m",
			label: "30s of 2m",
		});
	});

	it("parses the completed 'soaked for M' form (elapsed == total)", () => {
		expect(parseSoakTimer("soaked for 10m")).toEqual({ elapsed: "10m", total: "10m", label: "10m" });
		expect(parseSoakTimer("soaked 1h")).toEqual({ elapsed: "1h", total: "1h", label: "1h" });
	});

	it("returns null for empty, missing, or non-countdown descriptions", () => {
		expect(parseSoakTimer(null)).toBeNull();
		expect(parseSoakTimer(undefined)).toBeNull();
		expect(parseSoakTimer("")).toBeNull();
		expect(parseSoakTimer("healthy")).toBeNull();
		expect(parseSoakTimer("waiting for approval")).toBeNull();
	});
});
