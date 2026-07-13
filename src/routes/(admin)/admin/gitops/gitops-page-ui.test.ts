import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeDir = dirname(fileURLToPath(import.meta.url));

describe("admin GitOps responsive navigation", () => {
	it("keeps every tab reachable and exposes linked keyboard-operable tab semantics", () => {
		const source = readFileSync(join(routeDir, "+page.svelte"), "utf8");

		expect(source).toContain('class="overflow-x-auto border-b px-5 py-2"');
		expect(source).toContain("onkeydown={handleTabListKey}");
		expect(source).toContain('tabindex="-1"');
		expect(source).toContain('aria-controls={tabPanelId("overview")}');
		expect(source).toContain('tabindex={tab === "overview" ? 0 : -1}');
		expect(source).toContain('role="tabpanel"');
		expect(source).toContain('aria-labelledby={tabButtonId("services")}');
	});

	it("bounds the mobile service list and keeps service detail in the page scroll", () => {
		const source = readFileSync(join(routeDir, "ServicesTab.svelte"), "utf8");

		expect(source).toContain("overflow-y-auto md:grid-cols-[20rem_1fr]");
		expect(source).toContain("h-64 overflow-hidden border-b");
		expect(source).toContain("md:min-h-0 md:overflow-y-auto");
	});
});
