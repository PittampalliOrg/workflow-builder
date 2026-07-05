import { describe, expect, it } from "vitest";
import { detectAddedRouteFiles, DEV_SYNC_RESTART_SIGNAL_FILE } from "./added-routes";

describe("detectAddedRouteFiles", () => {
	const existing = new Set([
		"src/routes/+layout.svelte",
		"src/routes/api/health/+server.ts",
	]);
	const exists = (p: string) => existing.has(p);

	it("returns only route files that do not exist yet", () => {
		const entries = [
			"src/routes/+layout.svelte", // exists → not added
			"src/routes/pr-preview-marker/+server.ts", // NEW route → added
			"src/lib/server/foo.ts", // outside src/routes → ignored
			"src/routes/api/health/+server.ts", // exists → not added
		];
		expect(detectAddedRouteFiles(entries, exists)).toEqual([
			"src/routes/pr-preview-marker/+server.ts",
		]);
	});

	it("ignores directory members and normalizes leading ./", () => {
		const entries = [
			"src/routes/new-dir/", // dir member → ignored
			"./src/routes/new-dir/+page.svelte", // ./-prefixed file → added
		];
		expect(detectAddedRouteFiles(entries, exists)).toEqual([
			"src/routes/new-dir/+page.svelte",
		]);
	});

	it("dedupes repeated members and returns [] when nothing is new", () => {
		expect(
			detectAddedRouteFiles(
				[
					"src/routes/x/+server.ts",
					"src/routes/x/+server.ts",
					"src/routes/+layout.svelte",
				],
				exists,
			),
		).toEqual(["src/routes/x/+server.ts"]);
		expect(detectAddedRouteFiles(["src/routes/+layout.svelte"], exists)).toEqual([]);
		expect(detectAddedRouteFiles([], exists)).toEqual([]);
	});

	it("supports a custom routes prefix", () => {
		expect(
			detectAddedRouteFiles(["app/pages/new.py"], () => false, "app/pages/"),
		).toEqual(["app/pages/new.py"]);
	});

	it("exports the shared restart-signal filename (sidecar/plugin contract)", () => {
		expect(DEV_SYNC_RESTART_SIGNAL_FILE).toBe(".dev-sync-restart-request.json");
	});
});
