import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

function resolveChromiumExecutable(): string | undefined {
	const candidates = [
		process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
		"/etc/profiles/per-user/vpittamp/bin/google-chrome",
		"/etc/profiles/per-user/vpittamp/bin/google-chrome-stable",
		"/run/current-system/sw/bin/google-chrome",
		"/run/current-system/sw/bin/google-chrome-stable",
		"/etc/profiles/per-user/vpittamp/bin/chromium",
		"/run/current-system/sw/bin/chromium",
	];

	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

const chromiumExecutable = resolveChromiumExecutable();

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: "html",
	timeout: 60_000,
	use: {
		baseURL: "http://localhost:3000",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		navigationTimeout: 60_000,
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				launchOptions: chromiumExecutable
					? { executablePath: chromiumExecutable }
					: undefined,
			},
		},
	],
	webServer: {
		command: "pnpm dev",
		url: "http://localhost:3000",
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
