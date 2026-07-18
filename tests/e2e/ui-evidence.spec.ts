/**
 * Goal-CHECK screenshot evidence for the preview-dev UI phase (track U5).
 *
 * Boots against the lite profile (`pnpm dev:lite` + tests/e2e/support/sea-stub.mjs,
 * seeded via tests/e2e/support/seed-exec.ts) and captures, per theme
 * (light/dark), full-page 1440x900 screenshots of:
 *   1. the Dev hub populated with a realistic preview fleet (drift chips,
 *      retained TTL countdown, slept revert warning) — fixtures injected by
 *      intercepting the SvelteKit remote-function reads,
 *   2. the Dev hub Pull requests tab (PR-preview dedupe badge),
 *   3. the dev execution detail page (sync-generation timeline),
 *   4. the GitOps overview (broker-SKEW warning card + promotion pulse),
 *   5. the GitOps services tab (fleet matrix drift highlights).
 *
 * Remote-function wire format: GET /_app/remote/<hash>/<name>[?payload=...] →
 * `{ type: "result", result: devalue.stringify(data) }` (see
 * @sveltejs/kit src/runtime/client/remote-functions/query.svelte.js).
 * SSR inlines first results, so fixtures land on the surfaces' refresh ticks
 * (5s on the Dev hub, 15s fallback poll on GitOps) — the waits below key on
 * fixture-only text.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";

// devalue is a transitive dep (via @sveltejs/kit) under pnpm's strict layout —
// resolve it through kit's own dependency tree.
const require = createRequire(import.meta.url);
const devalue: { stringify: (value: unknown) => string } = require(
	require.resolve("devalue", {
		paths: [require.resolve("@sveltejs/kit/package.json")],
	}),
);

import {
	devEnvironmentDetail,
	devEnvironmentGroups,
	executionVersions,
	fleetDriftExtras,
	gitopsMetadata,
	gitopsPromotions,
	previewDriftOverview,
	prPreviews,
	sidecarStatus,
	vclusterPreviews,
} from "./support/ui-evidence-fixtures";

const SHOT_DIR = process.env.UI_SHOT_DIR ?? "/tmp/claude-1000/ui-shots";

// Playwright's downloaded chromium can't load system libs on NixOS; use the
// system Chrome when provided (UI_CHROME_PATH=/path/to/google-chrome-stable).
if (process.env.UI_CHROME_PATH) {
	test.use({ launchOptions: { executablePath: process.env.UI_CHROME_PATH } });
}
const EMAIL = "dev@workflow-builder.local";
const PASSWORD = "devpassword";
const SLUG = "lite-dev-workspace";
const EXECUTION_ID = "lite-dev-exec-evidence";

const REMOTE_FIXTURES: Record<string, () => unknown> = {
	getVclusterPreviews: () => vclusterPreviews,
	getPreviewDriftOverview: () => previewDriftOverview,
	getDevEnvironmentGroups: () => devEnvironmentGroups,
	getPrPreviews: () => prPreviews,
	getDevEnvironment: () => devEnvironmentDetail,
	getSidecarStatus: () => sidecarStatus,
	getFleetDriftExtras: () => fleetDriftExtras,
	getGitopsSnapshot: () => ({ metadata: gitopsMetadata, promotions: gitopsPromotions }),
};

async function interceptRemoteQueries(page: Page): Promise<void> {
	await page.route("**/_app/remote/**", async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const url = new URL(route.request().url());
		const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
		const fixture = REMOTE_FIXTURES[name];
		if (!fixture) return route.fallback();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ type: "result", result: devalue.stringify(fixture()) }),
		});
	});
}

async function interceptGitopsRest(page: Page): Promise<void> {
	await page.route("**/api/v1/gitops/deployment-metadata*", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gitopsMetadata) }),
	);
	await page.route("**/api/v1/gitops/promotions", (route) =>
		route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gitopsPromotions) }),
	);
}

async function interceptExecutionApis(page: Page): Promise<void> {
	await page.route(`**/api/workflows/executions/${EXECUTION_ID}/versions`, (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(executionVersions),
		});
	});
}

async function awaitTheme(page: Page, theme: "light" | "dark"): Promise<void> {
	await page.waitForFunction(
		(t) => document.documentElement.classList.contains(t),
		theme,
		{ timeout: 30_000 },
	);
}

async function settleAndShoot(page: Page, path: string): Promise<void> {
	await page.waitForTimeout(750);
	await page.screenshot({ path, fullPage: true });
}

/** The lite profile has no hub inventory stream — suppress the real
 * "inventory stale" sonner toast so it never overlaps fixture content. */
async function hideToasts(page: Page): Promise<void> {
	await page.addStyleTag({
		content: "[data-sonner-toaster]{display:none !important}",
	});
}

for (const theme of ["light", "dark"] as const) {
	test.describe(`ui evidence (${theme})`, () => {
		test.describe.configure({ mode: "serial" });

		test.beforeEach(async ({ context, baseURL }) => {
			mkdirSync(SHOT_DIR, { recursive: true });
			const res = await context.request.post("/api/v1/auth/sign-in", {
				data: { email: EMAIL, password: PASSWORD },
			});
			expect(res.ok(), `sign-in failed: ${res.status()}`).toBe(true);
			await context.addCookies([
				{ name: "theme", value: theme, url: baseURL ?? "http://localhost:3000" },
			]);
		});

		test.use({ viewport: { width: 1440, height: 900 } });

		test(`dev hub + pull requests (${theme})`, async ({ page }) => {
			test.setTimeout(240_000);
			await page.emulateMedia({ reducedMotion: "reduce" });
			await interceptRemoteQueries(page);
			await page.goto(`/workspaces/${SLUG}/dev`, { waitUntil: "domcontentloaded", timeout: 180_000 });
			await awaitTheme(page, theme);

			// Fixture fleet lands on the surface's refresh tick (≤5s after mount).
			await expect(page.getByText("pr-4381-preview-fix")).toBeVisible({ timeout: 30_000 });
			await expect(page.getByText("agent-goal-mspd", { exact: false }).first()).toBeVisible();
			await expect(page.getByText("demo-topology")).toBeVisible();
			// Slept-with-uncaptured-changes revert warning + drift chips.
			await expect(page.getByText(/uncaptured live-sync changes/i)).toBeVisible({ timeout: 15_000 });
			await hideToasts(page);
			await settleAndShoot(page, `${SHOT_DIR}/dev-${theme}.png`);

			// The preview list scrolls inside the page shell, so the retained
			// countdown + slept revert-warning cards sit below the fold — capture
			// the whole fleet list as an element shot.
			await page
				.locator("ul")
				.filter({ has: page.getByText("demo-topology") })
				.first()
				.screenshot({ path: `${SHOT_DIR}/dev-fleet-${theme}.png` });

			// Pull requests tab: PR-preview lane + receipt dedupe badge.
			await page.getByRole("tab", { name: /pull requests/i }).click();
			await expect(page.getByRole("link", { name: "PR #4381" })).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("preview exists for this code").first()).toBeVisible();
			await settleAndShoot(page, `${SHOT_DIR}/dev-pull-requests-${theme}.png`);
		});

		test(`dev execution detail — sync-generation timeline (${theme})`, async ({ page }) => {
			test.setTimeout(240_000);
			await page.emulateMedia({ reducedMotion: "reduce" });
			await interceptRemoteQueries(page);
			await interceptExecutionApis(page);
			// SSR of the detail page executes `getSidecarStatus` server-side, which
			// legitimately 404s for a pod-less pending environment. Enter via
			// CLIENT-side navigation instead so every remote query goes over HTTP
			// and is served by the fixture intercepts above.
			await page.goto(`/workspaces/${SLUG}/dev`, {
				waitUntil: "domcontentloaded",
				timeout: 180_000,
			});
			await awaitTheme(page, theme);
			await expect(page.getByText("pr-4381-preview-fix")).toBeVisible({ timeout: 30_000 });
			await page.evaluate((href) => {
				const a = document.createElement("a");
				a.href = href;
				document.body.appendChild(a);
				a.click();
			}, `/workspaces/${SLUG}/dev/${EXECUTION_ID}`);
			await page.waitForURL(`**/dev/${EXECUTION_ID}`, { timeout: 60_000 });

			// The checkpoints panel loads versions on mount; the timeline derives
			// from the same read. gen-… ids only exist in the fixture.
			await expect(page.getByText("gen-4d81c209", { exact: false }).first()).toBeVisible({
				timeout: 30_000,
			});
			await expect(page.getByText("gen-2b44f00c", { exact: false }).first()).toBeVisible();
			// Let the 5s tick swap in the ready environment fixture.
			await page.waitForTimeout(6_000);
			await hideToasts(page);
			const timeline = page.locator('section[aria-labelledby="sync-generations-heading"]');
			await timeline.scrollIntoViewIfNeeded();
			await settleAndShoot(page, `${SHOT_DIR}/dev-detail-${theme}.png`);
			await timeline.screenshot({ path: `${SHOT_DIR}/dev-detail-timeline-${theme}.png` });
		});

		test(`gitops overview + services (${theme})`, async ({ page }) => {
			test.setTimeout(300_000);
			await page.emulateMedia({ reducedMotion: "reduce" });
			await interceptRemoteQueries(page);
			await interceptGitopsRest(page);
			await page.goto("/admin/gitops?tab=overview", {
				waitUntil: "domcontentloaded",
				timeout: 180_000,
			});
			await awaitTheme(page, theme);

			// The extras fixture (broker SKEW) lands on the first client read; the
			// metadata + promotions fixtures land on the page's 15s fallback poll —
			// wait for the fixture stacks-main short SHA to replace the SSR value.
			await expect(page.getByText(/SKEW/).first()).toBeVisible({ timeout: 45_000 });
			await expect(page.getByText("7b33ab3a").first()).toBeVisible({ timeout: 45_000 });
			await hideToasts(page);
			await settleAndShoot(page, `${SHOT_DIR}/gitops-overview-${theme}.png`);

			// Services tab: fleet matrix with pin/main drift highlights.
			await page.getByRole("tab", { name: /services/i }).click();
			await expect(page.getByText("function-router").first()).toBeVisible({ timeout: 30_000 });
			await expect(page.getByText("workflow-orchestrator").first()).toBeVisible();
			await settleAndShoot(page, `${SHOT_DIR}/gitops-services-${theme}.png`);
		});
	});
}
