import { describe, expect, it, vi } from "vitest";
import {
	isValidPresetRef,
	resolveCompiledPromptStack,
} from "./prompt-presets";

const STATIC_REF = { id: "p_static", version: 1 };
const DYNAMIC_REF = { id: "p_dynamic", version: 2 };

function rowFor(
	promptId: string,
	version: number,
	systemText: string,
	extra: Array<{ role: string; content: string }> = [],
) {
	return {
		promptId,
		version,
		messages: [{ role: "system", content: systemText }, ...extra],
	};
}

describe("isValidPresetRef", () => {
	it("accepts a well-formed ref", () => {
		expect(isValidPresetRef({ id: "abc", version: 3 })).toBe(true);
	});
	it("rejects refs with bad shapes", () => {
		expect(isValidPresetRef(null)).toBe(false);
		expect(isValidPresetRef({})).toBe(false);
		expect(isValidPresetRef({ id: "abc" })).toBe(false);
		expect(isValidPresetRef({ id: "abc", version: 0 })).toBe(false);
		expect(isValidPresetRef({ id: "abc", version: -1 })).toBe(false);
		expect(isValidPresetRef({ id: "", version: 1 })).toBe(false);
		expect(isValidPresetRef({ id: "abc", version: "1" })).toBe(false);
	});
});

describe("resolveCompiledPromptStack", () => {
	it("returns empty arrays when no refs", () => {
		const out = resolveCompiledPromptStack([], [], []);
		expect(out).toEqual({ static: [], dynamic: [] });
	});

	it("resolves a static ref to its system content", () => {
		const rows = [rowFor("p_static", 1, "Static prefix prose.")];
		const out = resolveCompiledPromptStack([STATIC_REF], [], rows);
		expect(out).toEqual({ static: ["Static prefix prose."], dynamic: [] });
	});

	it("resolves a dynamic ref to its system content", () => {
		const rows = [rowFor("p_dynamic", 2, "Dynamic tail prose.")];
		const out = resolveCompiledPromptStack([], [DYNAMIC_REF], rows);
		expect(out).toEqual({ static: [], dynamic: ["Dynamic tail prose."] });
	});

	it("preserves binding order in static and dynamic arrays", () => {
		const rows = [
			rowFor("a", 1, "first"),
			rowFor("b", 1, "second"),
			rowFor("c", 1, "third"),
		];
		const refs = [
			{ id: "c", version: 1 },
			{ id: "a", version: 1 },
			{ id: "b", version: 1 },
		];
		const out = resolveCompiledPromptStack(refs, [], rows);
		expect(out.static).toEqual(["third", "first", "second"]);
	});

	it("ignores rows whose (id, version) tuple does not match a ref", () => {
		const rows = [
			rowFor("p_static", 1, "v1"),
			rowFor("p_static", 2, "v2"),
		];
		const out = resolveCompiledPromptStack([{ id: "p_static", version: 1 }], [], rows);
		expect(out.static).toEqual(["v1"]);
	});

	it("warn-logs missing refs and continues with the rest", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const rows = [rowFor("a", 1, "found")];
			const out = resolveCompiledPromptStack(
				[
					{ id: "a", version: 1 },
					{ id: "missing", version: 1 },
				],
				[],
				rows,
				"projectId=proj_test",
			);
			expect(out.static).toEqual(["found"]);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toContain("missing@1");
			expect(warn.mock.calls[0][0]).toContain("projectId=proj_test");
		} finally {
			warn.mockRestore();
		}
	});

	it("skips presets that have empty system content", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const rows = [
				{
					promptId: "p1",
					version: 1,
					messages: [{ role: "user", content: "no system block here" }],
				},
				{
					promptId: "p2",
					version: 1,
					messages: [{ role: "system", content: "   \n   " }],
				},
				rowFor("p3", 1, "real content"),
			];
			const out = resolveCompiledPromptStack(
				[
					{ id: "p1", version: 1 },
					{ id: "p2", version: 1 },
					{ id: "p3", version: 1 },
				],
				[],
				rows,
			);
			expect(out.static).toEqual(["real content"]);
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("handles non-array messages defensively", () => {
		const rows = [
			{ promptId: "weird", version: 1, messages: "not an array" },
			rowFor("ok", 1, "ok content"),
		];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const out = resolveCompiledPromptStack(
				[
					{ id: "weird", version: 1 },
					{ id: "ok", version: 1 },
				],
				[],
				rows,
			);
			expect(out.static).toEqual(["ok content"]);
		} finally {
			warn.mockRestore();
		}
	});

	it("can populate static and dynamic in a single call", () => {
		const rows = [
			rowFor("p_static", 1, "Static."),
			rowFor("p_dynamic", 2, "Dynamic."),
		];
		const out = resolveCompiledPromptStack([STATIC_REF], [DYNAMIC_REF], rows);
		expect(out).toEqual({ static: ["Static."], dynamic: ["Dynamic."] });
	});
});
