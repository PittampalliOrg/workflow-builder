import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config. Defaults to the local dev server
 * (`pnpm dev` → http://localhost:3000) so the test loop works on any
 * engineer's box without extra setup. To hit a deployed environment,
 * export BASE_URL:
 *
 *     BASE_URL=https://workflow-builder.tail286401.ts.net pnpm test:e2e
 *
 * Scope: today only smoke-level unauth probes. Once there's a reliable
 * test-auth fixture (either API-key based or a seeded cookie), this can
 * grow into full user-facing E2E.
 */
export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 30_000,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: [["list"]],

	use: {
		baseURL: process.env.BASE_URL ?? "http://localhost:3000",
		trace: "on-first-retry",
		ignoreHTTPSErrors: true,
	},

	projects: [
		{
			name: "smoke",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
