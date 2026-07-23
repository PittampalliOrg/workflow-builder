import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(routeDir, "+page.svelte"), "utf8");

describe("dashboard Preview Development Status panel", () => {
	it("renders a clearly labeled Preview Development Status section", () => {
		expect(source).toContain("Preview Development Status");
		expect(source).toContain('data-testid="preview-development-status"');
		expect(source).toContain("K3 Preview Acceptance");
	});

	it("summarizes preview lifecycle, live-sync/HMR, workflow activity, and PR capture", () => {
		expect(source).toContain("Lifecycle");
		expect(source).toContain("Live-sync / HMR");
		expect(source).toContain("Workflow activity");
		expect(source).toContain("PR capture");
		expect(source).toContain("previewLifecycle");
		expect(source).toContain("runningRunCount");
	});

	it("derives the panel only from data the dashboard already fetches", () => {
		// The panel must reuse the existing dashboard payload + runs feed —
		// no new API plumbing for preview status.
		expect(source).toContain("fetch('/api/v1/dashboard')");
		expect(source).toContain("fetch('/api/v1/runs?limit=5')");
		expect(source).not.toContain("/api/v1/preview");
		expect(source).not.toContain("/api/v1/environments/preview");
	});

	it("renders explicit graceful empty states when feeds are absent", () => {
		expect(source).toContain("runsLoaded");
		expect(source).toContain("No runs yet");
		expect(source).toContain("Workflow run feed not available");
		expect(source).toContain("No captures yet");
		expect(source).toContain("No active sessions yet");
	});

	it("stays responsive across narrow and wide layouts", () => {
		expect(source).toContain("grid-cols-2 lg:grid-cols-4");
	});
});
