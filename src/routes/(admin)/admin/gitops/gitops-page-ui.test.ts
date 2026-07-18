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

	it("offers the drift matrix as the default services layout with a detail escape hatch", () => {
		const source = readFileSync(join(routeDir, "ServicesTab.svelte"), "utf8");

		expect(source).toContain('$state<"matrix" | "detail">("matrix")');
		expect(source).toContain("FleetMatrixTable");
		expect(source).toContain("buildFleetServiceDrift");
		expect(source).toContain("onOpenDetail={openDetail}");
	});

	it("scrolls the fleet matrix inside its own container and expands rows to a lineage stepper", () => {
		const source = readFileSync(join(routeDir, "FleetMatrixTable.svelte"), "utf8");

		// Wide table scrolls in its own container; page body never scrolls sideways.
		expect(source).toContain('class="h-full overflow-auto"');
		expect(source).toContain("min-w-[58rem]");
		expect(source).toContain("aria-expanded={expanded}");
		expect(source).toContain("LineageStepper");
		expect(source).toContain("buildLineage(row, serviceDrift, visibleEnvs)");
		// Skeleton loading + in-flight build spinner.
		expect(source).toContain("Skeleton");
		expect(source).toContain("motion-safe:animate-spin");
	});

	it("wires the fleet-drift extras query, skew badge, platform pulse, and SSE invalidation into the page", () => {
		const source = readFileSync(join(routeDir, "+page.svelte"), "utf8");

		expect(source).toContain("getFleetDriftExtras()");
		expect(source).toContain("fleetExtrasQuery.refresh()");
		expect(source).toContain("Preview platform skew");
		expect(source).toContain("PreviewPlatformPanel");
		expect(source).toContain("PromotionPulse");
		// Invalidation stream only runs when OverviewTab (stream owner) is unmounted.
		expect(source).toContain('if (tab === "overview") return;');
		expect(source).toContain('new EventSource("/api/v1/gitops/events/stream")');
		expect(source).toContain("shouldRefreshGitOpsMetadata");
	});
});
